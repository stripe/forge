import { observeAgentTokenUsage, sumObservedTokens } from '../../agentUsage.ts';
import type {
  AgentTokenUsage,
  AgentToolCall,
  AgentTurn,
} from '../../contracts/agent.ts';

const MAX_STREAM_LINES = 100_000;
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_TOOL_CALLS = 2_000;

interface ClaudeStreamEvent {
  type?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: unknown;
  message?: {
    content?: Array<{
      type?: string;
      id?: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
}

/** Parse one completed `claude --output-format stream-json` invocation. */
export function parseClaudeStream(stdout: string): AgentTurn {
  const toolCalls: AgentToolCall[] = [];
  let resultText: string | undefined;
  let lastAssistantText = '';
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let usage: AgentTokenUsage | undefined;
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
          if (toolCalls.length > MAX_TOOL_CALLS) {
            throw new ClaudeStreamError(
              'Claude output exceeded its tool-call limit.',
            );
          }
        }
      }
    } else if (event.type === 'result') {
      if (event.usage !== undefined) {
        const native = event.usage;
        usage =
          native !== null &&
          typeof native === 'object' &&
          !Array.isArray(native)
            ? claudeUsage(native as Record<string, unknown>)
            : observeAgentTokenUsage(null);
      }
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
    toolCalls,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function claudeUsage(native: Record<string, unknown>): AgentTokenUsage {
  const creation = native.cache_creation;
  const split =
    creation !== null &&
    typeof creation === 'object' &&
    !Array.isArray(creation)
      ? (creation as Record<string, unknown>)
      : {};
  return {
    ...(creation === undefined
      ? {}
      : {
          cache_write_5m_input_tokens: sumObservedTokens(
            split.ephemeral_5m_input_tokens,
          ),
          cache_write_1h_input_tokens: sumObservedTokens(
            split.ephemeral_1h_input_tokens,
          ),
        }),
    cache_write_input_tokens: sumObservedTokens(
      native.cache_creation_input_tokens,
    ),
    input_tokens: sumObservedTokens(
      native.input_tokens,
      native.cache_read_input_tokens,
      native.cache_creation_input_tokens === undefined
        ? 0
        : native.cache_creation_input_tokens,
    ),
    cached_input_tokens: sumObservedTokens(native.cache_read_input_tokens),
    output_tokens: sumObservedTokens(native.output_tokens),
    reasoning_tokens: null,
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
