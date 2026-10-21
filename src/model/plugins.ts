import type { PluginSelectionV1, PluginSetupWithV1 } from './types.ts';

export type PluginMcpServerId = 'stripe';

interface PluginDefinition {
  readonly distribution: Readonly<PluginSelectionV1>;
  readonly mcpServers: readonly PluginMcpServerId[];
}

const STRIPE_PLUGIN: PluginDefinition = Object.freeze({
  distribution: Object.freeze({
    plugin: 'stripe@claude-plugins-official',
    marketplace: 'anthropics/claude-plugins-official',
  }),
  mcpServers: Object.freeze(['stripe'] as const),
});

/** One code-owned mapping shared by setup, credentials, and receipt verification. */
export function pluginDefinitionForAgent(
  plugin: PluginSetupWithV1['plugin'],
  adapter: string,
): PluginDefinition | undefined {
  if (plugin === 'stripe' && (adapter === 'claude-code' || adapter === 'codex'))
    return STRIPE_PLUGIN;
  return undefined;
}
