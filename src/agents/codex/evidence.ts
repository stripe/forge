import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  ATIF_SCHEMA_VERSION,
  type AtifAgentStep,
  type AtifStep,
  type AtifTrajectoryV1_8,
  isAtifTimestamp,
  type JsonObject,
  parseAtifTrajectory,
} from '../../atif/index.ts';
import type {
  AgentNativeArtifact,
  AgentNativeEvidenceResult,
  AgentNativeEvidenceWarning,
} from '../../contracts/agent.ts';
import type { ReadonlyWorkspace } from '../../contracts/runtime.ts';
import {
  CodexToolEvidenceError,
  codexToolSearchArguments,
  codexToolSearchOutput,
  normalizeCodexToolOutput,
  validateCodexMcpSnapshot,
} from './toolEvidence.ts';

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LINES = 100_000;
const MAX_ENTRIES = 10_000;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 64;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_TREE =
  /^sessions\/[0-9]{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12][0-9]|3[01])\/rollout-[0-9T:.-]+-([0-9a-f-]{36})\.jsonl$/;
const FORMAT = 'codex-rollout-jsonl';

type RecordValue = Record<string, unknown>;
interface RolloutRecord {
  readonly type: string;
  readonly timestamp?: unknown;
  readonly payload: RecordValue;
  readonly raw: string;
}

export interface LoadCodexEvidenceInput {
  /** The isolated CODEX_HOME, read only after runtime quiescence. */
  readonly home: ReadonlyWorkspace | undefined;
  readonly sessionId: string;
  readonly agentVersion: string;
  readonly model: string;
  /** Defaults to exec; embedding hosts may select primary terminal sessions. */
  readonly sessionSource?: 'exec' | 'cli';
  readonly signal: AbortSignal;
}

/** Retain only the exact root rollout, without altering even malformed later records. */
export async function loadCodexNativeArtifact(
  input: Pick<
    LoadCodexEvidenceInput,
    'home' | 'sessionId' | 'signal' | 'sessionSource'
  >,
): Promise<AgentNativeArtifact | undefined> {
  if (!input.home || !SESSION_ID.test(input.sessionId)) return undefined;
  input.signal.throwIfAborted();
  try {
    const bytes = await readExactRollout(
      input.home,
      input.sessionId,
      input.signal,
      input.sessionSource,
    );
    if (!bytes) return undefined;
    return {
      format: FORMAT,
      sessionId: input.sessionId,
      mediaType: 'application/x-ndjson',
      extension: 'jsonl',
      body: Uint8Array.from(bytes),
    };
  } catch {
    if (input.signal.aborted) input.signal.throwIfAborted();
    return undefined;
  }
}

/** Normalize a bounded exact-session candidate; the engine owns fallback selection. */
export async function loadCodexEvidence(
  input: LoadCodexEvidenceInput,
): Promise<AgentNativeEvidenceResult> {
  if (!input.home || !SESSION_ID.test(input.sessionId))
    return unavailable('source_unavailable');
  input.signal.throwIfAborted();
  try {
    const bytes = await readExactRollout(
      input.home,
      input.sessionId,
      input.signal,
      input.sessionSource,
    );
    if (!bytes) return unavailable('source_unavailable');
    const records = parseRecords(bytes, input.signal);
    const converted = normalizeRecords(records, input);
    return {
      kind: 'available',
      trajectory: parseAtifTrajectory(converted.trajectory),
      source: {
        kind: 'native_log',
        format: FORMAT,
        sessionId: input.sessionId,
      },
      warnings: converted.warnings,
    };
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    return unavailable(
      error instanceof IncompleteRolloutError ||
        error instanceof CodexToolEvidenceError
        ? 'source_incomplete'
        : 'source_invalid',
    );
  }
}

async function readExactRollout(
  home: ReadonlyWorkspace,
  sessionId: string,
  signal: AbortSignal,
  sessionSource: 'exec' | 'cli' = 'exec',
): Promise<Uint8Array | undefined> {
  signal.throwIfAborted();
  const root = await home.inspect('sessions');
  if (root.kind === 'absent') return undefined;
  if (root.kind !== 'directory')
    throw new Error('Codex sessions root is not a directory.');
  const entries = await home.listFiles({
    under: 'sessions',
    maxEntries: MAX_ENTRIES,
    signal,
  });
  signal.throwIfAborted();
  if (entries.length > MAX_ENTRIES) throw new IncompleteRolloutError();
  const candidates = entries.filter(
    (entry) => DATE_TREE.exec(entry.path)?.[1] === sessionId,
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1)
    throw new Error('Codex rollout identity is ambiguous.');
  const selected = candidates[0]!;
  if (selected.kind !== 'file')
    throw new Error('Codex rollout is not a regular file.');
  const segments = selected.path.split('/');
  for (let length = 1; length < segments.length; length += 1) {
    signal.throwIfAborted();
    if (
      (await home.inspect(segments.slice(0, length).join('/'))).kind !==
      'directory'
    ) {
      throw new Error('Codex rollout parent is not a directory.');
    }
  }
  const inspected = await home.inspect(selected.path);
  if (inspected.kind !== 'file')
    throw new Error('Codex rollout changed before reading.');
  if (inspected.size !== undefined && inspected.size > MAX_SESSION_BYTES)
    throw new IncompleteRolloutError();
  const bytes = await home.readFile(selected.path, {
    maxBytes: MAX_SESSION_BYTES,
  });
  signal.throwIfAborted();
  if (bytes.byteLength > MAX_SESSION_BYTES) throw new IncompleteRolloutError();
  const newline = bytes.indexOf(10);
  const firstBytes = newline < 0 ? bytes : bytes.subarray(0, newline);
  if (firstBytes.byteLength === 0 || firstBytes.byteLength > MAX_LINE_BYTES)
    throw new IncompleteRolloutError();
  const first = new TextDecoder('utf-8', { fatal: true }).decode(firstBytes);
  const metadata = parseRecord(first, { nodes: 0 });
  validateSessionMetadata(metadata, sessionId, sessionSource);
  return bytes;
}

