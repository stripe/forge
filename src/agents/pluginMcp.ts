import { credentialReference } from '../contracts/credentials.ts';
import type { MutableWorkspace } from '../contracts/runtime.ts';
import { pluginDefinitionForAgent } from '../model/plugins.ts';
import type {
  PluginMcpServerId,
  PluginSetupStepV1,
  ResolvedRunPlanV1,
} from '../model/types.ts';

/** Named server presets own auth details instead of experiment YAML. */
const PLUGIN_MCP_SERVERS = Object.freeze({
  stripe: Object.freeze({
    credentialEnvironmentVariable: 'STRIPE_API_KEY',
    credentialReference: credentialReference('env:STRIPE_API_KEY'),
  }),
});

export function pluginMcpCredentials(servers: readonly PluginMcpServerId[]) {
  return Object.fromEntries(
    servers.map((name) => {
      const server = PLUGIN_MCP_SERVERS[name];
      return [
        server.credentialEnvironmentVariable,
        { reference: server.credentialReference },
      ];
    }),
  );
}

/** Bind only registered credentials selected by plans, without reading values. */
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
        const server = PLUGIN_MCP_SERVERS[name];
        const env = server.credentialEnvironmentVariable;
        const reference = server.credentialReference;
        if (Object.hasOwn(bindings, reference) && bindings[reference] !== env) {
          throw new TypeError(
            `Plugin credential ${reference} must be bound to ${env}.`,
          );
        }
        bindings[reference] = env;
      }
    }
  return bindings;
}

/** Change one existing connection; never add a second global MCP server. */
export async function configurePluginMcp(
  state: MutableWorkspace,
  root: string,
  adapter: 'claude-code' | 'codex',
  servers: readonly PluginMcpServerId[],
): Promise<void> {
  // Native manifests can redirect MCP loading. Only the conventional bundled
  // .mcp.json contract is supported until each alternate format is exercised.
  for (const manifest of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    'plugin.json',
  ]) {
    const path = `${root}/${manifest}`;
    if ((await state.inspect(path)).kind !== 'file') continue;
    const value: unknown = JSON.parse(
      Buffer.from(
        await state.readFile(path, { maxBytes: 1024 * 1024 }),
      ).toString('utf8'),
    );
    if (manifest === 'plugin.json' && adapter === 'codex')
      throw new Error(
        'Codex Agent Plugins mcp.json does not support environment-backed bearer auth. The registered Stripe plugin requires a compatible Claude-format distribution.',
      );
    if (
      !record(value) ||
      value.mcpServers !== undefined ||
      value.mcp_servers !== undefined ||
      manifest === 'plugin.json'
    ) {
      throw new Error(
        'Plugin MCP auth requires a conventional bundled .mcp.json; manifest MCP overrides are unsupported.',
      );
    }
  }
  const path = `${root}/.mcp.json`;
  if ((await state.inspect(path)).kind !== 'file')
    throw new Error('Plugin MCP auth requires a bundled .mcp.json file.');
  const input: unknown = JSON.parse(
    Buffer.from(await state.readFile(path, { maxBytes: 1024 * 1024 })).toString(
      'utf8',
    ),
  );
  const configured = configurePluginMcpDocument(input, adapter, servers);
  await state.writeFile(
    path,
    Buffer.from(`${JSON.stringify(configured, null, 2)}\n`),
  );
}

/** Pure native-format transformation; the document contains references only. */
export function configurePluginMcpDocument(
  input: unknown,
  adapter: 'claude-code' | 'codex',
  servers: readonly PluginMcpServerId[],
): Record<string, unknown> {
  if (!record(input) || !record(input.mcpServers))
    throw new Error('Plugin .mcp.json must contain mcpServers.');
  const output = structuredClone(input);
  const connections = output.mcpServers as Record<string, unknown>;
  for (const name of servers) {
    const server = connections[name];
    if (!Object.hasOwn(connections, name) || !record(server))
      throw new Error(`Plugin MCP server ${name} is absent.`);
    if (
      (adapter === 'claude-code' && server.type !== 'http') ||
      (server.type !== 'http' &&
        server.type !== 'streamable-http' &&
        server.type !== 'streamable_http' &&
        server.type !== undefined)
    )
      throw new Error(`Plugin MCP server ${name} requires HTTP transport.`);
    if (typeof server.url !== 'string' || server.command !== undefined)
      throw new Error(`Plugin MCP server ${name} requires HTTP transport.`);
    const url = new URL(server.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(`Plugin MCP server ${name} has an unsupported URL.`);
    if (
      server.oauth !== undefined ||
      server.headersHelper !== undefined ||
      server.http_headers_helper !== undefined
    )
      throw new Error(
        `Plugin MCP server ${name} has unsupported auth configuration.`,
      );
    const environmentName =
      PLUGIN_MCP_SERVERS[name].credentialEnvironmentVariable;
    if (adapter === 'claude-code') {
      if (server.headers !== undefined && !record(server.headers))
        throw new Error(`Plugin MCP server ${name} has invalid headers.`);
      const headers = { ...(server.headers as Record<string, unknown>) };
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === 'authorization') delete headers[key];
      headers.Authorization = `Bearer \${${environmentName}}`;
      server.headers = headers;
    } else {
      for (const field of ['http_headers', 'env_http_headers']) {
        if (server[field] !== undefined && !record(server[field]))
          throw new Error(`Plugin MCP server ${name} has invalid headers.`);
        if (record(server[field]))
          for (const key of Object.keys(server[field]))
            if (key.toLowerCase() === 'authorization')
              delete server[field][key];
      }
      server.bearer_token_env_var = environmentName;
    }
  }
  return output;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
