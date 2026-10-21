import { credentialReference } from '../contracts/credentials.ts';
import { pluginDefinitionForAgent } from './plugins.ts';
import type {
  PluginMcpServerId,
  PluginSetupStepV1,
  ResolvedRunPlanV1,
} from './types.ts';

/** Code-owned credential policy; native adapters use the runtime name. */
export const PLUGIN_MCP_CREDENTIALS = Object.freeze({
  stripe: Object.freeze({
    credentialEnvironmentVariable: 'STRIPE_API_KEY',
    credentialReference: credentialReference('env:STRIPE_API_KEY'),
  }),
});

export function pluginMcpCredentials(servers: readonly PluginMcpServerId[]) {
  return Object.fromEntries(
    servers.map((name) => {
      const server = PLUGIN_MCP_CREDENTIALS[name];
      return [
        server.credentialEnvironmentVariable,
        { reference: server.credentialReference },
      ];
    }),
  );
}

/** Default selected credentials to their runtime names; explicit host bindings win. */
export function pluginMcpEnvironmentBindings(
  plans: readonly ResolvedRunPlanV1[],
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const bindings = { ...explicit };
  for (const plan of plans)
    for (const step of plan.setup) {
      if (step.uses !== 'forge/plugin') continue;
      const definition = pluginDefinitionForAgent(
        (step as PluginSetupStepV1).with.plugin,
        plan.agent.adapter,
      );
      for (const name of definition?.mcpServers ?? []) {
        const server = PLUGIN_MCP_CREDENTIALS[name];
        if (!Object.hasOwn(bindings, server.credentialReference))
          bindings[server.credentialReference] =
            server.credentialEnvironmentVariable;
      }
    }
  return bindings;
}