function parseRecords(
  bytes: Uint8Array,
  signal: AbortSignal,
): readonly RolloutRecord[] {
  const lines = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .split('\n');
  if (lines.length > MAX_LINES) throw new IncompleteRolloutError();
  const budget = { nodes: 0 };
  const records: RolloutRecord[] = [];
  for (const line of lines) {
    signal.throwIfAborted();
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES)
      throw new IncompleteRolloutError();
    records.push(parseRecord(line, budget));
  }
  return records;
}

function parseRecord(line: string, budget: { nodes: number }): RolloutRecord {
  const value: unknown = JSON.parse(line);
  assertBoundedJson(value, budget);
  const record = object(value);
  assertKeys(record, ['type', 'payload', 'timestamp', 'ordinal']);
  if (
    record.ordinal !== undefined &&
    (!Number.isSafeInteger(record.ordinal) || (record.ordinal as number) < 0)
  )
    throw new IncompleteRolloutError();
  return {
    type: string(record.type),
    payload: object(record.payload),
    timestamp: record.timestamp,
    raw: line,
  };
}

function validateSessionMetadata(
  record: RolloutRecord,
  sessionId: string,
  sessionSource: 'exec' | 'cli' = 'exec',
): void {
  const payload = record.payload;
  if (
    record.type !== 'session_meta' ||
    payload.id !== sessionId ||
    payload.source !== sessionSource ||
    (payload.session_id !== undefined && payload.session_id !== sessionId) ||
    (payload.thread_source !== undefined && payload.thread_source !== 'user') ||
    (payload.parent_thread_id !== undefined &&
      payload.parent_thread_id !== null) ||
    (payload.forked_from_id !== undefined && payload.forked_from_id !== null)
  ) {
    throw new Error(
      'Codex rollout does not identify the exact primary session.',
    );
  }
}

interface NormalizedRollout {
  readonly trajectory: AtifTrajectoryV1_8;
  readonly warnings: AgentNativeEvidenceWarning[];
}

/** The record a handler is looking at, for step timestamps and warning paths. */
interface RecordPosition {
  readonly record: RolloutRecord;
  readonly index: number;
}

/** A turn from task_started until it completes. */
interface ActiveTurn {
  readonly id: string;
  cwd: string | undefined;
  hasUser: boolean;
  hasAssistant: boolean;
  lastAssistantMessage: string | undefined;
}

/** Everything the record handlers read and change while one rollout is normalized. */
interface NormalizationState {
  readonly input: LoadCodexEvidenceInput;
  readonly actualUsers: ReadonlySet<number>;
  readonly itemResponses: ItemResponses;
  readonly steps: AtifStep[];
  readonly warnings: AgentNativeEvidenceWarning[];
  readonly calls: Map<string, AtifAgentStep>;
  readonly completedCalls: Set<string>;
  readonly completedItems: Set<string>;
  readonly completedWebSearches: Set<string>;
  readonly turns: Set<string>;
  turn: ActiveTurn | undefined;
  completeTurns: number;
  worldState: RecordValue | undefined;
}

type RecordHandler = (
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
) => void;
type HandlerTable = Readonly<Record<string, RecordHandler>>;
type NewStep = Omit<AtifStep, 'step_id'>;

function normalizeRecords(
  records: readonly RolloutRecord[],
  input: LoadCodexEvidenceInput,
): NormalizedRollout {
  const first = records[0];
  if (!first) throw new Error('Codex rollout is empty.');
  validateSessionMetadata(first, input.sessionId, input.sessionSource);
  if (first.payload.cli_version !== input.agentVersion)
    throw new Error('Codex rollout version differs from the adapter pin.');
  const state = initialState(records, input);
  addBaseInstructions(first, state);
  for (const [index, record] of records.entries()) {
    input.signal.throwIfAborted();
    if (index === 0) continue;
    handlerFor(RECORD_HANDLERS, record.type)(record.payload, state, {
      record,
      index,
    });
  }
  assertRolloutComplete(state);
  return { trajectory: trajectory(state), warnings: state.warnings };
}

function initialState(
  records: readonly RolloutRecord[],
  input: LoadCodexEvidenceInput,
): NormalizationState {
  return {
    input,
    actualUsers: identifyUserMessages(records),
    itemResponses: indexItemResponses(records),
    steps: [],
    warnings: [],
    calls: new Map(),
    completedCalls: new Set(),
    completedItems: new Set(),
    completedWebSearches: new Set(),
    turns: new Set(),
    turn: undefined,
    completeTurns: 0,
    worldState: undefined,
  };
}

function addBaseInstructions(
  first: RolloutRecord,
  state: NormalizationState,
): void {
  const base = first.payload.base_instructions;
  if (base === undefined || base === null) return;
  const text = string(object(base).text);
  if (text)
    addStep(
      state,
      {
        source: 'system',
        message: text,
        extra: {
          native_record_type: 'session_meta',
          native_field: 'base_instructions',
        },
      },
      { record: first, index: 0 },
    );
}

/** Unknown types fail closed. Own keys only, so `constructor` never matches. */
function handlerFor(table: HandlerTable, type: string): RecordHandler {
  const handler = Object.hasOwn(table, type) ? table[type] : undefined;
  if (!handler) throw new IncompleteRolloutError();
  return handler;
}

const RECORD_HANDLERS: HandlerTable = {
  session_meta: rejectRepeatedSessionMetadata,
  compacted: rejectCompactedHistory,
  world_state: applyWorldState,
  turn_context: applyTurnContext,
  event_msg: (payload, state, at) =>
    handlerFor(EVENT_HANDLERS, string(payload.type))(payload, state, at),
  response_item: handleResponseItem,
};

function rejectRepeatedSessionMetadata(): void {
  throw new Error('Codex rollout repeats session metadata.');
}

