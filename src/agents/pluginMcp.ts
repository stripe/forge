import type {
  MutableWorkspace,
  PluginMcpConnections,
  ReadonlyWorkspace,
} from '../contracts/runtime.ts';
import { isSafeMcpEndpointUrl } from '../model/paths.ts';
import { PLUGIN_MCP_CREDENTIALS } from '../model/pluginCredentials.ts';
import type { PluginMcpServerId } from '../model/types.ts';

/**
 * A Codex user-level MCP server: a plain remote URL plus an environment
 * reference for its bearer token. It never holds a secret or static headers.
 * Forge points it at the run's host relay and names the relay-token variable.
 */
export type CodexMcpServerConfig = {
  readonly url: string;
  readonly bearer_token_env_var: string;
};

export type CodexMcpServerDeclarations = Readonly<
  Partial<Record<PluginMcpServerId, CodexMcpServerConfig>>
>;

/** Bundled settings the Codex relocation carries; anything else is rejected. */
const RELOCATED_SERVER_KEYS = ['type', 'url', 'bearer_token_env_var'];

/**
 * Point the plugin's bundled Claude Code connections at the run's host relay
 * without adding new servers. Upstream keys never enter the bundle.
 */
export async function configurePluginMcp(
  state: MutableWorkspace,
  root: string,
  servers: readonly PluginMcpServerId[],
  connections: PluginMcpConnections = {},
): Promise<void> {
  const { path, input } = await readPluginMcpBundle(state, root, 'claude-code');
  await state.writeFile(
    path,
    Buffer.from(
      `${JSON.stringify(configurePluginMcpDocument(input, servers, connections), null, 2)}\n`,
    ),
  );
}

/** A validated Codex relocation, prepared without changing the workspace. */
export type CodexPluginMcpRelocation = {
  readonly path: string;
  /** The bundle with the selected servers removed. */
  readonly document: Record<string, unknown>;
  /** Relay declarations written to Codex user configuration. */
  readonly declarations: CodexMcpServerDeclarations;
  /** Upstream endpoints for the receipt; never the run's relay address. */
  readonly upstream: Readonly<Partial<Record<PluginMcpServerId, string>>>;
};

/**
 * Read and fully validate the move of the selected Codex connections out of the
 * bundle. Codex re-materializes its plugin cache after startup, discarding edits
 * to the bundled file, so these connections are declared in the run-owned user
 * configuration instead. Nothing is written here.
 */
export async function prepareCodexPluginMcpRelocation(
  state: ReadonlyWorkspace,
  root: string,
  servers: readonly PluginMcpServerId[],
  relays: PluginMcpConnections = {},
): Promise<CodexPluginMcpRelocation> {
  const { path, input } = await readPluginMcpBundle(state, root, 'codex');
  return { path, ...relocateCodexPluginMcp(input, servers, relays) };
}

/** Remove the relocated servers from the bundle once they are declared. */
export async function writeRelocatedPluginMcp(
  state: MutableWorkspace,
  relocation: CodexPluginMcpRelocation,
): Promise<void> {
  await state.writeFile(
    relocation.path,
    Buffer.from(`${JSON.stringify(relocation.document, null, 2)}\n`),
  );
}

async function readPluginMcpBundle(
  state: ReadonlyWorkspace,
  root: string,
  adapter: 'claude-code' | 'codex',
): Promise<{ path: string; input: unknown }> {
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
  return { path, input };
}

/** Pure Claude Code transformation; the document holds relay capabilities only. */
export function configurePluginMcpDocument(
  input: unknown,
  servers: readonly PluginMcpServerId[],
  relays: PluginMcpConnections = {},
): Record<string, unknown> {
  const output = validatedPluginMcpDocument(input, 'claude-code', servers);
  const connections = output.mcpServers as Record<
    string,
    Record<string, unknown>
  >;
  for (const name of servers) {
    const server = connections[name]!;
    const relay = requiredRelay(relays, name);
    if (server.headers !== undefined && !record(server.headers))
      throw new Error(`Plugin MCP server ${name} has invalid headers.`);
    // Replace the whole entry: no original header, URL or option survives.
    connections[name] = {
      type: 'http',
      url: relay.url,
      headers: { Authorization: `Bearer ${relay.token}` },
    };
  }
  return output;
}

/**
 * Pure Codex transformation. Each selected server must be exactly a transport
 * type, an endpoint URL, and optionally a bearer reference that Forge replaces.
 * Everything else (`enabled`, tool allow/deny lists, timeouts, static or
 * environment headers, unknown fields) would be lost by the move, and Forge does
 * not carry it, so it is rejected before either file is touched.
 *
 * The bundled endpoint is validated and recorded as the upstream; the
 * declaration itself points at the run's relay.
 */
export function relocateCodexPluginMcp(
  input: unknown,
  servers: readonly PluginMcpServerId[],
  relays: PluginMcpConnections = {},
): {
  document: Record<string, unknown>;
  declarations: CodexMcpServerDeclarations;
  upstream: Readonly<Partial<Record<PluginMcpServerId, string>>>;
} {
  const document = validatedPluginMcpDocument(input, 'codex', servers);
  const connections = document.mcpServers as Record<
    string,
    Record<string, unknown>
  >;
  const declarations: Partial<Record<PluginMcpServerId, CodexMcpServerConfig>> =
    {};
  const upstream: Partial<Record<PluginMcpServerId, string>> = {};
  for (const name of servers) {
    const server = connections[name]!;
    const relay = requiredRelay(relays, name);
    if (Object.keys(server).some((key) => !RELOCATED_SERVER_KEYS.includes(key)))
      throw new Error(
        `Plugin MCP server ${name} has settings that Codex user configuration relocation does not carry.`,
      );
    if (
      server.bearer_token_env_var !== undefined &&
      typeof server.bearer_token_env_var !== 'string'
    )
      throw new Error(`Plugin MCP server ${name} has invalid auth.`);
    if (!isSafeMcpEndpointUrl(server.url as string))
      throw new Error(`Plugin MCP server ${name} has an unsupported URL.`);
    upstream[name] = server.url as string;
    declarations[name] = {
      url: relay.url,
      // The variable holds the per-run relay token, never the upstream key.
      bearer_token_env_var:
        PLUGIN_MCP_CREDENTIALS[name].relayTokenEnvironmentVariable,
    };
    delete connections[name];
  }
  return { document, declarations, upstream };
}

/** Clone the bundle after checking each selected connection is plain remote HTTP. */
function validatedPluginMcpDocument(
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
    if (new URL(server.url).href !== PLUGIN_MCP_CREDENTIALS[name].url)
      throw new Error(`Plugin MCP server ${name} has an unsupported URL.`);
    if (
      server.oauth !== undefined ||
      server.headersHelper !== undefined ||
      server.http_headers_helper !== undefined
    )
      throw new Error(
        `Plugin MCP server ${name} has unsupported auth configuration.`,
      );
  }
  return output;
}

function requiredRelay(relays: PluginMcpConnections, name: PluginMcpServerId) {
  const relay = relays[name];
  if (!relay)
    throw new Error(
      `Plugin MCP server ${name} requires a host credential relay.`,
    );
  return relay;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
