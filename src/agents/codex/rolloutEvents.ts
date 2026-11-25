import type { AtifAgentStep, AtifStep, JsonObject } from '../../atif/index.ts';
import type { AgentNativeEvidenceWarning } from '../../contracts/agent.ts';
import {
  assertEmptyMedia,
  IncompleteRolloutError,
  type ItemResponses,
  nonempty,
  object,
  type RecordValue,
  type RolloutRecord,
  string,
  validateCompletedItem,
  validateThreadSettings,
} from './evidence.ts';

/** The per-turn bookkeeping normalizeRecords owns and the event handlers advance. */
export interface TurnProgress {
  activeTurn: string | undefined;
  turnCwd: string | undefined;
  userInTurn: boolean;
  assistantInTurn: boolean;
  lastAssistantMessage: string | undefined;
  completeTurns: number;
}

/** What the `event_msg` handlers read or change while one rollout is normalized. */
export interface EventContext {
  readonly progress: TurnProgress;
  readonly sessionId: string;
  readonly model: string;
  readonly itemResponses: ItemResponses;
  readonly turns: Set<string>;
  readonly calls: Map<string, AtifAgentStep>;
  readonly completedCalls: Set<string>;
  readonly completedItems: Set<string>;
  readonly completedWebSearches: Set<string>;
  readonly warnings: AgentNativeEvidenceWarning[];
  readonly add: (
    step: Omit<AtifStep, 'step_id'>,
    record: RolloutRecord,
    index: number,
  ) => AtifStep;
}

/** The `event_msg` record being handled. */
export interface EventPosition {
  readonly record: RolloutRecord;
  readonly index: number;
}

type EventHandler = (
  payload: RecordValue,
  context: EventContext,
  at: EventPosition,
) => void;

/** Handle one `event_msg` record; an unknown type is incomplete evidence. */
export function handleEvent(
  payload: RecordValue,
  context: EventContext,
  at: EventPosition,
): void {
  const type = string(payload.type);
  const handler = Object.hasOwn(EVENT_HANDLERS, type)
    ? EVENT_HANDLERS[type]
    : undefined;
  if (!handler) throw new IncompleteRolloutError();
  handler(payload, context, at);
}

const EVENT_HANDLERS: Readonly<Record<string, EventHandler>> = {
  task_started: taskStarted,
  task_complete: taskComplete,
  user_message: userMessage,
  agent_message: agentMessage,
  item_completed: itemCompleted,
  thread_settings_applied: threadSettingsApplied,
  token_count: tokenCount,
  agent_reasoning: agentReasoning,
};

function taskStarted(
  payload: RecordValue,
  { progress, turns }: EventContext,
): void {
  if (progress.activeTurn !== undefined) throw new IncompleteRolloutError();
  progress.activeTurn = nonempty(payload.turn_id);
  if (turns.has(progress.activeTurn)) throw new IncompleteRolloutError();
  turns.add(progress.activeTurn);
  progress.turnCwd = undefined;
  progress.userInTurn = false;
  progress.assistantInTurn = false;
  progress.lastAssistantMessage = undefined;
}

function taskComplete(
  payload: RecordValue,
  { progress, calls, completedCalls }: EventContext,
): void {
  if (
    progress.activeTurn === undefined ||
    payload.turn_id !== progress.activeTurn ||
    !progress.userInTurn ||
    !progress.assistantInTurn ||
    completedCalls.size !== calls.size
  )
    throw new IncompleteRolloutError();
  if (
    payload.last_agent_message !== undefined &&
    payload.last_agent_message !== null
  ) {
    const finalMessage = string(payload.last_agent_message);
    if (finalMessage && finalMessage !== progress.lastAssistantMessage)
      throw new IncompleteRolloutError();
  }
  progress.completeTurns += 1;
  progress.activeTurn = undefined;
}

function userMessage(payload: RecordValue): void {
  string(payload.message);
  assertEmptyMedia(payload);
}

function agentMessage(
  payload: RecordValue,
  { progress, itemResponses }: EventContext,
): void {
  const message = string(payload.message);
  if (
    progress.activeTurn === undefined ||
    !progress.userInTurn ||
    !itemResponses.assistantTexts.get(progress.activeTurn)?.has(message)
  )
    throw new IncompleteRolloutError();
}

function itemCompleted(
  payload: RecordValue,
  context: EventContext,
  { record, index }: EventPosition,
): void {
  const { progress, calls, completedCalls, completedItems } = context;
  if (
    progress.activeTurn === undefined ||
    !progress.userInTurn ||
    payload.thread_id !== context.sessionId ||
    payload.turn_id !== progress.activeTurn
  )
    throw new IncompleteRolloutError();
  const itemId = nonempty(object(payload.item).id);
  if (completedItems.has(itemId)) throw new IncompleteRolloutError();
  completedItems.add(itemId);
  validateCompletedItem(
    payload,
    progress.activeTurn,
    context.itemResponses,
    progress.turnCwd,
  );
  const item = object(payload.item);
  if (item.type === 'WebSearch') {
    context.completedWebSearches.add(itemId);
    if (calls.has(itemId)) throw new IncompleteRolloutError();
    const step = context.add(
      {
        source: 'agent',
        model_name: context.model,
        message: '',
        tool_calls: [
          {
            tool_call_id: itemId,
            function_name: 'web_search',
            arguments: {
              query: string(item.query),
              action: item.action as JsonObject,
            },
          },
        ],
      },
      record,
      index,
    ) as AtifAgentStep;
    calls.set(itemId, step);
    completedCalls.add(itemId);
    progress.assistantInTurn = true;
  }
}

function threadSettingsApplied(
  payload: RecordValue,
  { progress, model }: EventContext,
): void {
  if (progress.activeTurn !== undefined) throw new IncompleteRolloutError();
  validateThreadSettings(payload, model);
}

function tokenCount(payload: RecordValue): void {
  if (payload.info !== null && payload.info !== undefined) object(payload.info);
}

function agentReasoning(
  payload: RecordValue,
  { warnings }: EventContext,
  { index }: EventPosition,
): void {
  string(payload.text);
  warnings.push({
    code: 'value_omitted',
    message:
      'A Codex reasoning event was retained only in the native artifact.',
    path: `line:${index + 1}`,
  });
}