function rejectCompactedHistory(): void {
  throw new IncompleteRolloutError();
}

function applyWorldState(
  payload: RecordValue,
  state: NormalizationState,
): void {
  if (state.turn === undefined || state.turn.hasUser)
    throw new IncompleteRolloutError();
  const snapshot = worldStateSnapshot(payload, state.worldState);
  validateWorldState(snapshot, state.input.model);
  state.worldState = snapshot;
}

function applyTurnContext(
  payload: RecordValue,
  state: NormalizationState,
): void {
  const turn = state.turn;
  if (
    turn === undefined ||
    payload.turn_id !== turn.id ||
    payload.model !== state.input.model
  )
    throw new Error('Codex turn context differs from the selected turn.');
  turn.cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
}

const EVENT_HANDLERS: HandlerTable = {
  task_started: startTurn,
  task_complete: completeTurn,
  user_message: checkUserMessage,
  agent_message: checkAgentMessage,
  item_completed: completeItem,
  thread_settings_applied: checkThreadSettings,
  token_count: checkTokenCount,
  agent_reasoning: omitAgentReasoning,
};

function startTurn(payload: RecordValue, state: NormalizationState): void {
  if (state.turn !== undefined) throw new IncompleteRolloutError();
  const id = nonempty(payload.turn_id);
  if (state.turns.has(id)) throw new IncompleteRolloutError();
  state.turns.add(id);
  state.turn = {
    id,
    cwd: undefined,
    hasUser: false,
    hasAssistant: false,
    lastAssistantMessage: undefined,
  };
}

function completeTurn(payload: RecordValue, state: NormalizationState): void {
  const turn = state.turn;
  if (
    turn === undefined ||
    payload.turn_id !== turn.id ||
    !turn.hasUser ||
    !turn.hasAssistant ||
    state.completedCalls.size !== state.calls.size
  )
    throw new IncompleteRolloutError();
  const finalMessage = lastAgentMessage(payload);
  if (finalMessage && finalMessage !== turn.lastAssistantMessage)
    throw new IncompleteRolloutError();
  state.completeTurns += 1;
  state.turn = undefined;
}

function lastAgentMessage(payload: RecordValue): string | undefined {
  return payload.last_agent_message === undefined ||
    payload.last_agent_message === null
    ? undefined
    : string(payload.last_agent_message);
}

function checkUserMessage(payload: RecordValue): void {
  string(payload.message);
  assertEmptyMedia(payload);
}

function checkAgentMessage(
  payload: RecordValue,
  state: NormalizationState,
): void {
  const message = string(payload.message);
  const turn = turnWithUser(state);
  if (!state.itemResponses.assistantTexts.get(turn.id)?.has(message))
    throw new IncompleteRolloutError();
}

function completeItem(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const turn = turnWithUser(state);
  if (
    payload.thread_id !== state.input.sessionId ||
    payload.turn_id !== turn.id
  )
    throw new IncompleteRolloutError();
  const item = object(payload.item);
  const itemId = nonempty(item.id);
  if (state.completedItems.has(itemId)) throw new IncompleteRolloutError();
  state.completedItems.add(itemId);
  validateCompletedItem(payload, turn.id, state.itemResponses, turn.cwd);
  if (item.type === 'WebSearch') addWebSearch(item, itemId, turn, state, at);
}

/** A completed web search has no separate output, so its call is complete at once. */
function addWebSearch(
  item: RecordValue,
  id: string,
  turn: ActiveTurn,
  state: NormalizationState,
  at: RecordPosition,
): void {
  state.completedWebSearches.add(id);
  if (state.calls.has(id)) throw new IncompleteRolloutError();
  const step = addStep(
    state,
    {
      source: 'agent',
      model_name: state.input.model,
      message: '',
      tool_calls: [
        {
          tool_call_id: id,
          function_name: 'web_search',
          arguments: {
            query: string(item.query),
            action: item.action as JsonObject,
          },
        },
      ],
    },
    at,
  ) as AtifAgentStep;
  state.calls.set(id, step);
  state.completedCalls.add(id);
  turn.hasAssistant = true;
}

function checkThreadSettings(
  payload: RecordValue,
  state: NormalizationState,
): void {
  if (state.turn !== undefined) throw new IncompleteRolloutError();
  validateThreadSettings(payload, state.input.model);
}

function checkTokenCount(payload: RecordValue): void {
  if (payload.info !== null && payload.info !== undefined) object(payload.info);
}

function omitAgentReasoning(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  string(payload.text);
  state.warnings.push({
    code: 'value_omitted',
    message:
      'A Codex reasoning event was retained only in the native artifact.',
    path: `line:${at.index + 1}`,
  });
}

function handleResponseItem(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const type = string(payload.type);
  validateResponseItem(payload, type, state.turn?.id);
  handlerFor(RESPONSE_HANDLERS, type)(payload, state, at);
}

const RESPONSE_HANDLERS: HandlerTable = {
  message: addMessage,
  function_call: addToolCall,
  custom_tool_call: addToolCall,
  tool_search_call: addToolCall,
  function_call_output: addToolOutput,
  custom_tool_call_output: addToolOutput,
  tool_search_output: addToolOutput,
  web_search_call: (_payload, state) => {
    turnWithUser(state);
  },
  reasoning: addReasoning,
};

function addMessage(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const role = string(payload.role);
  const text = messageContent(payload.content);
  const actualUser = state.actualUsers.has(at.index);
  if (
    role === 'system' ||
    role === 'developer' ||
    (role === 'user' && !actualUser && isInjectedContext(text))
  )
    addStep(
      state,
      {
        source: 'system',
        message: text,
        extra: { native_record_type: 'response_item', native_role: role },
      },
      at,
    );
  else if (role === 'user' && actualUser) addUserMessage(text, state, at);
  else if (role === 'assistant') addAssistantMessage(payload, text, state, at);
  else throw new IncompleteRolloutError();
}

