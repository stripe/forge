import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  OPEN_CODE_SESSION,
  openCodeEvents,
  openCodeStream,
} from '../../../test/support/opencode.ts';
import { OpenCodeStreamError, parseOpenCodeStream } from './stream.ts';

const turn = { prompt: 'Do it', response: 'Done.' };
const encode = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join('\n');
describe('OpenCode live stream', () => {
  it('allows a stop step followed by tools or post-compaction continuation', () => {
    const events = openCodeEvents(turn);
    events[3]!.part.reason = 'stop';
    assert.equal(parseOpenCodeStream(encode(events)).text, 'Done.');
    assert.throws(
      () => parseOpenCodeStream(encode(events.slice(0, 4))),
      OpenCodeStreamError,
    );
    const summary = openCodeEvents(
      { ...turn, response: 'Compaction summary' },
      1,
    ).slice(4);
    const continuation = {
      type: 'text',
      sessionID: OPEN_CODE_SESSION,
      timestamp: 1790000000001,
      part: {
        type: 'text',
        id: 'prt_compaction',
        messageID: 'msg_continue',
        sessionID: OPEN_CODE_SESSION,
        synthetic: true,
        metadata: { compaction_continue: true },
        time: { start: 1790000000000, end: 1790000000001 },
        text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
      },
    };
    assert.equal(
      parseOpenCodeStream(encode([...summary, continuation, ...events])).text,
      'Compaction summary\n\nDone.',
    );
    assert.throws(
      () => parseOpenCodeStream(encode([...summary, continuation])),
      OpenCodeStreamError,
    );
  });
  it('accepts a recovered retry of the same assistant message only when the final attempt completes', () => {
    const events = openCodeEvents(turn);
    const retry = {
      ...events[0],
      part: { ...events[0]!.part, id: 'prt_retry' },
    };
    assert.equal(
      parseOpenCodeStream(encode([events[0], retry, ...events.slice(1)])).text,
      'Done.',
    );
    assert.throws(
      () => parseOpenCodeStream(encode([events[0], retry])),
      OpenCodeStreamError,
    );
    const wrongMessage = {
      ...retry,
      part: { ...retry.part, messageID: 'msg_unrelated' },
    };
    assert.throws(
      () =>
        parseOpenCodeStream(
          encode([events[0], wrongMessage, ...events.slice(1)]),
        ),
      OpenCodeStreamError,
    );
  });
  it('distinguishes intermediate steps and tool errors from session failure', () => {
    const result = parseOpenCodeStream(
      openCodeStream({ ...turn, error: true }),
      OPEN_CODE_SESSION,
    );
    assert.equal(result.text, turn.response);
    assert.equal(result.sessionId, OPEN_CODE_SESSION);
    assert.equal(result.costUsd, 0.02);
    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_0',
        name: 'bash',
        input: { command: 'printf complete > answer.txt' },
      },
    ]);
  });
  it('deduplicates identical snapshots without inflating tools or cost', () => {
    const events = openCodeEvents(turn);
    assert.deepEqual(
      parseOpenCodeStream(encode(events.flatMap((event) => [event, event]))),
      parseOpenCodeStream(encode(events)),
    );
    assert.throws(
      () =>
        parseOpenCodeStream(
          encode([
            ...events,
            { ...events.at(-1), part: { ...events.at(-1)!.part, cost: 100 } },
          ]),
        ),
      OpenCodeStreamError,
    );
  });
  it('rejects failed, unfinished, unknown, and cross-session events without payload diagnostics', () => {
    const events = openCodeEvents(turn);
    for (const invalid of [
      encode(events.slice(0, 4)),
      encode(events.slice(1)),
      encode([
        ...events,
        { type: 'error', sessionID: OPEN_CODE_SESSION, error: 'SECRET' },
      ]),
      encode(
        events.map((event, i) =>
          i === 2 ? { ...event, sessionID: 'ses_other' } : event,
        ),
      ),
      encode(
        events.map((event, i) =>
          i === 2 ? { ...event, type: 'unknown' } : event,
        ),
      ),
      'not-json',
    ])
      assert.throws(
        () => parseOpenCodeStream(invalid),
        (error: unknown) =>
          error instanceof OpenCodeStreamError &&
          !error.message.includes('SECRET'),
      );
    assert.throws(
      () => parseOpenCodeStream(encode(events), 'ses_wrong'),
      OpenCodeStreamError,
    );
  });
  it('bounds total output, individual lines and recursive JSON', () => {
    for (const text of [
      'x'.repeat(16 * 1024 * 1024 + 1),
      'x'.repeat(1024 * 1024 + 1),
      `${'['.repeat(100)}0${']'.repeat(100)}`,
    ])
      assert.throws(() => parseOpenCodeStream(text), OpenCodeStreamError);
  });
});
