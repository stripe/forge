import { isDeepStrictEqual } from 'node:util';
import { observeAgentTokenUsage } from '../../agentUsage.ts';

import type {
  AgentTokenUsage,
  AgentToolCall,
  AgentTurn,
} from '../../contracts/agent.ts';
import { textToolResult } from '../toolResult.ts';

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_LINES = 100_000;
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_DEPTH = 64;
const MAX_TOOL_CALLS = 2_000;

type JsonRecord = Record<string, unknown>;

interface StreamItem {
  readonly type: string;
  readonly text?: string;
  readonly toolCall?: AgentToolCall;
}

/**
 * Parse one completed exec invocation. Usage is the native cumulative thread
 * snapshot; AgentSession converts it to per-invocation counters before delivery.
 */
export function parseCodexStream(
  stdout: string,
  expectedSessionId?: string,
  options: {
    readonly hookAutomation?: boolean;
    readonly workspacePath?: string;
    /** Selected model; tolerates only the pinned CLI's metadata advisory for it. */
    readonly model?: string;
  } = {},
): AgentTurn {
  if (
    expectedSessionId !== undefined &&
    !isSafeCodexSessionId(expectedSessionId)
  ) {
    throw new CodexStreamError('The expected Codex session ID is invalid.');
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_STREAM_BYTES) {
    throw new CodexStreamError('Codex output exceeded its byte limit.');
  }

  let sessionId: string | undefined;
  let started = false;
  let completed = false;
  let usage: AgentTokenUsage | undefined;
  let lineStart = 0;
  let lineCount = 0;
  let toolCount = 0;
  const graphBudget = { nodes: 0 };
  const items = new Map<string, StreamItem>();
  const completedItems = new Map<string, JsonRecord>();

  for (let end = 0; end <= stdout.length; end += 1) {
    if (end !== stdout.length && stdout.charCodeAt(end) !== 10) continue;
    lineCount += 1;
    if (lineCount > MAX_STREAM_LINES) {
      throw new CodexStreamError('Codex output exceeded its line limit.');
    }
    const line = stdout.slice(lineStart, end);
    lineStart = end + 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_STREAM_LINE_BYTES) {
      throw new CodexStreamError('Codex output contained an oversized line.');
    }
    if (!line.trim()) continue;
    const event = parseLine(line, graphBudget);

    if (event.type === 'error' || event.type === 'turn.failed') {
      // Error messages and payloads can contain provider responses or secrets.
      throw new CodexStreamError('Codex reported a failed turn.');
    }
    if (completed) invalidStream();

    switch (event.type) {
      case 'thread.started': {
        onlyKeys(event, ['type', 'thread_id']);
        if (sessionId !== undefined || started) invalidStream();
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
        if (sessionId === undefined || started) invalidStream();
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
        // The pinned CLI emits this advisory twice before turn.started. It is
        // accepted only for an invocation which explicitly selected automation.
        const hookAdvisory =
          options.hookAutomation &&
          raw.message ===
            '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.';
        const configAdvisory =
          options.workspacePath !== undefined &&
          raw.message ===
            `Ignored unsupported project-local config keys in ${options.workspacePath}/.codex/config.toml: model_providers. If you want these settings to apply, manually set them in your user-level config.toml.`;
        // The pinned CLI has no bundled metadata for models newer than itself and
        // reports that before turn.started, then runs with fallback metadata.
        const modelMetadataAdvisory =
          options.model !== undefined &&
          raw.message ===
            `Model metadata for \`${options.model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;
        if (
          (hookAdvisory || configAdvisory || modelMetadataAdvisory) &&
          sessionId !== undefined &&
          !started &&
          event.type === 'item.completed' &&
          raw.type === 'error'
        ) {
          onlyKeys(raw, ['id', 'type', 'message']);
          if (completedItems.has(id)) invalidStream();
          completedItems.set(id, raw);
          break;
        }
        if (!started || (completedItems.has(id) && !items.has(id)))
          invalidStream();
        const item = parseItem(raw);
        const previous = items.get(id);
        if (previous !== undefined && previous.type !== item.type)
          invalidStream();
        const previousCompletion = completedItems.get(id);
        if (
          previousCompletion !== undefined &&
          (event.type !== 'item.completed' ||
            !isDeepStrictEqual(previousCompletion, raw))
        )
          invalidStream();
        if (event.type === 'item.completed') completedItems.set(id, raw);
        if (previous === undefined && item.toolCall !== undefined) {
          toolCount += 1;
          if (toolCount > MAX_TOOL_CALLS) {
            throw new CodexStreamError(
              'Codex output exceeded its tool-call limit.',
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
        if (!started) invalidStream();
        usage = validateUsage(event.usage);
        completed = true;
        break;
      default:
        throw new CodexStreamError(
          'Codex output contained an unsupported event.',
        );
    }
  }

  if (!completed || sessionId === undefined) {
    throw new CodexStreamError(
      'Codex produced no completed turn with a valid session ID.',
    );
  }
  return {
    text: [...items.values()]
      .flatMap((item) =>
        item.text === undefined || item.text.length === 0 ? [] : [item.text],
      )
      .join('\n\n'),
    sessionId,
    ...(usage === undefined ? {} : { usage }),
    toolCalls: [...items.values()].flatMap((item) =>
      item.toolCall === undefined ? [] : [item.toolCall],
    ),
  };
}

export class CodexStreamError extends Error {
  readonly code = 'invalid_codex_stream' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CodexStreamError';
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
          ...(item.status === 'in_progress'
            ? {
                result: {
                  content:
                    '[Forge tool result unavailable: command did not complete.]',
                  truncated: true,
                },
              }
            : typeof item.aggregated_output === 'string'
              ? {
                  result: {
                    content: item.aggregated_output,
                    isError:
                      item.status === 'failed' ||
                      (typeof item.exit_code === 'number' &&
                        item.exit_code !== 0),
                  },
                }
              : {}),
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
      let output: AgentToolCall['result'];
      if (item.result !== undefined && item.result !== null) {
        const result = requiredRecord(item.result);
        // Opaque result data is bounded with the event and omitted from AgentTurn.
        onlyKeys(result, ['content', '_meta', 'structured_content']);
        requiredArray(result.content);
        output = textToolResult(result.content);
        if (result.structured_content != null) {
          output = {
            ...output,
            content: `${output.content}\nStructured result:\n${JSON.stringify(result.structured_content)}`,
          };
        }
        if (item.status === 'failed') output = { ...output, isError: true };
      }
      if (item.error !== undefined && item.error !== null) {
        const error = requiredRecord(item.error);
        onlyKeys(error, ['message']);
        requiredString(error.message);
        output = { content: requiredString(error.message), isError: true };
      }
      if (item.status === 'in_progress') {
        output = {
          content:
            '[Forge tool result unavailable: tool call did not complete.]',
          truncated: true,
        };
      }
      return {
        type,
        toolCall: {
          id,
          name: `mcp__${server}__${tool}`,
          input: item.arguments,
          ...(output === undefined ? {} : { result: output }),
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
      throw new CodexStreamError('Codex reported a failed item.');
    default:
      throw new CodexStreamError('Codex output contained an unsupported item.');
  }
}

function validateUsage(value: unknown): AgentTokenUsage {
  try {
    const usage = requiredRecord(value);
    onlyKeys(usage, [
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
    ]);
    for (const key of [
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
    ]) {
      nonnegativeInteger(usage[key]);
    }
    if (usage.reasoning_output_tokens !== undefined)
      nonnegativeInteger(usage.reasoning_output_tokens);
    if (usage.cache_write_input_tokens !== undefined)
      nonnegativeInteger(usage.cache_write_input_tokens);
    return {
      input_tokens: usage.input_tokens as number,
      cached_input_tokens: usage.cached_input_tokens as number,
      output_tokens: usage.output_tokens as number,
      reasoning_tokens:
        (usage.reasoning_output_tokens as number | undefined) ?? null,
    };
  } catch {
    return observeAgentTokenUsage(null);
  }
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
  if (Object.keys(value).some((key) => !keys.includes(key))) invalidStream();
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

function invalidStream(): never {
  throw new CodexStreamError('Codex output contained a malformed event.');
}

function parseLine(line: string, budget: { nodes: number }): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    invalidStream();
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
      );
    }
    if (typeof next.value === 'number' && !Number.isFinite(next.value))
      invalidStream();
    if (typeof next.value === 'object' && next.value !== null) {
      const children = Object.values(next.value);
      if (budget.nodes + pending.length + children.length > MAX_GRAPH_NODES) {
        throw new CodexStreamError(
          'Codex output exceeded its JSON structure limits.',
        );
      }
      for (const child of children) {
        pending.push({ value: child, depth: next.depth + 1 });
      }
    }
  }
  return requiredRecord(value);
}