function addUserMessage(
  text: string,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const turn = state.turn;
  if (turn === undefined || turn.hasUser) throw new IncompleteRolloutError();
  turn.hasUser = true;
  addStep(state, { source: 'user', message: text }, at);
}

function addAssistantMessage(
  payload: RecordValue,
  text: string,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const turn = turnWithUser(state);
  if (
    payload.phase !== undefined &&
    payload.phase !== 'commentary' &&
    payload.phase !== 'final_answer'
  )
    throw new IncompleteRolloutError();
  turn.hasAssistant = true;
  turn.lastAssistantMessage = text;
  addStep(
    state,
    { source: 'agent', message: text, model_name: state.input.model },
    at,
  );
}

function addToolCall(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const turn = turnWithUser(state);
  const type = string(payload.type);
  const id = nonempty(payload.call_id);
  if (state.calls.has(id)) throw new IncompleteRolloutError();
  const name =
    type === 'tool_search_call' ? 'tool_search' : nonempty(payload.name);
  const namespace =
    payload.namespace === undefined ? '' : string(payload.namespace);
  const arguments_ = toolArguments(payload, type);
  const mcp = state.itemResponses.mcpSnapshots.get(id)?.payload;
  const step = addStep(
    state,
    {
      source: 'agent',
      model_name: state.input.model,
      message: '',
      tool_calls: [
        {
          tool_call_id: id,
          function_name: toolFunctionName(name, namespace, mcp),
          arguments: arguments_,
        },
      ],
    },
    at,
  ) as AtifAgentStep;
  state.calls.set(id, step);
  turn.hasAssistant = true;
}

function toolArguments(payload: RecordValue, type: string): JsonObject {
  if (type === 'tool_search_call') return codexToolSearchArguments(payload);
  if (type === 'function_call') return functionArguments(payload.arguments);
  return { input: string(payload.input) };
}

/** MCP calls are named by their server, other namespaced calls by their namespace. */
function toolFunctionName(
  name: string,
  namespace: string,
  mcp: RecordValue | undefined,
): string {
  if (mcp && !namespace && name === mcp.tool)
    return `mcp__${string(mcp.server)}.${name}`;
  return namespace ? `${namespace}.${name}` : name;
}

function addToolOutput(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  const turn = turnWithUser(state);
  const type = string(payload.type);
  const id = nonempty(payload.call_id);
  const step = state.calls.get(id);
  if (!step || state.completedCalls.has(id)) throw new IncompleteRolloutError();
  const nativeCall = state.itemResponses.calls.get(id);
  if (
    !nativeCall ||
    nativeCall.turn !== turn.id ||
    type !== outputTypeFor(nativeCall.payload.type)
  )
    throw new IncompleteRolloutError();
  const isError = toolOutputError(payload, id, state);
  state.completedCalls.add(id);
  const content =
    type === 'tool_search_output'
      ? codexToolSearchOutput(payload)
      : normalizeCodexToolOutput(payload.output, state.warnings, at.index);
  if (state.itemResponses.truncatedTools.has(id))
    state.warnings.push({
      code: 'value_omitted',
      message:
        'Codex truncated this MCP result before showing it to the agent. The observed output is preserved; the full result remains only in the restricted native artifact.',
      path: `line:${at.index + 1}.output`,
    });
  step.observation = {
    results: [
      {
        source_call_id: id,
        content,
        ...(isError !== undefined ? { extra: { is_error: isError } } : {}),
      },
    ],
  };
}

function outputTypeFor(callType: unknown): string {
  return callType === 'tool_search_call'
    ? 'tool_search_output'
    : `${callType}_output`;
}

/** The output's own error flag, or the failure its completion snapshot reported; they must agree. */
function toolOutputError(
  payload: RecordValue,
  id: string,
  state: NormalizationState,
): boolean | undefined {
  const toolFailed = state.itemResponses.toolFailures.get(id);
  if (typeof payload.is_error !== 'boolean') return toolFailed;
  if (toolFailed !== undefined && payload.is_error !== toolFailed)
    throw new IncompleteRolloutError();
  return payload.is_error;
}

function addReasoning(
  payload: RecordValue,
  state: NormalizationState,
  at: RecordPosition,
): void {
  turnWithUser(state);
  const text = reasoningContent(payload);
  if (text)
    addStep(
      state,
      {
        source: 'agent',
        model_name: state.input.model,
        message: '',
        reasoning_content: text,
      },
      at,
    );
  if (
    payload.encrypted_content === undefined ||
    payload.encrypted_content === null
  )
    return;
  string(payload.encrypted_content);
  state.warnings.push({
    code: 'value_omitted',
    message:
      'Encrypted Codex reasoning was retained only in the native artifact.',
    path: `line:${at.index + 1}`,
  });
}

/** The active turn once its user message is in; anything earlier is out of order. */
function turnWithUser(state: NormalizationState): ActiveTurn {
  const turn = state.turn;
  if (turn === undefined || !turn.hasUser) throw new IncompleteRolloutError();
  return turn;
}

function addStep(
  state: NormalizationState,
  step: NewStep,
  at: RecordPosition,
): AtifStep {
  const value = {
    ...step,
    ...timestamp(at.record.timestamp, state.warnings, at.index),
    step_id: state.steps.length + 1,
  } as AtifStep;
  state.steps.push(value);
  return value;
}

function assertRolloutComplete(state: NormalizationState): void {
  if (
    state.turn !== undefined ||
    state.completeTurns === 0 ||
    state.completedCalls.size !== state.calls.size ||
    state.completedWebSearches.size !== state.itemResponses.webSearches.size
  )
    throw new IncompleteRolloutError();
}

function trajectory(state: NormalizationState): AtifTrajectoryV1_8 {
  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: state.input.sessionId,
    agent: {
      name: 'codex',
      version: state.input.agentVersion,
      model_name: state.input.model,
    },
    steps: state.steps,
  };
}

