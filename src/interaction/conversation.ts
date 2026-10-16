import type { AgentSession, AgentToolCall } from '../contracts/agent.ts';
import type { AvaError, AvaNeed, AvaRolePlayer, AvaTurn } from './ava.ts';

export interface ConversationTurn {
  readonly turn: number;
  readonly user: string;
  readonly assistant: string;
  readonly toolCalls: readonly AgentToolCall[];
}

export interface AvaDecisionAudit {
  readonly sequence: number;
  /** Null for Ava's opening decision; otherwise the response just assessed. */
  readonly afterAgentTurn: number | null;
  readonly message: string;
  readonly stop: boolean;
  /** Null until a configured opening is followed by a generated decision. */
  readonly remainingNeedIds: readonly string[] | null;
  readonly focusNeedId: string | null;
  readonly codingAgentInvoked: boolean;
  readonly source: AvaTurn['source'];
  readonly error?: AvaError;
}

export interface AvaConversationAudit {
  /** Null only if a configured stop opening ended before Ava initialized. */
  readonly needs: readonly AvaNeed[] | null;
  readonly decisions: readonly AvaDecisionAudit[];
}

export type ConversationStopReason =
  | 'task_complete'
  | 'max_turns'
  | 'role_player_error';

export interface ConversationResult {
  readonly turns: readonly ConversationTurn[];
  readonly stopReason: ConversationStopReason;
  readonly avaAudit: AvaConversationAudit;
  /** Null when any completed agent turn omitted cost information. */
  readonly totalCostUsd: number | null;
  readonly failure: AvaError | null;
}

export interface RunConversationOptions {
  /** One persistent session used for every coding-agent turn. */
  readonly session: AgentSession;
  /** Concrete engine-owned Ava implementation, not a composition extension. */
  readonly ava: AvaRolePlayer;
  readonly maxTurns: number;
  readonly signal: AbortSignal;
  readonly onTurn?: (turn: number, avaMessage: string) => void;
  readonly onAvaStart?: (turn: number) => void;
  readonly onAvaResponse?: (turn: number) => void;
  readonly onResponse?: (turn: number, response: string) => void;
  readonly validateCompletedTurns?: (
    completedTurns: readonly ConversationTurn[],
  ) => void;
}

