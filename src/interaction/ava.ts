import { z } from 'zod';
import type { StrictCompletionResponseSchema } from '../contracts/completion.ts';
import { boundedErrorMessage } from '../security/errorMessage.ts';
import type {
  InteractionCompletionInvoker,
  InteractionHistoryMessage,
} from './completion.ts';
import {
  AVA_STOP_SENTINEL,
  type AvaPromptInputs,
  buildAvaContinuationPrompt,
  buildAvaInitializationPrompt,
} from './prompt.ts';

export const MAX_AVA_ATTEMPTS = 3;
export const MAX_AVA_NEEDS = 6;
export const MAX_AVA_NEED_DESCRIPTION_CHARACTERS = 240;
export const MAX_AVA_MESSAGE_CHARACTERS = 500;

const AVA_RETRY_DELAYS_MS = [1_000, 5_000] as const;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

export interface AvaRolePlayerOptions extends AvaPromptInputs {
  /** Configured opening sent verbatim before Ava initializes private state. */
  readonly initialPrompt?: string;
  readonly signal?: AbortSignal;
}

export interface AvaRolePlayerExecutionOptions {
  /** Credentials to redact from custom invoker request-error diagnostics. */
  readonly redactionSecrets?: readonly string[];
  /** Test seam for the otherwise fixed one- and five-second retry delays. */
  readonly waitBeforeRetry?: (
    failedAttempt: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface AvaNeed {
  readonly id: string;
  readonly description: string;
}

export interface AvaError {
  readonly status: 'role_player_error';
  readonly errorType: 'parse_error' | 'request_error';
  readonly attempts: number;
  readonly explanation: string;
  /** Final rejection reason; never includes the rejected response. */
  readonly message?: string;
}

export interface AvaTurn {
  readonly message: string;
  readonly stop: boolean;
  /** Null only while a configured opening has not initialized Ava. */
  readonly remainingNeeds: readonly AvaNeed[] | null;
  /** Ava's complete private task model; never forward it to the agent. */
  readonly needs: readonly AvaNeed[] | null;
  readonly focusNeedId: string | null;
  readonly source: 'configured_initial_prompt' | 'generated';
  readonly error?: AvaError;
}

class AvaResponseError extends Error {}

const InitialNeedResponse = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .max(MAX_AVA_NEED_DESCRIPTION_CHARACTERS),
    status: z.enum(['remaining', 'satisfied']),
  })
  .strict();

const InitialAvaResponse = z
  .object({
    user_needs: z.array(InitialNeedResponse).min(1).max(MAX_AVA_NEEDS),
    message: z.string().max(MAX_AVA_MESSAGE_CHARACTERS),
  })
  .strict();

const INITIAL_AVA_RESPONSE_SCHEMA: StrictCompletionResponseSchema = {
  name: 'ava_initial_turn',
  description: "Ava's compact private task model and first generated message.",
  strict: true,
  schema: {
    type: 'object',
    properties: {
      user_needs: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_AVA_NEEDS,
        items: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_AVA_NEED_DESCRIPTION_CHARACTERS,
              pattern: '\\S',
            },
            status: {
              type: 'string',
              enum: ['remaining', 'satisfied'],
            },
          },
          required: ['description', 'status'],
          additionalProperties: false,
        },
      },
      message: { type: 'string', maxLength: MAX_AVA_MESSAGE_CHARACTERS },
    },
    required: ['user_needs', 'message'],
    additionalProperties: false,
  },
};

interface ContinuationAvaResponse {
  readonly remainingNeedIds: readonly string[];
  readonly focusNeedId: string | null;
  readonly message: string;
}

function continuationResponseFormat(
  remainingNeedIds: readonly string[],
): StrictCompletionResponseSchema {
  return {
    name: 'ava_turn',
    description: "Ava's updated private task state and next generated message.",
    strict: true,
    schema: {
      type: 'object',
      properties: {
        remaining_need_ids: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', enum: [...remainingNeedIds] },
        },
        message: { type: 'string', maxLength: MAX_AVA_MESSAGE_CHARACTERS },
      },
      required: ['remaining_need_ids', 'message'],
      additionalProperties: false,
    },
  };
}

function parseContinuationResponse(
  raw: string,
  currentRemainingNeedIds: readonly string[],
): ContinuationAvaResponse {
  const parsed = z
    .object({
      remaining_need_ids: z.array(z.string()),
      message: z.string().max(MAX_AVA_MESSAGE_CHARACTERS),
    })
    .strict()
    .parse(JSON.parse(raw));
  const allowed = new Set(currentRemainingNeedIds);
  const returned = new Set(parsed.remaining_need_ids);
  if (
    returned.size !== parsed.remaining_need_ids.length ||
    parsed.remaining_need_ids.some((id) => !allowed.has(id))
  ) {
    throw new AvaResponseError('Ava returned invalid remaining need IDs.');
  }
  if (returned.size === 0) {
    return { remainingNeedIds: [], focusNeedId: null, message: '' };
  }
  return {
    remainingNeedIds: parsed.remaining_need_ids,
    focusNeedId: parsed.remaining_need_ids[0]!,
    message: parsed.message,
  };
}

