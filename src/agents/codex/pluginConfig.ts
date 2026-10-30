import path from 'node:path';
import { stringify } from '@iarna/toml';
import { parse } from 'toml';

import type { MutableWorkspace } from '../../contracts/runtime.ts';
import { isSha256Digest } from '../../model/hashes.ts';
import { isSafeMcpEndpointUrl, isSafeSimpleIdentifier } from '../../model/paths.ts';
import type {
  CodexMcpServerConfig,
  CodexMcpServerDeclarations,
} from '../pluginMcp.ts';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_DEPTH = 64;
const MAX_ENTRIES = 10_000;

/** Preserve native plugin/hook state; never inherit provider or auth settings. */
export async function prepareCodexPluginConfiguration(
  home: MutableWorkspace,
): Promise<void> {
  const config = await readSanitizedConfiguration(home);
  if (config) await writeConfiguration(home, config);
}

/**
 * Declare Forge-owned MCP connections in user configuration, which Codex's
 * plugin startup sync leaves intact; values are environment references only.
 */
export async function declareCodexMcpServers(
  home: MutableWorkspace,
  servers: CodexMcpServerDeclarations,
): Promise<void> {
  const config = (await readSanitizedConfiguration(home)) ?? {
    marketplaces: {},
    plugins: {},
  };
  const mcpServers = { ...config.mcp_servers };
  for (const [name, server] of Object.entries(servers)) {
    if (!isSafeSimpleIdentifier(name) || !server || !safeMcpServer(server))
      invalid();
    const existing = Object.hasOwn(mcpServers, name)
      ? mcpServers[name]
      : undefined;
    // An identical repeat is harmless; silently replacing a connection is not.
    if (
      existing &&
      (existing.url !== server.url ||
        existing.bearer_token_env_var !== server.bearer_token_env_var)
    )
      throw new Error(
        'Codex MCP server conflicts with an existing declaration of the same name.',
      );
    mcpServers[name] = { ...server };
  }
  await writeConfiguration(home, {
    ...config,
    ...(Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {}),
  });
}

type SanitizedConfiguration = {
  readonly marketplaces: Record<string, Record<string, string>>;
  readonly plugins: Record<string, { enabled: boolean }>;
  readonly projects?: Record<string, { trust_level: string }>;
  readonly hooks?: { state: Record<string, Record<string, boolean | string>> };
  readonly mcp_servers?: Record<string, CodexMcpServerConfig>;
};

async function writeConfiguration(
  home: MutableWorkspace,
  config: SanitizedConfiguration,
): Promise<void> {
  // Hold the result to the limits the next read enforces, before writing.
  if (Object.keys(config.mcp_servers ?? {}).length > MAX_ENTRIES) invalid();
  const body = Buffer.from(stringify(config));
  if (body.byteLength > MAX_CONFIG_BYTES) invalid();
  await home.writeFile('config.toml', body, { mode: 0o600 });
}

