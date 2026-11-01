import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { AgentTokenUsage } from '../contracts/agent.ts';
import {
  agentPrices,
  agentPricingVersion,
  estimateAgentCost,
} from './index.ts';
import prices from './prices.json' with { type: 'json' };

const base: AgentTokenUsage = {
  input_tokens: 1_000_000,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 100_000,
  reasoning_tokens: null,
};
const cases: {
  name: string;
  model?: string;
  usage?: AgentTokenUsage | undefined;
  expected: number | null;
}[] = [
  { name: 'uncached input and output', expected: 4 },
  {
    name: 'cache-heavy',
    usage: { ...base, cached_input_tokens: 800_000 },
    expected: 2.2,
  },
  {
    name: '5-minute cache writes',
    model: 'claude-sonnet-4-6',
    usage: { ...base, cache_write_input_tokens: 800_000 },
    expected: 5.1,
  },
  {
    name: '30-minute OpenAI writes',
    model: 'gpt-6.1-sol',
    usage: { ...base, cache_write_input_tokens: 800_000 },
    expected: 3.4,
  },
  {
    name: 'mixed Claude TTLs',
    model: 'claude-sonnet-4-6',
    usage: {
      ...base,
      cache_write_input_tokens: 800_000,
      cache_write_5m_input_tokens: 600_000,
      cache_write_1h_input_tokens: 200_000,
    },
    expected: 5.55,
  },
  { name: 'unknown model', model: 'unlisted', expected: null },
  { name: 'missing usage', usage: undefined, expected: null },
  {
    name: 'unknown input',
    usage: { ...base, input_tokens: null },
    expected: null,
  },
  {
    name: 'unknown cache reads',
    usage: { ...base, cached_input_tokens: null },
    expected: null,
  },
  {
    name: 'unknown output',
    usage: { ...base, output_tokens: null },
    expected: null,
  },
  {
    name: 'missing writes with no separate rate',
    usage: { ...base, cache_write_input_tokens: null },
    expected: 4,
  },
  {
    name: 'missing charged writes',
    model: 'gpt-6.1-sol',
    usage: { ...base, cache_write_input_tokens: null },
    expected: null,
  },
  {
    name: 'missing charged Claude writes',
    model: 'claude-sonnet-4-6',
    usage: { ...base, cache_write_input_tokens: undefined },
    expected: null,
  },
  {
    name: 'negative uncached',
    usage: {
      ...base,
      cached_input_tokens: 900_000,
      cache_write_input_tokens: 200_000,
    },
    expected: null,
  },
  {
    name: 'inconsistent TTL sum',
    model: 'claude-sonnet-4-6',
    usage: {
      ...base,
      cache_write_input_tokens: 10,
      cache_write_5m_input_tokens: 0,
      cache_write_1h_input_tokens: 0,
    },
    expected: null,
  },
  {
    name: 'unknown TTL detail',
    model: 'claude-sonnet-4-6',
    usage: {
      ...base,
      cache_write_5m_input_tokens: null,
      cache_write_1h_input_tokens: null,
    },
    expected: null,
  },
  {
    name: 'reasoning is already billed as output',
    usage: { ...base, reasoning_tokens: 90_000 },
    expected: 4,
  },
  {
    name: 'zero is priced',
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: null,
    },
    expected: 0,
  },
];
for (const row of cases)
  it(row.name, () => {
    const usage = Object.hasOwn(row, 'usage') ? row.usage : base;
    assert.equal(
      estimateAgentCost(usage, agentPrices[row.model ?? 'gpt-5.4']),
      row.expected,
    );
  });

it('pins the price entries and hashes all table content', () => {
  assert.equal(Object.keys(prices).length, 14);
  assert.match(agentPricingVersion, /^sha256:[0-9a-f]{64}$/);
  for (const price of Object.values(prices)) {
    assert.equal(new URL(price.source_url).protocol, 'https:');
    assert.match(price.effective_date, /^\d{4}-\d{2}-\d{2}$/);
    for (const rate of [
      price.input,
      price.cache_read,
      price.cache_write,
      price.output,
    ])
      assert.ok(Number.isFinite(rate) && rate >= 0);
  }
  assert.equal(
    prices['openrouter-gemini-4-argon'].priced_model,
    'gemini-4-argon',
  );
  assert.equal(prices['gpt-6.1-sol'].cache_write, 2.5);
  assert.equal(prices['claude-opus-4-6'].cache_write_1h, 10);
  // OpenRouter-pinned entries are keyed by the exact selected model name.
  assert.equal(prices['x-ai/grok-4.7'].cache_write_policy, 'input_rate');
  assert.equal(prices['x-ai/grok-4.7'].cache_write, 2);
  assert.equal(
    prices['@preset/sonnet-5-5-anthropic-v1'].routing_model,
    'anthropic/claude-sonnet-5.5',
  );
  assert.equal(prices['@preset/sonnet-5-5-anthropic-v1'].input, 2);
});
