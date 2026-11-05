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
const textStep = (text: string, index: number) =>
  openCodeEvents({ ...turn, response: text }, index).slice(4);
const continuation = (index = 0) => ({
  type: 'text',
  sessionID: OPEN_CODE_SESSION,
  timestamp: 1790000000001,
  part: {
    type: 'text',
    id: `prt_compaction${index}`,
    messageID: `msg_continue${index}`,
    sessionID: OPEN_CODE_SESSION,
    synthetic: true,
    metadata: { compaction_continue: true },
    time: { start: 1790000000000, end: 1790000000001 },
    text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
  },
});
describe('OpenCode live stream', () => {
  it('allows a stop step followed by tools or post-compaction continuation', () => {
    const events = openCodeEvents(turn);
    events[3]!.part.reason = 'stop';
    assert.equal(parseOpenCodeStream(encode(events)).text, 'Done.');
    assert.throws(
      () => parseOpenCodeStream(encode(events.slice(0, 4))),
      OpenCodeStreamError,
    );
    const summary = textStep('Compaction summary', 1);
    assert.equal(
      parseOpenCodeStream(encode([...summary, continuation(), ...events])).text,
      'Done.',
    );
    assert.throws(
      () => parseOpenCodeStream(encode([...summary, continuation()])),
      OpenCodeStreamError,
    );
  });
  it('retains assistant text before and after compaction, excluding every summary text part', () => {
    const before = textStep('Before.', 0);
    before.splice(2, 0, {
      ...before[1]!,
      part: { ...before[1]!.part, id: 'prt_before', text: 'More before.' },
    });
    const summary = textStep('Compaction summary', 1);
    summary.splice(2, 0, {
      ...summary[1]!,
      part: { ...summary[1]!.part, id: 'prt_summary', text: 'More summary.' },
    });
    const events = [
      ...before,
      ...summary,
      continuation(),
      ...openCodeEvents(turn, 2),
    ];
    const result = parseOpenCodeStream(encode(events));
    assert.equal(result.text, 'Before.\n\nMore before.\n\nDone.');
    assert.equal(result.costUsd, 0.04);
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(
      parseOpenCodeStream(encode(events.flatMap((event) => [event, event]))),
      result,
    );
  });
  it('excludes two compaction summaries in one turn without losing intervening text', () => {
    assert.equal(
      parseOpenCodeStream(
        encode([
          ...textStep('Before.', 0),
          ...textStep('First summary', 1),
          continuation(),
          ...textStep('Between.', 2),
          ...textStep('Second summary', 3),
          continuation(1),
          ...textStep('Done.', 4),
        ]),
      ).text,
      'Before.\n\nBetween.\n\nDone.',
    );
  });
  it('fails closed when a continuation cannot identify a completed, tool-free summary', () => {
    const summary = textStep('Compaction summary', 1);
    const sameMessage = continuation();
    sameMessage.part.messageID = String(summary[0]!.part.messageID);
    const toolStep = openCodeEvents(turn, 1).slice(0, 4);
    toolStep[3]!.part.reason = 'stop';
    const reusedContinuation = continuation();
    reusedContinuation.part.id = 'prt_reused';
    const retry = {
      ...toolStep[0]!,
      part: { ...toolStep[0]!.part, id: 'prt_retry' },
    };
    for (const prefix of [
      [continuation()],
      [...summary.slice(0, 2), continuation()],
      [...toolStep, continuation()],
      [...toolStep.slice(0, 3), retry, toolStep[3]!, continuation()],
      [...summary, sameMessage],
      [...summary, continuation(), continuation(1)],
      [...summary, continuation(), ...textStep('Reused summary ID', 1)],
      [...summary, continuation(), ...textStep('Done.', 2), reusedContinuation],
    ])
      assert.throws(
        () => parseOpenCodeStream(encode([...prefix, ...openCodeEvents(turn)])),
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
  it('preserves a completed tool and the reply when the same assistant message retries', () => {
    const events = openCodeEvents(turn);
    const retry = events.slice(4).map((event) => ({
      ...event,
      part: { ...event.part, messageID: events[0]!.part.messageID },
    }));
    const result = parseOpenCodeStream(
      encode([...events.slice(0, 3), ...retry]),
    );
    assert.equal(result.text, 'Done.');
    assert.equal(result.sessionId, OPEN_CODE_SESSION);
    assert.equal(result.costUsd, 0.01);
    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_0',
        name: 'bash',
        input: { command: 'printf complete > answer.txt' },
      },
    ]);
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
