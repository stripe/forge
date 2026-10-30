import { isDeepStrictEqual } from 'node:util';
import type { AgentToolCall, AgentTurn } from '../../contracts/agent.ts';
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
    let finishedMessage: string | undefined;
    let stepHasTools = false;
    let messageHasTools = false;
    let completed = false;
    let cost = 0;
    const parts = new Map<string, NativeRecord>();
    const calls = new Map<string, AgentToolCall>();
    const messages = new Set<string>();
    const texts = new Map<string, string[]>();
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
        if (
          activeMessage !== undefined ||
          !completed ||
          messageHasTools ||
          finishedMessage === undefined ||
          messages.has(message)
        )
          throw new Error();
        string(part.text);
        nonnegative(record(part.time).end);
        // v1.19.0 marks the summary on the stored message, but JSON stdout
        // contains only parts. The immediately finished, tool-free assistant
        // message is the summary preceding this synthetic continuation.
        texts.delete(finishedMessage);
        messages.add(message);
        finishedMessage = undefined;
        completed = false;
        continue;
      }
      if (event.type === 'step_start' && part.type === 'step-start') {
        // A recoverable stream failure can retry the same assistant message
        // with a new start part and no finish for the failed attempt.
        if (activeMessage !== undefined && activeMessage !== message)
          throw new Error();
        if (activeMessage === undefined) {
          if (messages.has(message)) throw new Error();
          messages.add(message);
          texts.set(message, []);
          messageHasTools = false;
        }
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
          activeMessage = undefined;
          finishedMessage = message;
        } else if (event.type === 'text' && part.type === 'text') {
          texts.get(message)!.push(string(part.text));
        } else if (event.type === 'reasoning' && part.type === 'reasoning') {
          string(part.text);
        } else if (event.type === 'tool_use' && part.type === 'tool') {
          const call = tool(part);
          stepHasTools = true;
          messageHasTools = true;
          if (calls.has(call.id) || calls.size >= 2_000) throw new Error();
          calls.set(call.id, call);
        } else throw new Error();
      }
    }
    if (!completed || id === undefined || !Number.isFinite(cost))
      throw new Error();
    return {
      text: [...texts.values()].flat().join('\n\n'),
      sessionId: id,
      toolCalls: [...calls.values()],
      costUsd: cost,
    };
  } catch {
    throw new OpenCodeStreamError();
  }
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