/** Match live user events to response items, excluding native startup context. */
function identifyUserMessages(
  records: readonly RolloutRecord[],
): ReadonlySet<number> {
  const selected = new Set<number>();
  let boundary = 0;
  for (const [index, record] of records.entries()) {
    if (record.type !== 'event_msg') continue;
    if (record.payload.type === 'task_started') boundary = index;
    let message: string;
    if (record.payload.type === 'user_message') {
      message = string(record.payload.message);
    } else if (
      record.payload.type === 'item_completed' &&
      object(record.payload.item).type === 'UserMessage'
    ) {
      message = completedMessage(object(record.payload.item), 'text');
    } else continue;
    let match: number | undefined;
    for (let candidate = index - 1; candidate > boundary; candidate -= 1) {
      const previous = records[candidate]!;
      if (
        previous.type === 'response_item' &&
        previous.payload.type === 'message' &&
        previous.payload.role === 'user' &&
        messageContent(previous.payload.content) === message
      ) {
        match = candidate;
        break;
      }
    }
    if (match === undefined || selected.has(match))
      throw new IncompleteRolloutError();
    selected.add(match);
    boundary = index;
  }
  return selected;
}

interface ItemResponse {
  readonly turn: string;
  readonly payload: RecordValue;
  readonly raw: string;
}
interface ItemResponses {
  readonly messages: ReadonlyMap<string, ItemResponse>;
  readonly assistantTexts: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reasoning: ReadonlyMap<string, ItemResponse>;
  readonly calls: ReadonlyMap<string, ItemResponse>;
  readonly outputs: ReadonlyMap<string, ItemResponse>;
  readonly toolFailures: ReadonlyMap<string, boolean>;
  readonly truncatedTools: ReadonlySet<string>;
  readonly mcpSnapshots: ReadonlyMap<string, ItemResponse>;
  readonly webSearches: ReadonlyMap<string, ItemResponse>;
}

/** Native completed-item events mirror response items, sometimes before them. */
function indexItemResponses(records: readonly RolloutRecord[]): ItemResponses {
  const messages = new Map<string, ItemResponse>();
  const assistantTexts = new Map<string, Set<string>>();
  const reasoning = new Map<string, ItemResponse>();
  const calls = new Map<string, ItemResponse>();
  const outputs = new Map<string, ItemResponse>();
  const toolFailures = new Map<string, boolean>();
  const truncatedTools = new Set<string>();
  const mcpSnapshots = new Map<string, ItemResponse>();
  const webSearches = new Map<string, ItemResponse>();
  let turn: string | undefined;
  for (const record of records) {
    const payload = record.payload;
    if (record.type === 'event_msg' && payload.type === 'task_started')
      turn = nonempty(payload.turn_id);
    if (record.type === 'event_msg' && payload.type === 'task_complete')
      turn = undefined;
    if (record.type === 'event_msg' && payload.type === 'item_completed') {
      const item = object(payload.item);
      if (item.type === 'CommandExecution' || item.type === 'FileChange') {
        if (item.status !== 'completed' && item.status !== 'failed')
          throw new IncompleteRolloutError();
        toolFailures.set(nonempty(item.id), item.status === 'failed');
      } else if (item.type === 'McpToolCall') {
        const id = nonempty(item.id);
        if (
          turn === undefined ||
          payload.turn_id !== turn ||
          mcpSnapshots.has(id)
        )
          throw new IncompleteRolloutError();
        mcpSnapshots.set(id, { turn, payload: item, raw: record.raw });
      }
    }
    if (record.type !== 'response_item' || turn === undefined) continue;
    if (payload.type === 'message' && payload.role === 'assistant') {
      let texts = assistantTexts.get(turn);
      if (!texts) {
        texts = new Set();
        assistantTexts.set(turn, texts);
      }
      texts.add(messageContent(payload.content));
    }
    const map =
      payload.type === 'message' && payload.role === 'assistant'
        ? messages
        : payload.type === 'reasoning'
          ? reasoning
          : payload.type === 'web_search_call'
            ? webSearches
            : payload.type === 'function_call' ||
                payload.type === 'custom_tool_call' ||
                payload.type === 'tool_search_call'
              ? calls
              : payload.type === 'function_call_output' ||
                  payload.type === 'custom_tool_call_output' ||
                  payload.type === 'tool_search_output'
                ? outputs
                : undefined;
    if (map === undefined) continue;
    const id =
      map === messages || map === reasoning || map === webSearches
        ? payload.id
        : payload.call_id;
    // Older native messages have no ID and are checked by their text mirror.
    if ((map === messages || map === reasoning) && id === undefined) continue;
    const key = nonempty(id);
    if (map.has(key)) throw new IncompleteRolloutError();
    map.set(key, { turn, payload, raw: record.raw });
  }
  // Require the reverse association too: an MCP-shaped invocation cannot skip
  // status/output validation by omitting its typed completion snapshot. An
  // explicit output error flag or another completion kind is not a substitute.
  // Check after indexing to allow either native record order, and inspect the
  // reserved prefix without splitting server names that can themselves use __.
  for (const [id, { payload }] of calls) {
    const namespacedMcp =
      typeof payload.namespace === 'string' &&
      payload.namespace.startsWith('mcp__');
    const qualifiedMcp =
      typeof payload.name === 'string' && payload.name.startsWith('mcp__');
    if ((namespacedMcp || qualifiedMcp) && !mcpSnapshots.has(id))
      throw new IncompleteRolloutError();
  }
  for (const [id, snapshot] of mcpSnapshots) {
    const call = calls.get(id);
    const output = outputs.get(id);
    if (call?.turn !== snapshot.turn || output?.turn !== snapshot.turn)
      throw new IncompleteRolloutError();
    const validation = validateCodexMcpSnapshot(
      snapshot.payload,
      call.payload,
      output.payload,
      snapshot.raw,
    );
    toolFailures.set(id, validation.isError);
    if (validation.truncated) truncatedTools.add(id);
  }
  return {
    messages,
    assistantTexts,
    reasoning,
    calls,
    outputs,
    toolFailures,
    truncatedTools,
    mcpSnapshots,
    webSearches,
  };
}

