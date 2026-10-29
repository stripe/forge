import { credentialReference } from '../contracts/credentials.ts';
import type { PluginMcpServerId } from './types.ts';

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
