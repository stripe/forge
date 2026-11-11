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
function recoveredCleanup() {
  const events = openCodeEvents(turn);
  const [start, text, finish] = textStep(turn.response, 0);
  const retry = {
    ...start!,
    part: { ...start!.part, id: 'prt_retry' },
  };
  const cleanup = {
    ...events[2]!,
    part: {
      ...events[2]!.part,
      id: 'prt_abandoned',
      messageID: start!.part.messageID,
      callID: 'functions.bash:0',
      state: {
        status: 'error',
        input: { command: 'abandoned command' },
        error: 'Tool execution aborted',
        metadata: { interrupted: true },
        time: { start: 1790000000000, end: 1790000000001 },
      },
    },
  };
  return { start: start!, retry, text: text!, finish: finish!, cleanup };
}

function paddedEvent(event: unknown, bytes: number) {
  const base = JSON.stringify({ ...(event as object), padding: '' });
  const remaining = bytes - Buffer.byteLength(base);
  assert.ok(remaining >= 0);
  return JSON.stringify({
    ...(event as object),
    padding: 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2),
  });
}

describe('OpenCode live stream', () => {
  it.each(['pending', 'running'])(
    'rejects a nonterminal %s tool snapshot without inventing an outcome',
    (status) => {
      const events = openCodeEvents(turn);
      const toolEvent = events.find((event) => event.type === 'tool_use')!;
      toolEvent.part.state = {
        status,
        input: { command: 'sleep 600' },
        output: '',
      };
      assert.throws(
        () => parseOpenCodeStream(encode(events)),
        OpenCodeStreamError,
      );
    },
  );
  it('keeps a completed turn when optional tool output is unavailable', () => {
    const events = openCodeEvents(turn);
    const toolEvent = events.find((event) => event.type === 'tool_use')!;
    toolEvent.part.state = { status: 'completed', input: { command: 'true' } };
    const parsed = parseOpenCodeStream(encode(events));
    assert.equal(parsed.text, turn.response);
    assert.deepEqual(parsed.toolCalls[0]?.result, {
      content: '[Forge tool result unavailable.]',
      isError: false,
      truncated: true,
    });
  });
  it('accepts interrupted cleanup of an unseen tool after a recovered retry finishes', () => {
    const { start, retry, text, finish, cleanup } = recoveredCleanup();
    const events = [start, retry, text, finish, cleanup];
    const result = parseOpenCodeStream(encode(events));
    assert.equal(result.text, turn.response);
    assert.equal(result.costUsd, 0.01);
    assert.deepEqual(result.toolCalls, [
      { id: 'prt_abandoned', name: 'bash', input: cleanup.part.state.input },
    ]);
    assert.deepEqual(parseOpenCodeStream(encode([...events, cleanup])), result);
    // Cleanup after an intermediate finish must still allow the next step.
    const intermediate = {
      ...finish,
      part: { ...finish.part, reason: 'tool-calls' },
    };
    assert.equal(
      parseOpenCodeStream(
        encode([
          start,
          retry,
          text,
          intermediate,
          cleanup,
          ...textStep('Next.', 1),
        ]),
      ).text,
      'Done.\n\nNext.',
    );
  });
  it('rejects trailing events outside the abandoned retry cleanup shape', () => {
    const { start, retry, text, finish, cleanup } = recoveredCleanup();
    const prefix = [start, retry, text, finish];
    const changes = [
      { messageID: 'msg_unrelated' },
      { sessionID: 'ses_other' },
      { type: 'text', text: 'Late text' },
      { type: 'reasoning', text: 'Late reasoning' },
      { type: 'step-finish', reason: 'stop', cost: 0 },
      { state: { ...cleanup.part.state, status: 'completed' } },
      { state: { ...cleanup.part.state, status: 'running' } },
      { state: { ...cleanup.part.state, error: 'Ordinary tool error' } },
      { state: { ...cleanup.part.state, metadata: {} } },
      { state: { ...cleanup.part.state, metadata: { interrupted: 'true' } } },
    ];
    const completedTool = {
      ...cleanup,
      part: {
        ...cleanup.part,
        state: { status: 'completed', input: {}, output: 'Finished' },
      },
    };
    const invalid = [
      [start, text, finish, cleanup],
      [start, retry, text, cleanup],
      [start, completedTool, retry, text, finish, cleanup],
      [...prefix, textStep('Next.', 1)[0], cleanup],
      // A retry in an earlier message does not authorize cleanup in a new one.
      [
        ...prefix,
        ...textStep('Next.', 1),
        {
          ...cleanup,
          part: { ...cleanup.part, messageID: 'msg_final1' },
        },
      ],
      [...prefix, { ...cleanup, type: 'unknown' }],
      ...changes.map((change) => [
        ...prefix,
        { ...cleanup, part: { ...cleanup.part, ...change } },
      ]),
    ];
    for (const events of invalid)
      assert.throws(
        () => parseOpenCodeStream(encode(events)),
        OpenCodeStreamError,
      );
  });
  it('accepts opaque gateway IDs while keeping native identities path-safe', () => {
    for (const callID of [
      'functions.bash:0',
      '/gateway/call?index=0',
      'x'.repeat(4_096),
    ]) {
      const events = openCodeEvents(turn);
      events[2]!.part.callID = callID;
      assert.equal(
        parseOpenCodeStream(encode(events)).toolCalls[0]!.id,
        'prt_tool0',
      );
    }
    for (const callID of [
      '',
      0,
      null,
      'x'.repeat(4_097),
      'SECRET\n',
      'a\u007f',
      'a\u0085',
    ]) {
      const events = openCodeEvents(turn);
      events[2]!.part.callID = callID;
      assert.throws(
        () => parseOpenCodeStream(encode(events)),
        OpenCodeStreamError,
      );
    }
    for (const key of ['id', 'messageID', 'sessionID']) {
      const events = openCodeEvents(turn);
      events[2]!.part[key] = 'functions.bash:0';
      assert.throws(
        () => parseOpenCodeStream(encode(events)),
        OpenCodeStreamError,
      );
    }
  });
  it('retains separate executions when gateway IDs repeat within a step, retry, or turn', () => {
    const events = openCodeEvents(turn);
    const second = {
      ...events[2]!,
      part: {
        ...events[2]!.part,
        id: 'prt_second',
        state: {
          status: 'completed',
          input: { command: 'second' },
          output: 'Second result',
        },
      },
    };
    const retry = {
      ...events[0]!,
      part: { ...events[0]!.part, id: 'prt_retry' },
    };
    for (const middle of [[second], [retry, second]]) {
      const result = parseOpenCodeStream(
        encode([...events.slice(0, 3), ...middle, ...events.slice(3)]),
      );
      assert.deepEqual(
        result.toolCalls.map(({ id }) => id),
        ['prt_tool0', 'prt_second'],
      );
      assert.deepEqual(result.toolCalls[1]!.input, { command: 'second' });
    }
    const next = openCodeEvents(turn, 1);
    next[2]!.part.callID = events[2]!.part.callID;
    assert.deepEqual(
      parseOpenCodeStream(encode([...events, ...next])).toolCalls.map(
        ({ id }) => id,
      ),
      ['prt_tool0', 'prt_tool1'],
    );
    const changed = { ...second, part: { ...second.part, id: 'prt_tool0' } };
    assert.throws(
      () => parseOpenCodeStream(encode([...events, changed])),
      OpenCodeStreamError,
    );
  });
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
        id: 'prt_tool0',
        name: 'bash',
        input: { command: 'printf complete > answer.txt' },
        result: { content: 'Wrote answer.txt.', isError: false },
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
        id: 'prt_tool0',
        name: 'bash',
        input: { command: 'printf complete > answer.txt' },
        result: { content: 'Command failed.', isError: true },
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
  it('bounds individual JSON lines in UTF-8 bytes with inclusive limits', () => {
    const events = openCodeEvents(turn);
    const stream = (bytes: number) =>
      [
        paddedEvent(events[0], bytes),
        ...events.slice(1).map((event) => JSON.stringify(event)),
      ].join('\n');
    assert.equal(parseOpenCodeStream(stream(1024 * 1024)).text, turn.response);
    assert.throws(
      () => parseOpenCodeStream(stream(1024 * 1024 + 1)),
      OpenCodeStreamError,
    );
  });
  it('bounds whole streams of valid events below the per-line limit in UTF-8 bytes', () => {
    const events = openCodeEvents(turn);
    const repeated = paddedEvent(events[0], 512 * 1024);
    const prefix = `${Array(31).fill(repeated).join('\n')}\n`;
    const suffix = `\n${encode(events.slice(1))}`;
    const remaining = 16 * 1024 * 1024 - Buffer.byteLength(prefix + suffix);
    assert.ok(remaining < 1024 * 1024);
    const stream = (extra: number) =>
      prefix + paddedEvent(events[0], remaining + extra) + suffix;
    assert.equal(parseOpenCodeStream(stream(0)).text, turn.response);
    assert.throws(() => parseOpenCodeStream(stream(1)), OpenCodeStreamError);
  });
  it('bounds recursive JSON inside otherwise valid events', () => {
    const events = openCodeEvents(turn);
    const stream = (depth: number) => {
      let padding: unknown = 0;
      for (let index = 0; index < depth; index++) padding = { nested: padding };
      return encode([{ ...events[0], padding }, ...events.slice(1)]);
    };
    assert.equal(parseOpenCodeStream(stream(32)).text, turn.response);
    assert.throws(() => parseOpenCodeStream(stream(100)), OpenCodeStreamError);
  });
});