function validateResponseItem(
  payload: RecordValue,
  type: string,
  turn: string | undefined,
): void {
  const fields =
    type === 'web_search_call'
      ? ['status', 'action']
      : type === 'message'
        ? ['role', 'content', 'phase']
        : type === 'function_call'
          ? ['call_id', 'name', 'namespace', 'arguments']
          : type === 'custom_tool_call'
            ? ['call_id', 'name', 'namespace', 'input', 'status']
            : type === 'tool_search_call'
              ? ['call_id', 'arguments', 'status', 'execution']
              : type === 'tool_search_output'
                ? ['call_id', 'tools', 'status', 'execution']
                : type === 'function_call_output' ||
                    type === 'custom_tool_call_output'
                  ? ['call_id', 'output', 'is_error']
                  : type === 'reasoning'
                    ? ['summary', 'content', 'encrypted_content']
                    : undefined;
  if (!fields) throw new IncompleteRolloutError();
  assertKeys(payload, [
    'type',
    'id',
    'internal_chat_message_metadata_passthrough',
    ...fields,
  ]);
  if (payload.id !== undefined && payload.id !== null) nonempty(payload.id);
  if (payload.internal_chat_message_metadata_passthrough !== undefined) {
    const metadata = object(payload.internal_chat_message_metadata_passthrough);
    assertKeys(metadata, ['turn_id', 'create_time']);
    if (metadata.turn_id !== turn) throw new IncompleteRolloutError();
    if (
      metadata.create_time !== undefined &&
      (typeof metadata.create_time !== 'number' || metadata.create_time < 0)
    )
      throw new IncompleteRolloutError();
  }
  if (type === 'web_search_call') {
    nonempty(payload.id);
    if (payload.status !== 'completed') throw new IncompleteRolloutError();
    validateWebSearchAction(payload.action);
  }
  if (payload.is_error !== undefined) boolean(payload.is_error);
  if (
    type === 'custom_tool_call' &&
    payload.status !== undefined &&
    payload.status !== 'completed'
  )
    throw new IncompleteRolloutError();
}

function validateCompletedItem(
  payload: RecordValue,
  turn: string,
  responses: ItemResponses,
  cwd: string | undefined,
): void {
  assertKeys(payload, [
    'type',
    'thread_id',
    'turn_id',
    'item',
    'started_at_ms',
    'completed_at_ms',
  ]);
  for (const key of ['started_at_ms', 'completed_at_ms']) {
    if (
      typeof payload[key] !== 'number' ||
      !Number.isSafeInteger(payload[key]) ||
      payload[key] < 0
    )
      throw new IncompleteRolloutError();
  }
  const item = object(payload.item);
  const id = nonempty(item.id);
  if (item.type === 'UserMessage') {
    assertKeys(item, ['type', 'id', 'content']);
    completedMessage(item, 'text');
  } else if (item.type === 'AgentMessage') {
    assertKeys(item, ['type', 'id', 'content', 'phase']);
    const response = responses.messages.get(id);
    if (
      response?.turn !== turn ||
      completedMessage(item, 'Text') !==
        messageContent(response.payload.content)
    )
      throw new IncompleteRolloutError();
    if (
      item.phase !== undefined &&
      item.phase !== 'commentary' &&
      item.phase !== 'final_answer'
    )
      throw new IncompleteRolloutError();
    if (item.phase !== response.payload.phase)
      throw new IncompleteRolloutError();
  } else if (item.type === 'Reasoning') {
    assertKeys(item, ['type', 'id', 'summary_text', 'raw_content']);
    if (array(item.raw_content).length !== 0)
      throw new IncompleteRolloutError();
    const text = array(item.summary_text).map(string).join('\n');
    const response = responses.reasoning.get(id);
    if (response?.turn !== turn || reasoningContent(response.payload) !== text)
      throw new IncompleteRolloutError();
  } else if (item.type === 'WebSearch') {
    assertKeys(item, ['type', 'id', 'query', 'action']);
    string(item.query);
    validateWebSearchAction(item.action);
    const response = responses.webSearches.get(id);
    if (
      response?.turn !== turn ||
      !isDeepStrictEqual(item.action, response.payload.action)
    )
      throw new IncompleteRolloutError();
  } else if (item.type === 'ImageView') {
    assertKeys(item, ['type', 'id', 'path']);
    const recordedPath = nonempty(item.path);
    const path = recordedPath.startsWith('file:')
      ? fileURLToPath(recordedPath, { windows: false })
      : recordedPath;
    const call = responses.calls.get(id);
    const output = responses.outputs.get(id);
    if (
      call?.turn !== turn ||
      output === undefined ||
      call.payload.type !== 'function_call' ||
      call.payload.name !== 'view_image' ||
      (call.payload.namespace !== undefined && call.payload.namespace !== '') ||
      output.payload.type !== 'function_call_output'
    )
      throw new IncompleteRolloutError();
    const argumentPath = nonempty(
      functionArguments(call.payload.arguments).path,
    );
    const resolvedPath = posix.isAbsolute(argumentPath)
      ? posix.normalize(argumentPath)
      : cwd !== undefined && posix.isAbsolute(cwd)
        ? posix.resolve(cwd, argumentPath)
        : undefined;
    if (resolvedPath !== path) throw new IncompleteRolloutError();
  } else if (item.type === 'McpToolCall') {
    const snapshot = responses.mcpSnapshots.get(id);
    if (snapshot?.turn !== turn || snapshot.payload !== item)
      throw new IncompleteRolloutError();
  } else if (item.type === 'CommandExecution' || item.type === 'FileChange') {
    const call = responses.calls.get(id);
    const output = responses.outputs.get(id);
    if (call?.turn !== turn || output?.turn !== turn)
      throw new IncompleteRolloutError();
    if (item.status !== 'completed' && item.status !== 'failed')
      throw new IncompleteRolloutError();
    string(item.stdout);
    string(item.stderr);
    if (item.type === 'CommandExecution') {
      if (
        call.payload.type !== 'function_call' ||
        (call.payload.name !== 'exec_command' &&
          call.payload.name !== 'write_stdin') ||
        output.payload.type !== 'function_call_output'
      )
        throw new IncompleteRolloutError();
      assertKeys(item, [
        'type',
        'id',
        'process_id',
        'command',
        'cwd',
        'parsed_cmd',
        'source',
        'status',
        'stdout',
        'stderr',
        'aggregated_output',
        'exit_code',
        'duration',
        'formatted_output',
      ]);
      if (item.process_id !== null) string(item.process_id);
      array(item.command).forEach(string);
      string(item.cwd);
      string(item.source);
      string(item.aggregated_output);
      string(item.formatted_output);
      if (item.exit_code !== null && !Number.isSafeInteger(item.exit_code))
        throw new IncompleteRolloutError();
      const duration = object(item.duration);
      assertKeys(duration, ['secs', 'nanos']);
      if (
        !Number.isSafeInteger(duration.secs) ||
        !Number.isSafeInteger(duration.nanos)
      )
        throw new IncompleteRolloutError();
      for (const value of array(item.parsed_cmd)) {
        const parsed = object(value);
        const fields =
          parsed.type === 'unknown'
            ? []
            : parsed.type === 'list_files'
              ? ['path']
              : parsed.type === 'read'
                ? ['name', 'path']
                : parsed.type === 'search'
                  ? ['query', 'path']
                  : undefined;
        if (!fields) throw new IncompleteRolloutError();
        assertKeys(parsed, ['type', 'cmd', ...fields]);
        string(parsed.cmd);
        for (const field of fields)
          if (parsed[field] !== null) string(parsed[field]);
      }
    } else {
      if (
        call.payload.name !== 'apply_patch' ||
        call.payload.type !== 'custom_tool_call' ||
        output.payload.type !== 'custom_tool_call_output'
      )
        throw new IncompleteRolloutError();
      assertKeys(item, ['type', 'id', 'changes', 'status', 'stdout', 'stderr']);
      for (const change of Object.values(object(item.changes))) {
        const value = object(change);
        if (value.type === 'add' || value.type === 'delete') {
          assertKeys(value, ['type', 'content']);
          string(value.content);
        } else if (value.type === 'update') {
          assertKeys(value, ['type', 'unified_diff', 'move_path']);
          string(value.unified_diff);
          if (value.move_path !== null) string(value.move_path);
        } else throw new IncompleteRolloutError();
      }
    }
  } else {
    throw new IncompleteRolloutError();
  }
}