async function readSanitizedConfiguration(
  home: MutableWorkspace,
): Promise<SanitizedConfiguration | undefined> {
  const inspected = await home.inspect('config.toml');
  if (inspected.kind === 'absent') return undefined;
  if (inspected.kind !== 'file')
    throw new Error('Codex configuration must be a regular file.');
  let config: Record<string, unknown>;
  try {
    const source = Buffer.from(
      await home.readFile('config.toml', { maxBytes: MAX_CONFIG_BYTES }),
    ).toString('utf8');
    assertBoundedKeyPaths(source);
    // This parser counts the scalar leaf as a level as well as its containers.
    config = parse(source, {
      maxDepth: MAX_CONFIG_DEPTH + 1,
      bigint: true,
    }) as Record<string, unknown>;
    assertSafeConfiguration(config);
  } catch {
    // Parser errors may quote credential-bearing source lines.
    throw new Error(
      'Codex configuration is malformed or exceeds its byte limit.',
    );
  }
  const marketplaces: Record<string, Record<string, string>> = Object.create(
    null,
  ) as Record<string, Record<string, string>>;
  for (const [name, value] of entries(config.marketplaces)) {
    if (!isSafeSimpleIdentifier(name) || !record(value)) invalid();
    const keys = Object.keys(value);
    if (
      keys.some((key) => !['source_type', 'source', 'ref'].includes(key)) ||
      typeof value.source !== 'string' ||
      !bounded(value.source)
    )
      invalid();
    if (value.source_type === 'local') {
      if (
        !value.source.startsWith('/') ||
        path.posix.normalize(value.source) !== value.source ||
        value.source.includes('\\') ||
        value.source === '/' ||
        value.ref !== undefined
      )
        invalid();
    } else if (value.source_type === 'git') {
      if (
        !safeGitUrl(value.source) ||
        (value.ref !== undefined &&
          (typeof value.ref !== 'string' || !bounded(value.ref)))
      )
        invalid();
    } else invalid();
    marketplaces[name] = Object.fromEntries(
      keys.sort().map((key) => [key, value[key] as string]),
    );
  }
  const plugins: Record<string, { enabled: boolean }> = Object.create(
    null,
  ) as Record<string, { enabled: boolean }>;
  for (const [id, value] of entries(config.plugins)) {
    if (
      !qualifiedPluginId(id) ||
      !record(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.enabled !== 'boolean'
    )
      invalid();
    plugins[id] = { enabled: value.enabled };
  }
  // Codex persists project trust at thread start but does not repeat that
  // initialization on resume. Preserve its native state so workspace hooks
  // and project configuration retain the same lifecycle on later turns.
  const projects: Record<string, { trust_level: string }> = Object.create(
    null,
  ) as Record<string, { trust_level: string }>;
  for (const [projectPath, value] of entries(config.projects)) {
    if (
      !bounded(projectPath) ||
      !projectPath.startsWith('/') ||
      projectPath.includes('\\') ||
      path.posix.normalize(projectPath) !== projectPath ||
      !record(value) ||
      Object.keys(value).length !== 1 ||
      !['trusted', 'untrusted'].includes(value.trust_level as string)
    )
      invalid();
    projects[projectPath] = { trust_level: value.trust_level as string };
  }
  if (config.hooks !== undefined && !record(config.hooks)) invalid();
  const hookStates: Record<
    string,
    Record<string, boolean | string>
  > = Object.create(null) as Record<string, Record<string, boolean | string>>;
  for (const [id, value] of entries(
    record(config.hooks) ? config.hooks.state : undefined,
  )) {
    if (
      !bounded(id) ||
      !record(value) ||
      Object.keys(value).some(
        (key) => !['enabled', 'trusted_hash'].includes(key),
      ) ||
      (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
      (value.trusted_hash !== undefined &&
        (typeof value.trusted_hash !== 'string' ||
          !isSha256Digest(value.trusted_hash)))
    )
      invalid();
    hookStates[id] = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key] as boolean | string]),
    );
  }
  const mcpServers: Record<string, CodexMcpServerConfig> = Object.create(
    null,
  ) as Record<string, CodexMcpServerConfig>;
  for (const [name, value] of entries(config.mcp_servers)) {
    if (!isSafeSimpleIdentifier(name) || !safeMcpServer(value)) invalid();
    mcpServers[name] = value;
  }
  return {
    marketplaces,
    plugins,
    ...(Object.keys(projects).length ? { projects } : {}),
    ...(Object.keys(hookStates).length ? { hooks: { state: hookStates } } : {}),
    ...(Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {}),
  };
}

/**
 * Exactly a remote HTTP URL and an environment-referenced bearer. Inline auth,
 * static or environment headers, URL credentials, and other settings are
 * rejected because Forge neither generates nor can vouch for them.
 */
function safeMcpServer(value: unknown): value is CodexMcpServerConfig {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    typeof value.url === 'string' &&
    isSafeMcpEndpointUrl(value.url) &&
    typeof value.bearer_token_env_var === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value.bearer_token_env_var)
  );
}

/** Bound dotted keys before the parser expands them into nested tables. */
function assertBoundedKeyPaths(source: string): void {
  let segments = 1;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '#') {
      const newline = source.indexOf('\n', index);
      if (newline === -1) return;
      index = newline;
      segments = 1;
    } else if (character === '"' || character === "'") {
      // Ignore quoted key contents and strings, including multiline strings.
      // Invalid or unterminated strings are left for the TOML parser to reject.
      const delimiter = source.startsWith(character.repeat(3), index)
        ? character.repeat(3)
        : character;
      index += delimiter.length;
      while (index < source.length) {
        if (character === '"' && source[index] === '\\') {
          index += 2;
        } else if (source.startsWith(delimiter, index)) {
          index += delimiter.length - 1;
          if (delimiter.length === 3) {
            while (source[index + 1] === character) index++;
          }
          break;
        } else index++;
      }
    } else if (character === '.') {
      if (++segments > MAX_CONFIG_DEPTH) invalid();
    } else if ('=[]{},\n\r'.includes(character)) {
      segments = 1;
    }
  }
}

/** Check discarded settings too, before selecting or rewriting native state. */
function assertSafeConfiguration(config: Record<string, unknown>): void {
  const pending: { value: unknown; depth: number }[] = [
    { value: config, depth: 0 },
  ];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > MAX_CONFIG_DEPTH) invalid();
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor') invalid();
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}

export function qualifiedPluginId(
  value: string,
): { name: string; marketplace: string } | undefined {
  const parts = value.split('@');
  if (parts.length !== 2 || !parts.every(isSafeSimpleIdentifier))
    return undefined;
  return { name: parts[0]!, marketplace: parts[1]! };
}

export function safeGitUrl(value: string): boolean {
  if (!bounded(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function entries(value: unknown): [string, unknown][] {
  if (value === undefined) return [];
  if (!record(value) || Object.keys(value).length > MAX_ENTRIES) invalid();
  return Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function bounded(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function invalid(): never {
  throw new Error('Codex plugin configuration is unsupported or malformed.');
}
