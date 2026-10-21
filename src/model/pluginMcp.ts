import type { PluginSelectionV1 } from './types.ts';

/** Registered bundled connections; authentication belongs to Forge, not YAML. */
export type PluginMcpServerId = 'stripe';

const STRIPE_MCP_SERVERS: readonly PluginMcpServerId[] = Object.freeze([
  'stripe',
]);

/** Derive auth only for the supported plugin identity and marketplace pair. */
export function pluginMcpServersForDistribution(
  adapter: string,
  distribution: PluginSelectionV1 | undefined,
): readonly PluginMcpServerId[] | undefined {
  if (
    ((adapter === 'claude-code' || adapter === 'codex') &&
      distribution?.plugin === 'stripe@claude-plugins-official' &&
      distribution.marketplace === 'anthropics/claude-plugins-official') ||
    (adapter === 'codex' &&
      distribution?.plugin === 'stripe@stripe' &&
      distribution.marketplace === 'stripe/ai')
  )
    return STRIPE_MCP_SERVERS;
  return undefined;
}