function validateWebSearchAction(value: unknown): void {
  const action = object(value);
  if (action.type === 'search') {
    assertKeys(action, ['type', 'query', 'queries']);
    if (action.query !== undefined) string(action.query);
    if (action.queries !== undefined) array(action.queries).forEach(string);
  } else if (action.type === 'open_page') {
    assertKeys(action, ['type', 'url']);
    if (action.url !== undefined) string(action.url);
  } else if (action.type === 'find_in_page') {
    assertKeys(action, ['type', 'url', 'pattern']);
    if (action.url !== undefined) string(action.url);
    if (action.pattern !== undefined) string(action.pattern);
  } else throw new IncompleteRolloutError();
}

function reasoningContent(payload: RecordValue): string {
  if (
    payload.content !== undefined &&
    payload.content !== null &&
    array(payload.content).length !== 0
  )
    throw new IncompleteRolloutError();
  const summary = payload.summary === undefined ? [] : array(payload.summary);
  return summary
    .map((part) => {
      const block = object(part);
      assertKeys(block, ['type', 'text']);
      if (block.type !== 'summary_text') throw new IncompleteRolloutError();
      return string(block.text);
    })
    .join('\n');
}

function completedMessage(
  item: RecordValue,
  textType: 'text' | 'Text',
): string {
  return array(item.content)
    .map((part) => {
      const block = object(part);
      assertKeys(
        block,
        textType === 'text'
          ? ['type', 'text', 'text_elements']
          : ['type', 'text'],
      );
      if (block.type !== textType) throw new IncompleteRolloutError();
      if (textType === 'text') assertEmptyMedia(block);
      return string(block.text);
    })
    .join('\n');
}

/** The pinned recorder uses full snapshots followed by RFC 7386 merge patches. */
/** The full world state after this record: a snapshot, or a patch on the previous one. */
function worldStateSnapshot(
  payload: RecordValue,
  previous: RecordValue | undefined,
): RecordValue {
  assertKeys(payload, ['full', 'state']);
  if (typeof payload.full !== 'boolean') throw new IncompleteRolloutError();
  if (payload.full) return object(payload.state);
  if (previous === undefined) throw new IncompleteRolloutError();
  return mergeWorldState(previous, object(payload.state));
}

