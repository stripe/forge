import type { MutableWorkspace } from '../contracts/runtime.ts';
import { PLUGIN_MCP_CREDENTIALS } from '../model/pluginCredentials.ts';
import type { PluginMcpServerId } from '../model/types.ts';

/** A Codex user-level MCP server; it holds an environment reference, never a secret. */
export type CodexMcpServerConfig = {
  readonly url: string;
  readonly bearer_token_env_var: string;
  readonly http_headers?: Readonly<Record<string, string>>;
  readonly env_http_headers?: Readonly<Record<string, string>>;
};

export type CodexMcpServerDeclarations = Readonly<
  Partial<Record<PluginMcpServerId, CodexMcpServerConfig>>
>;

/**
 * Authenticate the plugin's bundled connections without adding new servers.
 *
 * Claude Code reads the rewritten bundled file. Codex re-materializes its plugin
 * cache after startup, discarding edits to that file, so its connections are
 * removed from the bundle and returned for declaration in the run-owned user
 * configuration instead.
 */
export async function configurePluginMcp(
  state: MutableWorkspace,
  root: string,
  adapter: 'claude-code' | 'codex',
  servers: readonly PluginMcpServerId[],
): Promise<CodexMcpServerDeclarations> {
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
  const { document, declarations } =
    adapter === 'claude-code'
      ? {
          document: configurePluginMcpDocument(input, servers),
          declarations: {},
        }
      : relocateCodexPluginMcp(input, servers);
  await state.writeFile(
    path,
    Buffer.from(`${JSON.stringify(document, null, 2)}\n`),
  );
  return declarations;
}

/** Pure Claude Code transformation; the document contains references only. */
export function configurePluginMcpDocument(
  input: unknown,
  servers: readonly PluginMcpServerId[],
): Record<string, unknown> {
  const output = validatedPluginMcpDocument(input, 'claude-code', servers);
  const connections = output.mcpServers as Record<
    string,
    Record<string, unknown>
  >;
  for (const name of servers) {
    const server = connections[name]!;
    if (server.headers !== undefined && !record(server.headers))
      throw new Error(`Plugin MCP server ${name} has invalid headers.`);
    const headers = { ...(server.headers as Record<string, unknown>) };
    for (const key of Object.keys(headers))
      if (key.toLowerCase() === 'authorization') delete headers[key];
    headers.Authorization = `Bearer \${${PLUGIN_MCP_CREDENTIALS[name].credentialEnvironmentVariable}}`;
    server.headers = headers;
  }
  return output;
}

/** Pure Codex transformation: move each selected connection to user configuration. */
export function relocateCodexPluginMcp(
  input: unknown,
  servers: readonly PluginMcpServerId[],
): {
  document: Record<string, unknown>;
  declarations: CodexMcpServerDeclarations;
} {
  const document = validatedPluginMcpDocument(input, 'codex', servers);
  const connections = document.mcpServers as Record<
    string,
    Record<string, unknown>
  >;
  const declarations: Partial<Record<PluginMcpServerId, CodexMcpServerConfig>> =
    {};
  for (const name of servers) {
    const server = connections[name]!;
    const headers: Partial<
      Record<'http_headers' | 'env_http_headers', Record<string, string>>
    > = {};
    for (const field of ['http_headers', 'env_http_headers'] as const) {
      const value = server[field];
      if (value === undefined) continue;
      if (
        !record(value) ||
        Object.values(value).some((header) => typeof header !== 'string')
      )
        throw new Error(`Plugin MCP server ${name} has invalid headers.`);
      const retained = Object.fromEntries(
        Object.entries(value as Record<string, string>).filter(
          ([key]) => key.toLowerCase() !== 'authorization',
        ),
      );
      if (Object.keys(retained).length) headers[field] = retained;
    }
    declarations[name] = {
      url: server.url as string,
      bearer_token_env_var:
        PLUGIN_MCP_CREDENTIALS[name].credentialEnvironmentVariable,
      ...headers,
    };
    delete connections[name];
  }
  return { document, declarations };
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
  }
  return output;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
