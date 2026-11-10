import { agentTokenUsageSchema } from '../agentUsage.ts';
import type { AgentTokenUsage } from '../contracts/agent.ts';
import { sha256Digest } from '../model/hashes.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import prices from './prices.json' with { type: 'json' };

/** Rates in USD per million tokens, with an explicit missing-write policy. */
export interface AgentPrice {
  readonly input: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly cache_write_1h?: number;
  readonly output: number;
  readonly cache_write_policy: string;
}

export const agentPrices: Readonly<Record<string, AgentPrice>> = Object.freeze(
  Object.fromEntries(
    Object.entries(prices).map(([model, price]) => [
      model,
      Object.freeze(price),
    ]),
  ),
);
/** Hash the canonical table, including source and policy metadata. */
export const agentPricingVersion = sha256Digest(serializeCanonicalJson(prices));

/** Agent telemetry is observational: incomplete or inconsistent usage is unpriced. */
export function estimateAgentCost(
  usage: AgentTokenUsage | undefined,
  price: AgentPrice | undefined,
): number | null {
  if (price === undefined) return null;
  const parsed = agentTokenUsageSchema.safeParse(usage);
  if (!parsed.success) return null;
  const counters = parsed.data;
  const input = counters.input_tokens;
  const read = counters.cached_input_tokens;
  const output = counters.output_tokens;
  const write =
    counters.cache_write_input_tokens ??
    (price.cache_write_policy === 'input_rate' &&
    price.cache_write === price.input
      ? 0
      : null);
  if (input === null || read === null || output === null || write === null)
    return null;
  const uncached = input - read - write;
  if (uncached < 0) return null;
  let writeCost = write * price.cache_write;
  if (
    price.cache_write_1h !== undefined &&
    (counters.cache_write_5m_input_tokens !== undefined ||
      counters.cache_write_1h_input_tokens !== undefined)
  ) {
    const short = counters.cache_write_5m_input_tokens;
    const long = counters.cache_write_1h_input_tokens;
    if (short == null || long == null || short + long !== write) return null;
    writeCost = short * price.cache_write + long * price.cache_write_1h;
  }
  const cost =
    (uncached * price.input +
      read * price.cache_read +
      writeCost +
      output * price.output) /
    1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