function validateWorldState(state: RecordValue, model: string): void {
  assertBoundedJson(state, { nodes: 0 });
  assertKeys(state, [
    'agents_md',
    'apps_instructions',
    'collaboration_mode',
    'environments',
    'environments_instructions',
    'git_attribution',
    'host_skills',
    'model',
    'multi_agent_mode',
    'orchestrator_skills',
    'permissions',
    'personality',
    'plugins_instructions',
    'realtime',
    'skills',
  ]);
  if (state.model !== model) throw new IncompleteRolloutError();
  for (const key of [
    'apps_instructions',
    'environments_instructions',
    'git_attribution',
    'plugins_instructions',
  ]) {
    if (typeof state[key] !== 'boolean') throw new IncompleteRolloutError();
  }
  const agents = object(state.agents_md);
  if (Object.keys(agents).length)
    validateStringObject(agents, ['directory', 'text']);
  validateStringObject(object(state.collaboration_mode), [
    'mode',
    'model',
    'instructions',
  ]);
  const environments = object(state.environments);
  assertKeys(environments, [
    'environments',
    'current_date',
    'timezone',
    'filesystem',
  ]);
  for (const key of ['current_date', 'timezone', 'filesystem'])
    string(environments[key]);
  for (const environment of Object.values(object(environments.environments)))
    validateStringObject(object(environment), ['cwd', 'status', 'shell']);
  const hostSkills = object(state.host_skills);
  assertKeys(hostSkills, ['body', 'includeInstructions']);
  string(hostSkills.body);
  boolean(hostSkills.includeInstructions);
  assertKeys(object(state.multi_agent_mode), []);
  const orchestratorSkills = object(state.orchestrator_skills);
  assertKeys(orchestratorSkills, ['includeInstructions', 'enabled']);
  boolean(orchestratorSkills.includeInstructions);
  boolean(orchestratorSkills.enabled);
  const permissions = object(state.permissions);
  assertKeys(permissions, ['instructions', 'approved_command_prefixes']);
  string(permissions.instructions);
  if (array(permissions.approved_command_prefixes).length !== 0)
    throw new IncompleteRolloutError();
  validateStringObject(object(state.personality), ['model', 'personality']);
  const realtime = object(state.realtime);
  assertKeys(realtime, ['active']);
  if (realtime.active !== false) throw new IncompleteRolloutError();
  const skills = object(state.skills);
  assertKeys(skills, ['includeInstructions']);
  boolean(skills.includeInstructions);
}

function mergeWorldState(
  previous: RecordValue,
  patch: RecordValue,
): RecordValue {
  const result: RecordValue = Object.assign(Object.create(null), previous);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // Unknown deletions must not bypass validation of the resulting snapshot.
      if (!Object.hasOwn(previous, key)) throw new IncompleteRolloutError();
      delete result[key];
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const before = previous[key];
      result[key] = mergeWorldState(
        before !== null && typeof before === 'object' && !Array.isArray(before)
          ? object(before)
          : {},
        object(value),
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function validateThreadSettings(payload: RecordValue, model: string): void {
  assertKeys(payload, ['type', 'thread_settings']);
  const settings = object(payload.thread_settings);
  assertKeys(settings, [
    'model',
    'model_provider_id',
    'approval_policy',
    'approvals_reviewer',
    'permission_profile',
    'cwd',
    'personality',
    'collaboration_mode',
  ]);
  if (settings.model !== model) throw new IncompleteRolloutError();
  for (const key of [
    'model_provider_id',
    'approval_policy',
    'approvals_reviewer',
    'cwd',
    'personality',
  ])
    string(settings[key]);
  const permissions = object(settings.permission_profile);
  assertKeys(permissions, ['type']);
  if (permissions.type !== 'disabled') throw new IncompleteRolloutError();
  const mode = object(settings.collaboration_mode);
  assertKeys(mode, ['mode', 'settings']);
  string(mode.mode);
  const collaboration = object(mode.settings);
  assertKeys(collaboration, [
    'model',
    'reasoning_effort',
    'developer_instructions',
  ]);
  if (
    collaboration.model !== model ||
    collaboration.developer_instructions !== null
  )
    throw new IncompleteRolloutError();
  if (collaboration.reasoning_effort !== null)
    string(collaboration.reasoning_effort);
}

function validateStringObject(
  value: RecordValue,
  keys: readonly string[],
): void {
  assertKeys(value, keys);
  for (const key of keys) string(value[key]);
}

function assertKeys(value: RecordValue, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new IncompleteRolloutError();
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new IncompleteRolloutError();
  return value;
}

function functionArguments(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(string(value));
  assertBoundedJson(parsed, { nodes: 0 });
  return object(parsed) as JsonObject;
}

function messageContent(value: unknown): string {
  return array(value)
    .map((part) => {
      const block = object(part);
      assertKeys(block, ['type', 'text']);
      if (block.type !== 'input_text' && block.type !== 'output_text')
        throw new IncompleteRolloutError();
      return string(block.text);
    })
    .join('\n');
}

function isInjectedContext(text: string): boolean {
  return (
    /^# AGENTS\.md instructions for [^\n]+\n/.test(text) ||
    (text.startsWith('<environment_context>') &&
      text.endsWith('</environment_context>'))
  );
}

function assertEmptyMedia(payload: RecordValue): void {
  for (const name of ['images', 'local_images', 'text_elements']) {
    if (payload[name] !== undefined && array(payload[name]).length !== 0)
      throw new IncompleteRolloutError();
  }
}

function timestamp(
  value: unknown,
  warnings: AgentNativeEvidenceWarning[],
  index: number,
): { timestamp?: string } {
  if (value === undefined) return {};
  if (typeof value === 'string' && isAtifTimestamp(value))
    return { timestamp: value };
  warnings.push({
    code: 'value_omitted',
    message: 'An invalid Codex native timestamp was omitted.',
    path: `line:${index + 1}`,
  });
  return {};
}

function assertBoundedJson(value: unknown, budget: { nodes: number }): void {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (++budget.nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH)
      throw new IncompleteRolloutError();
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 });
    } else if (
      typeof current.value === 'number' &&
      !Number.isFinite(current.value)
    )
      throw new Error('Invalid JSON number.');
  }
}

function object(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a Codex object.');
  return value as RecordValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new IncompleteRolloutError();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected Codex text.');
  return value;
}
function nonempty(value: unknown): string {
  const text = string(value);
  if (!text) throw new Error('Expected a Codex identity.');
  return text;
}
function unavailable(
  code: 'source_unavailable' | 'source_invalid' | 'source_incomplete',
): AgentNativeEvidenceResult {
  return {
    kind: 'unavailable',
    reason: {
      code,
      message:
        code === 'source_unavailable'
          ? 'The exact Codex session is unavailable.'
          : 'Codex session evidence could not be normalized safely.',
    },
  };
}
class IncompleteRolloutError extends Error {}