/** Run the engine-owned Ava/agent loop through one persistent agent session. */
export async function runConversation(
  options: RunConversationOptions,
): Promise<ConversationResult> {
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new TypeError('maxTurns must be a positive integer.');
  }

  const turns: ConversationTurn[] = [];
  const decisions: AvaDecisionAudit[] = [];
  let needs: readonly AvaNeed[] | null = null;
  let stopReason: ConversationStopReason = 'max_turns';
  let totalCostUsd: number | null = 0;
  let lastResponse: string | undefined;
  let complete = false;

  while (!complete) {
    options.signal.throwIfAborted();
    const avaTurnNumber = turns.length + 1;
    options.onAvaStart?.(avaTurnNumber);
    const avaTurn = await options.ava.nextTurn(lastResponse);
    options.signal.throwIfAborted();
    options.onAvaResponse?.(avaTurnNumber);
    if (avaTurn.needs !== null) needs = snapshotNeeds(avaTurn.needs);

    if (avaTurn.error) {
      if (avaTurn.message !== '' || !avaTurn.stop) {
        throw new Error(
          'A role-player error decision must stop with an empty message.',
        );
      }
      decisions.push(
        decisionAudit(avaTurn, decisions.length + 1, turns.length, false),
      );
      stopReason = 'role_player_error';
      complete = true;
    } else if (avaTurn.source === 'generated' && avaTurn.stop) {
      if (avaTurn.message !== '' || (avaTurn.remainingNeeds?.length ?? 0) > 0) {
        throw new Error(
          'Generated Ava terminal decisions require an empty message and no remaining needs.',
        );
      }
      decisions.push(
        decisionAudit(avaTurn, decisions.length + 1, turns.length, false),
      );
      stopReason = 'task_complete';
      complete = true;
    } else if (turns.length >= options.maxTurns) {
      // Ava assesses the final allowed response, but a follow-up which cannot
      // be sent is not retained as a public conversation message.
      decisions.push(
        Object.freeze({
          ...decisionAudit(avaTurn, decisions.length + 1, turns.length, false),
          message: '',
          focusNeedId: null,
        }),
      );
      stopReason = 'max_turns';
      complete = true;
    } else {
      const turnNumber = turns.length + 1;
      decisions.push(
        decisionAudit(avaTurn, decisions.length + 1, turns.length, true),
      );
      options.onTurn?.(turnNumber, avaTurn.message);

      options.signal.throwIfAborted();
      const response = await options.session.send(avaTurn.message, {
        signal: options.signal,
      });
      options.signal.throwIfAborted();
      if (response.costUsd === undefined) {
        totalCostUsd = null;
      } else if (totalCostUsd !== null) {
        const updatedCost: number = totalCostUsd + response.costUsd;
        if (!Number.isFinite(updatedCost) || updatedCost < 0) {
          throw new TypeError('Agent turn costs produced an invalid total.');
        }
        totalCostUsd = updatedCost;
      }
      options.onResponse?.(turnNumber, response.text);

      const toolCalls = snapshotAgentToolCalls(response.toolCalls);
      const completedTurn = Object.freeze({
        turn: turnNumber,
        user: avaTurn.message,
        assistant: response.text,
        toolCalls,
      });
      turns.push(completedTurn);
      options.validateCompletedTurns?.(Object.freeze([...turns]));
      lastResponse = response.text;

      // A configured sentinel stops after its one deliberate agent invocation.
      if (avaTurn.source === 'configured_initial_prompt' && avaTurn.stop) {
        stopReason = 'task_complete';
        complete = true;
      }
    }
  }

  const frozenNeeds = needs === null ? null : snapshotNeeds(needs);
  return Object.freeze({
    turns: Object.freeze([...turns]),
    stopReason,
    avaAudit: Object.freeze({
      needs: frozenNeeds,
      decisions: Object.freeze([...decisions]),
    }),
    totalCostUsd,
    failure:
      stopReason === 'role_player_error'
        ? (decisions.at(-1)?.error ?? null)
        : null,
  });
}

function decisionAudit(
  turn: AvaTurn,
  sequence: number,
  completedAgentTurns: number,
  codingAgentInvoked: boolean,
): AvaDecisionAudit {
  return Object.freeze({
    sequence,
    afterAgentTurn: completedAgentTurns === 0 ? null : completedAgentTurns,
    message: turn.message,
    stop: turn.stop,
    remainingNeedIds:
      turn.remainingNeeds === null
        ? null
        : Object.freeze(turn.remainingNeeds.map(({ id }) => id)),
    focusNeedId: turn.focusNeedId,
    codingAgentInvoked,
    source: turn.source,
    ...(turn.error === undefined
      ? {}
      : { error: Object.freeze({ ...turn.error }) }),
  });
}

function snapshotNeeds(needs: readonly AvaNeed[]): readonly AvaNeed[] {
  return Object.freeze(
    needs.map(({ id, description }) => Object.freeze({ id, description })),
  );
}

/** @internal Snapshot untrusted adapter output at the interaction boundary. */
export function snapshotAgentToolCalls(
  toolCalls: readonly AgentToolCall[],
): readonly AgentToolCall[] {
  if (!Array.isArray(toolCalls)) {
    throw new TypeError('Agent turn toolCalls must be an array.');
  }
  return Object.freeze(
    toolCalls.map((call) =>
      Object.freeze({
        ...(call.id === undefined ? {} : { id: call.id }),
        name: call.name,
        ...(call.input === undefined
          ? {}
          : { input: snapshotToolInput(call.input) }),
      }),
    ),
  );
}

function snapshotToolInput(input: unknown): unknown {
  const cloned = structuredClone(input);
  return deepFreeze(cloned, new WeakSet<object>());
}

function deepFreeze(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
