import type {
  AgentToolCall,
  AgentToolResult,
  AgentTurn,
} from '../../contracts/agent.ts';
import { textToolResult } from '../toolResult.ts';

const MAX_STREAM_LINES = 100_000;
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_TOOL_CALLS = 2_000;

interface ClaudeStreamEvent {
  type?: string;
  result?: string;
  session_id?: string;
  /** Set on messages produced inside a subagent (Task) run. */
  parent_tool_use_id?: unknown;
  total_cost_usd?: number;
  message?: {
    content?: Array<{
      type?: string;
      id?: string;
      text?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
}

/** Parse one completed `claude --output-format stream-json` invocation. */
export function parseClaudeStream(stdout: string): AgentTurn {
  const toolCalls: AgentToolCall[] = [];
  const results = new Map<string, AgentToolResult>();
  const toolIds = new Set<string>();
  let resultText: string | undefined;
  let lastAssistantText = '';
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let lineStart = 0;
  let lineCount = 0;

  for (let end = 0; end <= stdout.length; end += 1) {
    if (end !== stdout.length && stdout.charCodeAt(end) !== 10) continue;
    lineCount += 1;
    if (lineCount > MAX_STREAM_LINES) {
      throw new ClaudeStreamError('Claude output exceeded its line limit.');
    }
    const line = stdout.slice(lineStart, end);
    lineStart = end + 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_STREAM_LINE_BYTES) {
      throw new ClaudeStreamError('Claude output contained an oversized line.');
    }
    const event = parseLine(line);
    if (!event) continue;
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          lastAssistantText = block.text;
        } else if (
          block.type === 'tool_use' &&
          typeof block.name === 'string'
        ) {
          toolCalls.push({
            ...(typeof block.id === 'string' ? { id: block.id } : {}),
            name: block.name,
            ...(block.input === undefined ? {} : { input: block.input }),
          });
          if (typeof block.id === 'string') toolIds.add(block.id);
          if (toolCalls.length > MAX_TOOL_CALLS) {
            throw new ClaudeStreamError(
              'Claude output exceeded its tool-call limit.',
            );
          }
        }
      }
    } else if (
      event.type === 'user' &&
      // Subagent output belongs to separately selected evidence, not the root.
      typeof event.parent_tool_use_id !== 'string'
    ) {
      for (const block of event.message?.content ?? []) {
        if (
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string' &&
          toolIds.has(block.tool_use_id)
        ) {
          results.set(block.tool_use_id, {
            ...textToolResult(block.content),
            ...(typeof block.is_error === 'boolean'
              ? { isError: block.is_error }
              : {}),
          });
        }
      }
    } else if (event.type === 'result') {
      if (typeof event.result === 'string') resultText = event.result;
      if (typeof event.session_id === 'string') sessionId = event.session_id;
      if (
        typeof event.total_cost_usd === 'number' &&
        Number.isFinite(event.total_cost_usd) &&
        event.total_cost_usd >= 0
      ) {
        costUsd = event.total_cost_usd;
      }
    }
  }

  if (!sessionId || !isSafeSessionId(sessionId)) {
    throw new ClaudeStreamError(
      'Claude produced no valid terminal session ID.',
    );
  }
  return {
    text: resultText ?? lastAssistantText,
    sessionId,
    toolCalls: toolCalls.map((call) => {
      const result = call.id === undefined ? undefined : results.get(call.id);
      return result === undefined ? call : { ...call, result };
    }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export class ClaudeStreamError extends Error {
  readonly code = 'invalid_claude_stream' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeStreamError';
  }
}

export function isSafeSessionId(value: string): boolean {
  return (
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes('..')
  );
}

function parseLine(line: string): ClaudeStreamEvent | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null
      ? (value as ClaudeStreamEvent)
      : undefined;
  } catch {
    // Claude occasionally emits a non-JSON banner; the terminal result remains
    // authoritative, so bounded noise lines are ignored.
    return undefined;
  }
}
