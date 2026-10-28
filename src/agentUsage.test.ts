import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  agentTokenUsageSchema,
  observeAgentTokenUsage,
  sumAgentTokenUsage,
  sumObservedTokens,
} from './agentUsage.ts';

it('distinguishes absent usage, unknown counters and recorded zero across turns', () => {
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 8,
    output_tokens: 4,
    reasoning_tokens: null,
  };
  assert.equal(sumAgentTokenUsage([undefined, undefined]), undefined);
  assert.deepEqual(sumAgentTokenUsage([usage, usage]), {
    input_tokens: 20,
    cached_input_tokens: 16,
    output_tokens: 8,
    reasoning_tokens: null,
  });
  assert.deepEqual(sumAgentTokenUsage([usage, undefined]), {
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
  });
  assert.equal(
    sumAgentTokenUsage([
      { ...usage, input_tokens: Number.MAX_SAFE_INTEGER },
      usage,
    ])!.input_tokens,
    null,
  );
  for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      agentTokenUsageSchema.safeParse({ ...usage, input_tokens: value })
        .success,
      false,
    );
  assert.equal(
    agentTokenUsageSchema.safeParse({ ...usage, extra: 1 }).success,
    false,
  );
});

it('degrades untrusted usage and unsafe native sums without weakening the saved schema', () => {
  for (const value of [
    null,
    [],
    1,
    { input_tokens: 1.5 },
    {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_tokens: null,
      extra: true,
    },
  ])
    assert.deepEqual(observeAgentTokenUsage(value), {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
    });
  for (const value of [-1, 1.5, Infinity, '2', null, undefined])
    assert.equal(sumObservedTokens(0, value), null);
  assert.equal(sumObservedTokens(Number.MAX_SAFE_INTEGER, 1), null);
  assert.equal(sumObservedTokens(1, 2), 3);
});

it('accepts older usage without writes and rejects invalid or unknown write fields', () => {
  const old = {
    input_tokens: 10,
    cached_input_tokens: 8,
    output_tokens: 4,
    reasoning_tokens: null,
  };
  assert.deepEqual(agentTokenUsageSchema.parse(old), old);
  for (const key of [
    'cache_write_input_tokens',
    'cache_write_5m_input_tokens',
    'cache_write_1h_input_tokens',
  ]) {
    assert.equal(
      agentTokenUsageSchema.safeParse({ ...old, [key]: -1 }).success,
      false,
    );
    assert.equal(
      agentTokenUsageSchema.safeParse({ ...old, [key]: null }).success,
      true,
    );
  }
  assert.equal(
    sumAgentTokenUsage([{ ...old, cache_write_input_tokens: 2 }, old])!
      .cache_write_input_tokens,
    null,
  );
});
