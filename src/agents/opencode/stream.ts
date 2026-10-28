import { isDeepStrictEqual } from 'node:util';
import {
  observeAgentTokenUsage,
  sumAgentTokenUsage,
  sumObservedTokens,
} from '../../agentUsage.ts';
import type {
  AgentTokenUsage,
  AgentToolCall,
  AgentTurn,
} from '../../contracts/agent.ts';
import {
  identifier,
  MAX_NATIVE_BYTES,
  type NativeRecord,
  nonnegative,
  parseJson,
  record,
  sessionId,
  string,
  terminal,
  tool,
} from './native.ts';

/** Parse completed part snapshots emitted by pinned `opencode run --format json`. */
export function parseOpenCodeStream(
  stdout: string,
  expectedSessionId?: string,
): AgentTurn {
  try {
    if (Buffer.byteLength(stdout) > MAX_NATIVE_BYTES) throw new Error();
    const lines = stdout.split('\n');
    if (lines.length > 100_000) throw new Error();
    let id: string | undefined;
    let activeMessage: string | undefined;
    let stepHasTools = false;
    let completed = false;
    let cost = 0;
    const usages: (AgentTokenUsage | undefined)[] = [];
    const parts = new Map<string, NativeRecord>();
    const calls = new Map<string, AgentToolCall>();
    const texts: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = record(parseJson(line, 1024 * 1024));
      const observed = sessionId(event.sessionID);
      if (
        (id !== undefined && observed !== id) ||
        (expectedSessionId !== undefined && observed !== expectedSessionId)
      )
        throw new Error();
      id = observed;
      if (event.type === 'error') throw new Error();
      const part = record(event.part);
      const partId = identifier(part.id);
      if (part.sessionID !== id) throw new Error();
      const previous = parts.get(partId);
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous, part)) throw new Error();
        continue;
      }
      parts.set(partId, part);
      const message = identifier(part.messageID);
      if (
        event.type === 'text' &&
        part.type === 'text' &&
        part.synthetic === true &&
        record(part.metadata).compaction_continue === true
      ) {
        // Pinned auto-compaction injects a synthetic USER continuation between
        // assistant steps. `run --format json` emits it without a role field.
        if (activeMessage !== undefined) throw new Error();
        string(part.text);
        nonnegative(record(part.time).end);
        completed = false;
        continue;
      }
      if (event.type === 'step_start' && part.type === 'step-start') {
        // A recoverable stream failure can retry the same assistant message
        // with a new start part and no finish for the failed attempt.
        if (activeMessage !== undefined && activeMessage !== message)
          throw new Error();
        activeMessage = message;
        // `stop` finishes one model step. Tools and automatic compaction can
        // lead to another step in the same successful CLI invocation.
        completed = false;
        stepHasTools = false;
      } else {
        if (activeMessage !== message) throw new Error();
        if (event.type === 'step_finish' && part.type === 'step-finish') {
          completed = terminal(part.reason) && !stepHasTools;
          cost += nonnegative(part.cost);
          if (part.tokens === undefined) usages.push(undefined);
          else usages.push(openCodeUsage(part.tokens));
          activeMessage = undefined;
        } else if (event.type === 'text' && part.type === 'text') {
          texts.push(string(part.text));
        } else if (event.type === 'reasoning' && part.type === 'reasoning') {
          string(part.text);
        } else if (event.type === 'tool_use' && part.type === 'tool') {
          const call = tool(part);
          const state = record(part.state);
          const output = state.status === 'error' ? state.error : state.output;
          stepHasTools = true;
          if (calls.has(call.id) || calls.size >= 2_000) throw new Error();
          calls.set(call.id, {
            ...call,
            result: {
              content:
                typeof output === 'string'
                  ? output
                  : '[Forge tool result unavailable.]',
              ...(typeof output === 'string' ? {} : { truncated: true }),
              isError: state.status === 'error',
            },
          });
        } else throw new Error();
      }
    }
    if (!completed || id === undefined || !Number.isFinite(cost))
      throw new Error();
    const usage = sumAgentTokenUsage(usages);
    return {
      text: texts.join('\n\n'),
      sessionId: id,
      toolCalls: [...calls.values()],
      costUsd: cost,
      ...(usage === undefined ? {} : { usage }),
    };
  } catch {
    throw new OpenCodeStreamError();
  }
}

function openCodeUsage(value: unknown): AgentTokenUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return observeAgentTokenUsage(null);
  const tokens = value as Record<string, unknown>;
  const cache =
    tokens.cache !== null &&
    typeof tokens.cache === 'object' &&
    !Array.isArray(tokens.cache)
      ? (tokens.cache as Record<string, unknown>)
      : {};
  return {
    input_tokens: sumObservedTokens(
      tokens.input,
      cache.read,
      cache.write === undefined ? 0 : cache.write,
    ),
    cached_input_tokens: sumObservedTokens(cache.read),
    output_tokens: sumObservedTokens(tokens.output, tokens.reasoning),
    reasoning_tokens: sumObservedTokens(tokens.reasoning),
  };
}

export class OpenCodeStreamError extends Error {
  readonly code = 'invalid_opencode_stream';
  constructor() {
    super(
      'OpenCode produced no valid completed turn for the selected session.',
    );
    this.name = 'OpenCodeStreamError';
  }
}
