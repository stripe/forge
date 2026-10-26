import { z } from 'zod';
import type { AgentTokenUsage } from './contracts/agent.ts';

const tokens = z.number().int().nonnegative().safe().nullable();
export const agentTokenUsageSchema = z
  .object({
    input_tokens: tokens,
    cached_input_tokens: tokens,
    output_tokens: tokens,
    reasoning_tokens: tokens,
  })
  .strict();

/** A missing counter in any turn leaves that eval's total unknown. */
export function sumAgentTokenUsage(
  usages: readonly (AgentTokenUsage | undefined)[],
): AgentTokenUsage | undefined {
  if (!usages.some((usage) => usage !== undefined)) return undefined;
  const total: Record<keyof AgentTokenUsage, number | null> = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
  };
  for (const usage of usages) {
    for (const key of Object.keys(total) as (keyof AgentTokenUsage)[]) {
      const value = usage?.[key];
      const previous = total[key];
      const sum = value == null || previous === null ? null : previous + value;
      total[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
    }
  }
  return agentTokenUsageSchema.parse(total);
}
