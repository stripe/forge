import { z } from 'zod';
import type { PluginSelectionV1 } from './types.ts';

/** Registered bundled connections; authentication belongs to Forge, not YAML. */
export const PluginMcpServerSchema = z.enum(['stripe']);
export type PluginMcpServerId = z.infer<typeof PluginMcpServerSchema>;

export const PluginMcpServersSchema = z
  .array(PluginMcpServerSchema)
  .min(1)
  .max(100)
  .refine(
    (servers) => new Set(servers).size === servers.length,
    'must not repeat an MCP server',
  );

const STRIPE_MCP_SERVERS: readonly PluginMcpServerId[] = Object.freeze([
  'stripe',
]);

/** Derive auth only for the supported plugin identity and marketplace pair. */
export function pluginMcpServersForDistribution(
  adapter: string,
  distribution: PluginSelectionV1 | undefined,
): readonly PluginMcpServerId[] | undefined {
  if (
    (adapter === 'claude-code' &&
      distribution?.plugin === 'stripe@claude-plugins-official' &&
      distribution.marketplace === 'anthropics/claude-plugins-official') ||
    (adapter === 'codex' &&
      distribution?.plugin === 'stripe@stripe' &&
      distribution.marketplace === 'stripe/ai')
  )
    return STRIPE_MCP_SERVERS;
  return undefined;
}
