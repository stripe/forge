import { agentTokenUsageSchema } from '../../agentUsage.ts';
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
  usage?: Record<string, unknown>;
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
        if (
          native === null ||
          typeof native !== 'object' ||
          Array.isArray(native)
        )
          throw new ClaudeStreamError('Claude returned invalid token usage.');
        const parsed = agentTokenUsageSchema.safeParse({
          input_tokens: native.input_tokens ?? null,
          cached_input_tokens: native.cache_read_input_tokens ?? null,
          output_tokens: native.output_tokens ?? null,
          reasoning_tokens: null,
        });
        const write = native.cache_creation_input_tokens ?? 0;
        if (
          !parsed.success ||
          typeof write !== 'number' ||
          !Number.isSafeInteger(write) ||
          write < 0
        )
          throw new ClaudeStreamError('Claude returned invalid token usage.');
        usage = parsed.data;
        if (usage.input_tokens !== null && usage.cached_input_tokens !== null) {
          usage = {
            ...usage,
            input_tokens:
              usage.input_tokens + usage.cached_input_tokens + write,
          };
          if (!agentTokenUsageSchema.safeParse(usage).success)
            throw new ClaudeStreamError('Claude returned invalid token usage.');
        } else usage = { ...usage, input_tokens: null };
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
