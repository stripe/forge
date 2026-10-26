import assert from 'node:assert/strict';
import { it } from 'vitest';
import { agentTokenUsageSchema, sumAgentTokenUsage } from './agentUsage.ts';

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
