import { isDeepStrictEqual } from 'node:util';

import type { AgentToolCall, AgentTurn } from '../../contracts/agent.ts';
import type { ProtocolRejection } from '../../diagnostics/agent.ts';

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_LINES = 100_000;
export const MAX_CODEX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_DEPTH = 64;
const MAX_TOOL_CALLS = 2_000;

type JsonRecord = Record<string, unknown>;

interface StreamItem {
  readonly type: string;
  readonly text?: string;
  readonly toolCall?: AgentToolCall;
}

export interface CodexStreamOptions {
  readonly hookAutomation?: boolean;
  readonly workspacePath?: string;
}

export function isCodexAdvisory(
  event: JsonRecord | undefined,
  options: CodexStreamOptions,
  state: {
    readonly threadStarted: boolean;
    readonly turnStarted: boolean;
    readonly turnCompleted: boolean;
  },
): boolean {
  if (
    !state.threadStarted ||
    state.turnStarted ||
    state.turnCompleted ||
    event?.type !== 'item.completed'
  )
    return false;
  const item = event.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const raw = item as JsonRecord;
  if (raw.type !== 'error') return false;
  // The pinned CLI emits these advisories before starting the selected turn.
  return Boolean(
    (options.hookAutomation &&
      raw.message ===
        '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.') ||
      (options.workspacePath !== undefined &&
        raw.message ===
          `Ignored unsupported project-local config keys in ${options.workspacePath}/.codex/config.toml: model_providers. If you want these settings to apply, manually set them in your user-level config.toml.`),
  );
}

/** Parse one completed `codex exec --json` or `codex exec resume --json` invocation. */
function parseStream(
  stdout: string,
  expectedSessionId: string | undefined,
  options: CodexStreamOptions,
  location: { line_index?: number },
): AgentTurn {
  if (
    expectedSessionId !== undefined &&
    !isSafeCodexSessionId(expectedSessionId)
  ) {
    throw new CodexStreamError('The expected Codex session ID is invalid.');
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_STREAM_BYTES) {
    throw new CodexStreamError(
      'Codex output exceeded its byte limit.',
      'output_limit',
    );
  }

  let sessionId: string | undefined;
  let started = false;
  let completed = false;
  let lineStart = 0;
  let lineCount = 0;
  let toolCount = 0;
  const graphBudget = { nodes: 0 };
  const items = new Map<string, StreamItem>();
  const completedItems = new Map<string, JsonRecord>();

  for (let end = 0; end <= stdout.length; end += 1) {
    if (end !== stdout.length && stdout.charCodeAt(end) !== 10) continue;
    if (end === stdout.length && lineStart === end) break;
    lineCount += 1;
    location.line_index = lineCount;
    if (lineCount > MAX_STREAM_LINES) {
      throw new CodexStreamError(
        'Codex output exceeded its line limit.',
        'output_limit',
      );
    }
    const line = stdout.slice(lineStart, end);
    lineStart = end + 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_CODEX_STREAM_LINE_BYTES) {
      throw new CodexStreamError(
        'Codex output contained an oversized line.',
        'output_limit',
      );
    }
    if (!line.trim()) continue;
    const event = parseLine(line, graphBudget);

    if (event.type === 'error' || event.type === 'turn.failed') {
      // Error messages and payloads can contain provider responses or secrets.
      throw new CodexStreamError(
        'Codex reported a failed turn.',
        'turn_failed',
      );
    }
    if (completed) invalidStream('invalid_event_order');

    switch (event.type) {
      case 'thread.started': {
        onlyKeys(event, ['type', 'thread_id']);
        if (sessionId !== undefined || started)
          invalidStream('invalid_event_order');
        const id = requiredString(event.thread_id);
        if (
          !isSafeCodexSessionId(id) ||
          (expectedSessionId !== undefined && id !== expectedSessionId)
        ) {
          throw new CodexStreamError(
            'Codex returned an invalid or unexpected session ID.',
          );
        }
        sessionId = id;
        break;
      }
      case 'turn.started':
        onlyKeys(event, ['type']);
        if (sessionId === undefined || started)
          invalidStream('invalid_event_order');
        started = true;
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        onlyKeys(event, ['type', 'item']);
        const raw = requiredRecord(event.item);
        const id = requiredString(raw.id);
        if (
          id.length > 128 ||
          !/^[A-Za-z0-9]/.test(id) ||
          /[^A-Za-z0-9._-]/.test(id)
        )
          invalidStream();
        if (
          isCodexAdvisory(event, options, {
            threadStarted: sessionId !== undefined,
            turnStarted: started,
            turnCompleted: completed,
          })
        ) {
          onlyKeys(raw, ['id', 'type', 'message']);
          if (completedItems.has(id)) invalidStream('invalid_event_order');
          completedItems.set(id, raw);
          break;
        }
        if (!started || (completedItems.has(id) && !items.has(id)))
          invalidStream('invalid_event_order');
        let item: StreamItem;
        try {
          item = parseItem(raw);
        } catch (error) {
          if (error instanceof CodexStreamError)
            error.rejection.schema_path = 'event.item';
          throw error;
        }
        const previous = items.get(id);
        if (previous !== undefined && previous.type !== item.type)
          invalidStream('invalid_event_order');
        const previousCompletion = completedItems.get(id);
        if (
          previousCompletion !== undefined &&
          (event.type !== 'item.completed' ||
            !isDeepStrictEqual(previousCompletion, raw))
        )
          invalidStream('invalid_event_order');
        if (event.type === 'item.completed') completedItems.set(id, raw);
        if (previous === undefined && item.toolCall !== undefined) {
          toolCount += 1;
          if (toolCount > MAX_TOOL_CALLS) {
            throw new CodexStreamError(
              'Codex output exceeded its tool-call limit.',
              'output_limit',
            );
          }
        }
        // Item events carry snapshots, not text or argument deltas. Retaining
        // the latest snapshot also keeps tools first seen in item.started.
        items.set(id, item);
        break;
      }
      case 'turn.completed':
        onlyKeys(event, ['type', 'usage']);
        if (!started) invalidStream('invalid_event_order');
        try {
          validateUsage(event.usage);
        } catch (error) {
          if (error instanceof CodexStreamError)
            error.rejection.schema_path = 'event.usage';
          throw error;
        }
        completed = true;
        break;
      default:
        throw new CodexStreamError(
          'Codex output contained an unsupported event.',
          'unsupported_event_type',
        );
    }
  }

  delete location.line_index;
  if (!completed || sessionId === undefined) {
    throw new CodexStreamError(
      'Codex stream ended without a completed turn with a valid session ID.',
      'invalid_event_order',
    );
  }
  return {
    text: [...items.values()]
      .flatMap((item) =>
        item.text === undefined || item.text.length === 0 ? [] : [item.text],
      )
      .join('\n\n'),
    sessionId,
    toolCalls: [...items.values()].flatMap((item) =>
      item.toolCall === undefined ? [] : [item.toolCall],
    ),
  };
}

