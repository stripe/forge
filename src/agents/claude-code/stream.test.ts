import assert from 'node:assert/strict';
import { it } from 'vitest';
import { ClaudeStreamError, parseClaudeStream } from './stream.ts';

it('ignores bounded banner and primitive noise while retaining terminal text, calls, and valid cost', () => {
  const stream = [
    'Claude banner',
    '',
    'null',
    '42',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'intermediate text' },
          { type: 'tool_use', name: 'Read' },
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'Write',
            input: { file: 'x' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      session_id: 'selected',
      result: 'final text',
      total_cost_usd: 0.01,
    }),
  ].join('\n');
  assert.deepEqual(parseClaudeStream(stream), {
    text: 'final text',
    sessionId: 'selected',
    toolCalls: [
      { name: 'Read' },
      { id: 'call-1', name: 'Write', input: { file: 'x' } },
    ],
    costUsd: 0.01,
  });
  assert.equal(
    parseClaudeStream(
      JSON.stringify({
        type: 'result',
        session_id: 'selected',
        result: 'done',
        total_cost_usd: 0,
      }),
    ).costUsd,
    0,
  );
  assert.deepEqual(
    parseClaudeStream(
      [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'fallback text' }] },
        }),
        JSON.stringify({
          type: 'result',
          session_id: 'selected',
          total_cost_usd: -1,
        }),
      ].join('\n'),
    ),
    { text: 'fallback text', sessionId: 'selected', toolCalls: [] },
  );
});

it('rejects absent or unsafe terminal identity with safe structured errors', () => {
  for (const sessionId of [undefined, '../secret-session', 'a'.repeat(129)]) {
    assert.throws(
      () =>
        parseClaudeStream(
          JSON.stringify({
            type: 'result',
            session_id: sessionId,
            result: 'secret-result',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeStreamError);
        assert.equal(error.name, 'ClaudeStreamError');
        assert.equal(error.code, 'invalid_claude_stream');
        assert.equal(
          error.message,
          'Claude produced no valid terminal session ID.',
        );
        return true;
      },
    );
  }
});

it('bounds line count and UTF-8 line bytes before consuming untrusted output', () => {
  const terminal = JSON.stringify({
    type: 'result',
    session_id: 'selected',
    result: 'done',
  });
  assert.equal(
    parseClaudeStream(`${'\n'.repeat(99_999)}${terminal}`).text,
    'done',
  );
  assert.throws(() => parseClaudeStream(`${'\n'.repeat(100_000)}${terminal}`), {
    name: 'ClaudeStreamError',
    code: 'invalid_claude_stream',
    message: 'Claude output exceeded its line limit.',
  });
  assert.throws(
    () => parseClaudeStream(`${'é'.repeat(524_289)}\n${terminal}`),
    {
      name: 'ClaudeStreamError',
      code: 'invalid_claude_stream',
      message: 'Claude output contained an oversized line.',
    },
  );
});

it('rejects excess tool calls rather than truncating the observed driver activity', () => {
  const stdout = JSON.stringify({
    type: 'assistant',
    message: {
      content: Array.from({ length: 2_001 }, (_, index) => ({
        type: 'tool_use',
        name: 'Read',
        id: `call-${index}`,
      })),
    },
  });
  assert.throws(() => parseClaudeStream(stdout), {
    name: 'ClaudeStreamError',
    code: 'invalid_claude_stream',
    message: 'Claude output exceeded its tool-call limit.',
  });
});

it('uses terminal invocation usage once, includes cache reads and writes in input, and leaves reasoning unknown', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 8,
    cache_creation_input_tokens: 2,
  };
  const terminal = {
    type: 'result',
    session_id: 'selected',
    result: 'done',
    usage,
  };
  const parsed = parseClaudeStream(
    [{ type: 'assistant', message: { usage, content: [] } }, terminal]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  assert.deepEqual(parsed.usage, {
    input_tokens: 20,
    cached_input_tokens: 8,
    output_tokens: 4,
    reasoning_tokens: null,
  });
  assert.deepEqual(
    parseClaudeStream(
      JSON.stringify({ ...terminal, usage: { input_tokens: 0 } }),
    ).usage,
    {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
    },
  );
  for (const invalid of [
    null,
    { input_tokens: -1 },
    { output_tokens: 0.5 },
    { cache_creation_input_tokens: '2' },
  ]) {
    assert.throws(
      () => parseClaudeStream(JSON.stringify({ ...terminal, usage: invalid })),
      ClaudeStreamError,
    );
  }
});
