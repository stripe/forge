import { isDeepStrictEqual } from 'node:util';
import type { PluginMcpConnection } from '../../contracts/runtime.ts';
import { isSafeVersion } from '../../model/paths.ts';
import { PLUGIN_MCP_CREDENTIALS } from '../../model/pluginCredentials.ts';
import { parseJson, record } from './native.ts';

export const BUNDLE_SOURCE_PATH = 'providers/agent-plugins/plugin';
export const PLUGIN_ROOT = 'plugins/stripe';
export const PLUGIN_CONFIG_PATH = `${PLUGIN_ROOT}/opencode.json`;
const SCHEMA_ROOT = 'https://agent-plugins.org/schemas/1.0.0/';

export interface StripeOpenCodeConfiguration {
  readonly skills: { readonly paths: readonly string[] };
  readonly mcp: {
    readonly stripe: {
      readonly type: 'remote';
      readonly url: string;
      readonly enabled: true;
      readonly oauth: false;
      readonly headers: { readonly Authorization: string };
    };
  };
}

/** Only metadata, standard skills, and the bundled Stripe MCP connection are supported. */
export function stripeBundleVersion(manifest: unknown): string {
  const value = record(manifest);
  const metadata = new Set([
    '$schema',
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'extensions',
  ]);
  if (
    value.$schema !== `${SCHEMA_ROOT}plugin.schema.json` ||
    value.name !== 'stripe' ||
    typeof value.version !== 'string' ||
    !isSafeVersion(value.version) ||
    Object.keys(value).some((key) => !metadata.has(key))
  )
    throw new Error('Unsupported Stripe standard bundle manifest.');
  return value.version;
}

export function stripeOpenCodeConfiguration(
  document: unknown,
  stateDirectory: string,
  connection?: PluginMcpConnection,
): StripeOpenCodeConfiguration {
  const value = record(document);
  const servers = record(value.mcpServers);
  const stripe = record(servers.stripe);
  if (
    value.$schema !== `${SCHEMA_ROOT}mcp.schema.json` ||
    Object.keys(value).some(
      (key) => !['$schema', 'mcpServers'].includes(key),
    ) ||
    Object.keys(servers).length !== 1 ||
    Object.keys(stripe).some((key) => !['type', 'url'].includes(key)) ||
    stripe.type !== 'streamable-http' ||
    typeof stripe.url !== 'string'
  )
    throw new Error('Unsupported Stripe bundle MCP configuration.');
  const url = new URL(stripe.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\s{}\u0000-\u001f\u007f]/.test(stripe.url)
  )
    throw new Error('Invalid Stripe bundle MCP URL.');
  if (url.href !== PLUGIN_MCP_CREDENTIALS.stripe.url)
    throw new Error('Unsupported Stripe bundle MCP URL.');
  if (!connection)
    throw new Error('Stripe MCP requires a host credential relay.');
  return {
    skills: { paths: [`${stateDirectory}/${PLUGIN_ROOT}/bundle/skills`] },
    mcp: {
      stripe: {
        type: 'remote',
        url: connection.url,
        enabled: true,
        oauth: false,
        headers: {
          Authorization: `Bearer ${connection.token}`,
        },
      },
    },
  };
}

/** Add the validated installed skills/MCP fragment to the generated model config. */
export function mergeStripeOpenCodeConfiguration(
  generated: string,
  installed: string,
  stateDirectory: string,
): string {
  const config = record(parseJson(generated, 1024 * 1024));
  const fragment = record(parseJson(installed, 1024 * 1024));
  const server = record(record(fragment.mcp).stripe);
  const token = record(server.headers).Authorization;
  if (
    typeof server.url !== 'string' ||
    typeof token !== 'string' ||
    !/^Bearer [a-f0-9]{64}$/.test(token)
  )
    throw new Error('Invalid installed OpenCode relay configuration.');
  const relayUrl = new URL(server.url);
  if (
    relayUrl.protocol !== 'http:' ||
    relayUrl.pathname !== '/mcp' ||
    relayUrl.username ||
    relayUrl.password ||
    relayUrl.search ||
    relayUrl.hash
  )
    throw new Error('Invalid installed OpenCode relay URL.');
  const expected = stripeOpenCodeConfiguration(
    {
      $schema: `${SCHEMA_ROOT}mcp.schema.json`,
      mcpServers: {
        stripe: {
          type: 'streamable-http',
          url: PLUGIN_MCP_CREDENTIALS.stripe.url,
        },
      },
    },
    stateDirectory,
    { url: server.url, token: token.slice('Bearer '.length) },
  );
  // Exact structure also rejects accidental model/auth overrides in installed state.
  if (!isDeepStrictEqual(fragment, expected))
    throw new Error('Invalid installed OpenCode plugin configuration.');
  return JSON.stringify({
    ...config,
    skills: expected.skills,
    mcp: expected.mcp,
  });
}