export function parseCodexStream(
  stdout: string,
  expectedSessionId?: string,
  options: CodexStreamOptions = {},
): AgentTurn {
  const location: { line_index?: number } = {};
  try {
    return parseStream(stdout, expectedSessionId, options, location);
  } catch (error) {
    if (error instanceof CodexStreamError && location.line_index !== undefined)
      Object.assign(error.rejection, location);
    throw error;
  }
}

export class CodexStreamError extends Error {
  readonly code = 'invalid_codex_stream' as const;

  readonly rejection: ProtocolRejection;

  constructor(message: string, code: ProtocolRejection['code'] = 'unknown') {
    super(message);
    this.name = 'CodexStreamError';
    this.rejection = { code, schema_path: 'event' };
  }
}

/** Codex thread IDs are UUIDs; keep the exact identity without path coercion. */
export function isSafeCodexSessionId(value: string): boolean {
  return (
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function parseItem(item: JsonRecord): StreamItem {
  const id = requiredString(item.id);
  const type = requiredString(item.type);
  switch (type) {
    case 'agent_message':
    case 'reasoning': {
      onlyKeys(item, ['id', 'type', 'text']);
      const text = requiredString(item.text);
      return {
        type,
        ...(type === 'agent_message' ? { text } : {}),
      };
    }
    case 'command_execution':
      onlyKeys(item, [
        'id',
        'type',
        'command',
        'aggregated_output',
        'exit_code',
        'status',
      ]);
      validateStatus(item.status);
      optionalString(item.aggregated_output);
      if (
        item.exit_code !== undefined &&
        item.exit_code !== null &&
        (typeof item.exit_code !== 'number' ||
          !Number.isSafeInteger(item.exit_code))
      )
        invalidStream();
      return {
        type,
        toolCall: {
          id,
          name: type,
          input: { command: requiredString(item.command) },
        },
      };
    case 'file_change': {
      onlyKeys(item, ['id', 'type', 'changes', 'status']);
      validateStatus(item.status);
      const changes = requiredArray(item.changes).map((value) => {
        const change = requiredRecord(value);
        onlyKeys(change, ['path', 'kind']);
        const path = requiredString(change.path);
        if (!['add', 'delete', 'update'].includes(requiredString(change.kind)))
          invalidStream();
        return { path, kind: change.kind };
      });
      return { type, toolCall: { id, name: type, input: { changes } } };
    }
    case 'mcp_tool_call': {
      onlyKeys(item, [
        'id',
        'type',
        'server',
        'tool',
        'arguments',
        'result',
        'error',
        'status',
      ]);
      validateStatus(item.status);
      const server = requiredString(item.server);
      const tool = requiredString(item.tool);
      if (!server || !tool || !Object.hasOwn(item, 'arguments'))
        invalidStream();
      if (item.result !== undefined && item.result !== null) {
        const result = requiredRecord(item.result);
        // Opaque result data is bounded with the event and omitted from AgentTurn.
        onlyKeys(result, ['content', '_meta', 'structured_content']);
        requiredArray(result.content);
      }
      if (item.error !== undefined && item.error !== null) {
        const error = requiredRecord(item.error);
        onlyKeys(error, ['message']);
        requiredString(error.message);
      }
      return {
        type,
        toolCall: {
          id,
          name: `mcp__${server}__${tool}`,
          input: item.arguments,
        },
      };
    }
    case 'web_search':
      onlyKeys(item, ['id', 'type', 'query', 'action']);
      if (item.action !== undefined) requiredRecord(item.action);
      return {
        type,
        toolCall: {
          id,
          name: type,
          input: {
            query: requiredString(item.query),
            ...(item.action === undefined ? {} : { action: item.action }),
          },
        },
      };
    case 'todo_list': {
      onlyKeys(item, ['id', 'type', 'items']);
      const entries = requiredArray(item.items).map((value) => {
        const entry = requiredRecord(value);
        onlyKeys(entry, ['text', 'completed']);
        const text = requiredString(entry.text);
        if (typeof entry.completed !== 'boolean') invalidStream();
        return { text, completed: entry.completed };
      });
      return { type, toolCall: { id, name: type, input: { items: entries } } };
    }
    case 'error':
      throw new CodexStreamError('Codex reported a failed item.', 'item_error');
    default:
      throw new CodexStreamError(
        'Codex output contained an unsupported item.',
        'unsupported_event_type',
      );
  }
}

function validateUsage(value: unknown): void {
  const usage = requiredRecord(value);
  onlyKeys(usage, [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
  ]);
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    nonnegativeInteger(usage[key]);
  }
  if (usage.reasoning_output_tokens !== undefined)
    nonnegativeInteger(usage.reasoning_output_tokens);
  if (usage.cache_write_input_tokens !== undefined)
    nonnegativeInteger(usage.cache_write_input_tokens);
}

function validateStatus(value: unknown): void {
  if (value !== 'in_progress' && value !== 'completed' && value !== 'failed')
    invalidStream();
}

function nonnegativeInteger(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalidStream();
}

function onlyKeys(value: JsonRecord, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new CodexStreamError(
      'Codex output contained an unexpected field.',
      'unexpected_field',
    );
}

function requiredRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalidStream();
  return value as JsonRecord;
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidStream();
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') invalidStream();
  return value;
}

