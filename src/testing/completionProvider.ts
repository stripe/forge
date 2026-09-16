import type {
  CompletionProvider,
  CompletionProviderCallContext,
  CompletionProviderPreflightInput,
  CompletionProviderRequirementInput,
  CompletionProviderRequirements,
  CompletionRequest,
  CompletionResponse,
} from '../contracts/completion.js';

/** A concise response value accepted by the scripted provider. */
export type ScriptedCompletionValue = string | CompletionResponse;

/** One queued completion result, failure, or request-aware handler. */
export type ScriptedCompletionStep =
  | ScriptedCompletionValue
  | Error
  | ScriptedCompletionHandler;

export type ScriptedCompletionHandler = (
  request: CompletionRequest,
  context: CompletionProviderCallContext,
) => ScriptedCompletionValue | Promise<ScriptedCompletionValue>;

export type ScriptedCompletionRequirementsHandler = (
  input: CompletionProviderRequirementInput,
) => CompletionProviderRequirements;

export type ScriptedCompletionPreflightHandler = (
  input: CompletionProviderPreflightInput,
) => void | Promise<void>;

export interface RecordedCompletionCall {
  readonly request: CompletionRequest;
  readonly context: CompletionProviderCallContext;
}

export interface ScriptedCompletionProviderOptions {
  readonly id?: string;
  readonly version?: string;
  readonly responses?: readonly ScriptedCompletionStep[];
  readonly requirements?:
    | CompletionProviderRequirements
    | ScriptedCompletionRequirementsHandler;
  /** When omitted, the fake provider has no preflight hook. */
  readonly preflight?: ScriptedCompletionPreflightHandler;
}

export interface ScriptedCompletionProviderFixture {
  readonly provider: CompletionProvider;
  readonly requirementCalls: readonly CompletionProviderRequirementInput[];
  readonly preflightCalls: readonly CompletionProviderPreflightInput[];
  readonly calls: readonly RecordedCompletionCall[];
  readonly events: readonly string[];
  readonly remainingResponses: number;
}

/**
 * Deterministic completion-provider double. Each call consumes exactly one
 * queued response; strings become successful zero-usage responses.
 */
export function createScriptedCompletionProvider(
  options: ScriptedCompletionProviderOptions = {},
): ScriptedCompletionProviderFixture {
  const id = options.id ?? 'test-provider';
  const version = options.version ?? '1';
  const responses = [...(options.responses ?? [])];
  const requirements = options.requirements ?? {credentials: {}};
  const requirementCalls: CompletionProviderRequirementInput[] = [];
  const preflightCalls: CompletionProviderPreflightInput[] = [];
  const calls: RecordedCompletionCall[] = [];
  const events: string[] = [];
  let nextResponse = 0;

  const provider: CompletionProvider = {
    id,
    version,
    requirements(input) {
      const recorded = copyRequirementInput(input);
      requirementCalls.push(recorded);
      events.push(`requirements:${input.purpose}`);
      const resolved =
        typeof requirements === 'function'
          ? requirements(recorded)
          : requirements;
      return copyRequirements(resolved);
    },
    async complete(request, context) {
      request.signal.throwIfAborted();
      const recorded = Object.freeze({
        request: copyRequest(request),
        context: copyCallContext(context),
      });
      calls.push(recorded);
      events.push(`complete:${request.purpose}`);
      const step = responses[nextResponse];
      if (step === undefined) {
        throw new Error('Scripted completion provider has no remaining response.');
      }
      nextResponse += 1;
      if (step instanceof Error) throw step;
      const value =
        typeof step === 'function'
          ? await step(recorded.request, recorded.context)
          : step;
      request.signal.throwIfAborted();
      return copyResponse(normalizeResponse(value));
    },
  };

  if (options.preflight !== undefined) {
    const preflight = options.preflight;
    provider.preflight = async (input) => {
      input.signal.throwIfAborted();
      const recorded = copyPreflightInput(input);
      preflightCalls.push(recorded);
      events.push(`preflight:${input.purpose}`);
      await preflight(recorded);
      input.signal.throwIfAborted();
    };
  }

  return Object.freeze({
    provider: Object.freeze(provider),
    requirementCalls,
    preflightCalls,
    calls,
    events,
    get remainingResponses() {
      return responses.length - nextResponse;
    },
  });
}

function normalizeResponse(value: ScriptedCompletionValue): CompletionResponse {
  return typeof value === 'string'
    ? {
        content: value,
        stopReason: 'end_turn',
        usage: {inputTokens: 0, outputTokens: 0, cachedInputTokens: 0},
      }
    : value;
}

function copyRequirementInput(
  input: CompletionProviderRequirementInput,
): CompletionProviderRequirementInput {
  return Object.freeze({model: Object.freeze({...input.model}), purpose: input.purpose});
}

function copyRequirements(
  input: CompletionProviderRequirements,
): CompletionProviderRequirements {
  return Object.freeze({
    credentials: Object.freeze(
      Object.fromEntries(
        Object.entries(input.credentials).map(([name, requirement]) => [
          name,
          Object.freeze({...requirement}),
        ]),
      ),
    ),
  });
}

function copyPreflightInput(
  input: CompletionProviderPreflightInput,
): CompletionProviderPreflightInput {
  return Object.freeze({
    runId: input.runId,
    model: Object.freeze({...input.model}),
    purpose: input.purpose,
    credentials: Object.freeze({...input.credentials}),
    signal: input.signal,
  });
}

function copyCallContext(
  context: CompletionProviderCallContext,
): CompletionProviderCallContext {
  return Object.freeze({credentials: Object.freeze({...context.credentials})});
}

function copyRequest(request: CompletionRequest): CompletionRequest {
  return Object.freeze({
    runId: request.runId,
    purpose: request.purpose,
    model: Object.freeze({...request.model}),
    ...(request.systemPrompt === undefined
      ? {}
      : {systemPrompt: request.systemPrompt}),
    messages: Object.freeze(
      request.messages.map((message) => Object.freeze({...message})),
    ),
    ...(request.temperature === undefined
      ? {}
      : {temperature: request.temperature}),
    ...(request.maxTokens === undefined ? {} : {maxTokens: request.maxTokens}),
    ...(request.responseSchema === undefined
      ? {}
      : {
          responseSchema: Object.freeze({
            ...request.responseSchema,
            schema: Object.freeze(structuredClone(request.responseSchema.schema)),
          }),
        }),
    signal: request.signal,
  });
}

function copyResponse(response: CompletionResponse): CompletionResponse {
  return Object.freeze({
    content: response.content,
    stopReason: response.stopReason,
    usage: Object.freeze({...response.usage}),
    ...(response.costUsd === undefined ? {} : {costUsd: response.costUsd}),
  });
}