function assertUniqueNeedDescriptions(
  needs: readonly z.infer<typeof InitialNeedResponse>[],
): void {
  const normalized = needs.map(({ description }) => description.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new AvaResponseError('Ava returned duplicate private user needs.');
  }
}

function stripLeadingAcknowledgment(message: string): string {
  return message
    .replace(
      /^(?:got it|okay|ok|great|thanks|thank you|sounds good|that (?:makes sense|helps|works|covers\b))\b[^?]*[.!]\s+(?=\S)/i,
      '',
    )
    .trim();
}

function assertSafeGeneratedMessage(
  message: string,
  focusedNeedId: string,
  needs: readonly AvaNeed[],
): string {
  const trimmed = stripLeadingAcknowledgment(message);
  if (!trimmed)
    throw new AvaResponseError('Ava returned an empty nonterminal message.');
  if (/```/.test(trimmed)) {
    throw new AvaResponseError(
      'Ava returned implementation code in its message.',
    );
  }
  if (/^\s*(?:[-*]|\d+[.)])\s+/m.test(trimmed)) {
    throw new AvaResponseError(
      'Ava returned a list instead of one human-like message.',
    );
  }
  if (
    /\b(?:checklist|rubric|grading|remaining needs?|completion criteria|need_\d+)\b/i.test(
      trimmed,
    )
  ) {
    throw new AvaResponseError('Ava exposed private task-model terminology.');
  }
  const lowerMessage = trimmed.toLowerCase();
  for (const need of needs) {
    if (
      need.id !== focusedNeedId &&
      need.description.length >= 20 &&
      lowerMessage.includes(need.description.toLowerCase())
    ) {
      throw new AvaResponseError('Ava exposed a non-focused private need.');
    }
  }
  return trimmed;
}

/** Engine-owned Ava state machine. It has no provider or credential authority. */
export class AvaRolePlayer {
  readonly #completion: InteractionCompletionInvoker;
  readonly #executionOptions: AvaRolePlayerExecutionOptions;
  readonly #history: InteractionHistoryMessage[] = [];
  readonly #initialPrompt: string | undefined;
  readonly #promptInputs: AvaPromptInputs;
  readonly #signal: AbortSignal;
  #needs: readonly AvaNeed[] | undefined;
  #remainingNeedIds: readonly string[] | undefined;

  constructor(
    options: AvaRolePlayerOptions,
    completion: InteractionCompletionInvoker,
    executionOptions: AvaRolePlayerExecutionOptions = {},
  ) {
    this.#completion = completion;
    this.#executionOptions = executionOptions;
    this.#initialPrompt = options.initialPrompt;
    this.#promptInputs = {
      task: options.task,
      ...(options.context === undefined ? {} : { context: options.context }),
    };
    this.#signal = options.signal ?? NEVER_ABORTED_SIGNAL;
  }

  /** Produce Ava's next public message from the coding agent's prior response. */
  async nextTurn(lastAgentResponse?: string): Promise<AvaTurn> {
    const firstTurn =
      this.#history.length === 0 && lastAgentResponse === undefined;

    if (firstTurn && this.#initialPrompt !== undefined) {
      const stop = this.#initialPrompt.includes(AVA_STOP_SENTINEL);
      const message = this.#initialPrompt
        .split(AVA_STOP_SENTINEL)
        .join('')
        .trim();
      this.#history.push({ role: 'assistant', content: message });
      return {
        message,
        stop,
        remainingNeeds: null,
        needs: null,
        focusNeedId: null,
        source: 'configured_initial_prompt',
      };
    }

    if (lastAgentResponse !== undefined) {
      this.#history.push({
        role: 'user',
        content:
          lastAgentResponse.trim() ||
          '(the assistant returned an empty response)',
      });
    }

    const initializing = this.#needs === undefined;
    const remainingNeedIds = this.#remainingNeedIds ?? [];
    const systemPrompt = initializing
      ? buildAvaInitializationPrompt(this.#promptInputs)
      : buildAvaContinuationPrompt(this.#promptInputs, {
          needs: this.#needs!,
          remainingNeedIds,
        });
    const messages: InteractionHistoryMessage[] = [...this.#history];
    if (lastAgentResponse === undefined) {
      messages.push({
        role: 'user',
        content:
          'Start the conversation with one natural message about one high-level need.',
      });
    }

    const request = {
      systemPrompt,
      messages,
      temperature: 0.3,
      maxTokens: initializing ? 700 : 400,
      responseSchema: initializing
        ? INITIAL_AVA_RESPONSE_SCHEMA
        : continuationResponseFormat(remainingNeedIds),
      signal: this.#signal,
    } as const;
    const waitBeforeRetry =
      this.#executionOptions.waitBeforeRetry ?? waitBeforeAvaRetry;
    let finalError: AvaError | undefined;

    for (let attempt = 1; attempt <= MAX_AVA_ATTEMPTS; attempt += 1) {
      throwIfAborted(this.#signal);
      let raw: string | undefined;
      try {
        const response = await this.#completion(request);
        if (!response || typeof response.content !== 'string') {
          throw new TypeError('Completion returned invalid content.');
        }
        raw = response.content;
      } catch (error) {
        if (isAbort(error, this.#signal)) throw error;
        finalError = avaError(
          'request_error',
          attempt,
          boundedErrorMessage(
            error,
            'Ava completion request failed.',
            this.#executionOptions.redactionSecrets,
          ),
        );
      }

      if (raw !== undefined) {
        try {
          const turn = initializing
            ? this.#initializeFromResponse(raw, lastAgentResponse === undefined)
            : this.#continueFromResponse(raw);
          if (turn.message) {
            this.#history.push({ role: 'assistant', content: turn.message });
          }
          return turn;
        } catch (error) {
          if (isAbort(error, this.#signal)) throw error;
          finalError = avaError(
            'parse_error',
            attempt,
            responseRejectionMessage(error),
          );
        }
      }

      if (attempt < MAX_AVA_ATTEMPTS) {
        await waitBeforeRetry(attempt, this.#signal);
      }
    }

    return this.#errorTurn(finalError!);
  }

  #initializeFromResponse(raw: string, opening: boolean): AvaTurn {
    const parsed = InitialAvaResponse.parse(JSON.parse(raw));
    assertUniqueNeedDescriptions(parsed.user_needs);
    const needs = parsed.user_needs.map(({ description }, index) => ({
      id: `need_${index + 1}`,
      description,
    }));
    const remainingIndexes = parsed.user_needs.flatMap(({ status }, index) =>
      opening || status === 'remaining' ? [index] : [],
    );
    const remainingNeedIds = remainingIndexes.map((index) => needs[index]!.id);
    if (remainingNeedIds.length === 0) {
      this.#needs = needs;
      this.#remainingNeedIds = remainingNeedIds;
      return this.#terminalTurn();
    }
    const focusNeedId = needs[remainingIndexes[0]!]!.id;
    const turn: AvaTurn = {
      message: assertSafeGeneratedMessage(parsed.message, focusNeedId, needs),
      stop: false,
      remainingNeeds: remainingNeedIds.map(
        (id) => needs.find((need) => need.id === id)!,
      ),
      needs,
      focusNeedId,
      source: 'generated',
    };
    this.#needs = needs;
    this.#remainingNeedIds = remainingNeedIds;
    return turn;
  }

  #continueFromResponse(raw: string): AvaTurn {
    const parsed = parseContinuationResponse(raw, this.#remainingNeedIds!);
    if (parsed.remainingNeedIds.length === 0) {
      this.#remainingNeedIds = parsed.remainingNeedIds;
      return this.#terminalTurn();
    }
    const turn: AvaTurn = {
      message: assertSafeGeneratedMessage(
        parsed.message,
        parsed.focusNeedId!,
        this.#needs!,
      ),
      stop: false,
      remainingNeeds: this.#remainingNeeds(parsed.remainingNeedIds),
      needs: this.#needs!,
      focusNeedId: parsed.focusNeedId,
      source: 'generated',
    };
    this.#remainingNeedIds = parsed.remainingNeedIds;
    return turn;
  }

  #remainingNeeds(
    remainingNeedIds: readonly string[] = this.#remainingNeedIds!,
  ): readonly AvaNeed[] {
    const byId = new Map(this.#needs!.map((need) => [need.id, need]));
    return remainingNeedIds.map((id) => byId.get(id)!);
  }

  #terminalTurn(): AvaTurn {
    return {
      message: '',
      stop: true,
      remainingNeeds: [],
      needs: this.#needs!,
      focusNeedId: null,
      source: 'generated',
    };
  }

  #errorTurn(error: AvaError): AvaTurn {
    return {
      message: '',
      stop: true,
      remainingNeeds:
        this.#remainingNeedIds === undefined ? null : this.#remainingNeeds(),
      needs: this.#needs ?? null,
      focusNeedId: null,
      source: 'generated',
      error,
    };
  }
}

function avaError(
  errorType: AvaError['errorType'],
  attempts: number,
  message: string,
): AvaError {
  return {
    status: 'role_player_error',
    errorType,
    attempts,
    message,
    explanation:
      errorType === 'parse_error'
        ? `Ava returned invalid structured output after ${attempts} attempts.`
        : `Ava request failed after ${attempts} attempts.`,
  };
}

function responseRejectionMessage(error: unknown): string {
  if (error instanceof AvaResponseError) return error.message;
  if (error instanceof SyntaxError) return 'Ava response was not valid JSON.';
  if (error instanceof z.ZodError) {
    const issue = error.issues[0]!;
    // Fixed schema paths and issue categories only: no values, unknown keys,
    // validator messages, or raw rejected responses.
    const path = issue.path
      .map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`))
      .join('');
    return `Ava response did not match the required schema at response${path} (${issue.code}).`;
  }
  return 'Ava response could not be validated.';
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ABORT_ERR' || error.code === 'execution_aborted'))
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function waitBeforeAvaRetry(
  failedAttempt: number,
  signal: AbortSignal,
): Promise<void> {
  const delayMs = AVA_RETRY_DELAYS_MS[failedAttempt - 1];
  if (delayMs === undefined) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError'),
      );
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