function optionalString(value: unknown): void {
  if (value !== undefined) requiredString(value);
}

function invalidStream(code: ProtocolRejection['code'] = 'unknown'): never {
  throw new CodexStreamError('Codex output contained a malformed event.', code);
}

function parseLine(line: string, budget: { nodes: number }): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new CodexStreamError(
      'Codex output contained invalid JSON.',
      'invalid_json',
    );
  }

  // Validate iteratively before walking item structures or exposing opaque
  // tool arguments to the engine. The budget is shared across all snapshots.
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    budget.nodes += 1;
    if (budget.nodes > MAX_GRAPH_NODES || next.depth > MAX_GRAPH_DEPTH) {
      throw new CodexStreamError(
        'Codex output exceeded its JSON structure limits.',
        'output_limit',
      );
    }
    if (typeof next.value === 'number' && !Number.isFinite(next.value))
      invalidStream();
    if (typeof next.value === 'object' && next.value !== null) {
      const children = Object.values(next.value);
      if (budget.nodes + pending.length + children.length > MAX_GRAPH_NODES) {
        throw new CodexStreamError(
          'Codex output exceeded its JSON structure limits.',
          'output_limit',
        );
      }
      for (const child of children) {
        pending.push({ value: child, depth: next.depth + 1 });
      }
    }
  }
  return requiredRecord(value);
}
