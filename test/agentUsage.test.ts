import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { parseClaudeStream } from '../src/agents/claude-code/stream.ts';
import { parseCodexStream } from '../src/agents/codex/stream.ts';
import { parseOpenCodeStream } from '../src/agents/opencode/stream.ts';
import { sumAgentTokenUsage } from '../src/agentUsage.ts';
import { openCodeEvents } from './support/opencode.ts';

const native = JSON.parse(
  readFileSync(
    new URL('./fixtures/agent-usage/native.json', import.meta.url),
    'utf8',
  ),
);

it('retains realistic Codex read/write counters without adding them to inclusive input', () => {
  const usage = parseCodexStream(
    [
      {
        type: 'thread.started',
        thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      },
      { type: 'turn.started' },
      { type: 'turn.completed', usage: native.codex },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  ).usage;
  assert.deepEqual(usage, {
    input_tokens: 184320,
    cached_input_tokens: 147456,
    cache_write_input_tokens: 16384,
    output_tokens: 4096,
    reasoning_tokens: 3072,
  });
});

it('normalizes Claude exclusive input and preserves native cache TTLs across turns', () => {
  const parse = (usage: unknown) =>
    parseClaudeStream(
      JSON.stringify({
        type: 'result',
        session_id: 'usage-fixture',
        result: 'Done.',
        usage,
      }),
    ).usage!;
  const usage = parse(native.claude);
  assert.deepEqual(usage, {
    input_tokens: 268884,
    cached_input_tokens: 234560,
    cache_write_input_tokens: 32500,
    cache_write_5m_input_tokens: 25000,
    cache_write_1h_input_tokens: 7500,
    output_tokens: 6842,
    reasoning_tokens: null,
  });
  const total = sumAgentTokenUsage([usage, usage])!;
  assert.equal(total.cache_write_input_tokens, 65000);
  assert.equal(total.cache_write_1h_input_tokens, 15000);
  const { cache_creation: _, ...withoutSplit } = native.claude;
  assert.equal(parse(withoutSplit).cache_write_1h_input_tokens, undefined);
  assert.equal(
    parse({ ...withoutSplit, cache_creation: {} }).cache_write_1h_input_tokens,
    null,
  );
  assert.equal(
    sumAgentTokenUsage([usage, parse(withoutSplit)])!
      .cache_write_1h_input_tokens,
    null,
  );
});

it('normalizes OpenCode exclusive input, writes and separate reasoning once per step', () => {
  const events = openCodeEvents({
    prompt: 'Implement the task',
    response: 'Done.',
  });
  for (const event of events)
    if (event.type === 'step_finish') event.part.tokens = native.opencode;
  const usage = parseOpenCodeStream(
    events.map((event) => JSON.stringify(event)).join('\n'),
  ).usage;
  assert.deepEqual(usage, {
    input_tokens: 537768,
    cached_input_tokens: 469120,
    cache_write_input_tokens: 65000,
    output_tokens: 12288,
    reasoning_tokens: 8192,
  });
});
