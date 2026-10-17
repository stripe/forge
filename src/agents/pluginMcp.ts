import { credentialReference } from '../contracts/credentials.ts';
import type { MutableWorkspace } from '../contracts/runtime.ts';
import type {
  PluginMcpServerV1,
  PluginSetupStepV1,
  ResolvedRunPlanV1,
} from '../model/types.ts';

/** Host names are separate from runtime names so keys cannot replace PATH/HOME. */
export function pluginMcpTokenEnvironment(name: string): string {
  return `FORGE_MCP_BEARER_${name}`;
}

export function pluginMcpCredentials(
  servers: Readonly<Record<string, PluginMcpServerV1>>,
) {
  return Object.fromEntries(
    Object.values(servers).map(({ bearer_token: { env } }) => [
      pluginMcpTokenEnvironment(env),
      { reference: credentialReference(`env:${env}`) },
    ]),
  );
}

/** Bind only references declared by selected plans; never infer host variables. */
export function pluginMcpEnvironmentBindings(
  plans: readonly ResolvedRunPlanV1[],
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const bindings = { ...explicit };
  for (const plan of plans)
    for (const step of plan.setup) {
      if (step.uses !== 'forge/plugin') continue;
      for (const {
        bearer_token: { env },
      } of Object.values((step as PluginSetupStepV1).with.mcp_servers ?? {})) {
        const reference = `env:${env}`;
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
  servers: Readonly<Record<string, PluginMcpServerV1>>,
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
    if (
      !record(value) ||
      value.mcpServers !== undefined ||
      value.mcp_servers !== undefined ||
      (manifest === 'plugin.json' && value.mcp !== undefined)
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
  servers: Readonly<Record<string, PluginMcpServerV1>>,
): Record<string, unknown> {
  if (!record(input) || !record(input.mcpServers))
    throw new Error('Plugin .mcp.json must contain mcpServers.');
  const output = structuredClone(input);
  const connections = output.mcpServers as Record<string, unknown>;
  for (const [name, configuration] of Object.entries(servers)) {
    const server = connections[name];
    if (!Object.hasOwn(connections, name) || !record(server))
      throw new Error(`Plugin MCP server ${name} is absent.`);
    if (
      server.type !== 'http' &&
      server.type !== 'streamable-http' &&
      server.type !== 'streamable_http' &&
      server.type !== undefined
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
    if (server.oauth !== undefined || server.http_headers_helper !== undefined)
      throw new Error(
        `Plugin MCP server ${name} has unsupported auth configuration.`,
      );
    const environmentName = pluginMcpTokenEnvironment(
      configuration.bearer_token.env,
    );
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
