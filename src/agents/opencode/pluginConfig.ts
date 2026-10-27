import { isDeepStrictEqual } from 'node:util';
import { isSafeVersion } from '../../model/paths.ts';
import { PLUGIN_MCP_CREDENTIALS } from '../../model/pluginCredentials.ts';
import { parseJson, record } from './native.ts';

export const BUNDLE_SOURCE_PATH = 'providers/claude/plugin';
export const PLUGIN_ROOT = 'plugins/stripe';
export const PLUGIN_CONFIG_PATH = `${PLUGIN_ROOT}/opencode.json`;

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

/** Read the Claude-format identity; only conventional skills and MCP are loaded. */
export function stripeBundleVersion(manifest: unknown): string {
  const value = record(manifest);
  const metadata = new Set([
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'hooks',
    'commands',
    'agents',
  ]);
  if (
    value.name !== 'stripe' ||
    typeof value.version !== 'string' ||
    !isSafeVersion(value.version) ||
    Object.keys(value).some((key) => !metadata.has(key))
  )
    throw new Error('Unsupported Stripe Claude-format plugin manifest.');
  return value.version;
}

export function stripeOpenCodeConfiguration(
  document: unknown,
  stateDirectory: string,
): StripeOpenCodeConfiguration {
  const value = record(document);
  const servers = record(value.mcpServers);
  const stripe = record(servers.stripe);
  if (
    Object.keys(value).some((key) => key !== 'mcpServers') ||
    Object.keys(servers).length !== 1 ||
    Object.keys(stripe).some((key) => !['type', 'url'].includes(key)) ||
    stripe.type !== 'http' ||
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
  return {
    skills: { paths: [`${stateDirectory}/${PLUGIN_ROOT}/bundle/skills`] },
    mcp: {
      stripe: {
        type: 'remote',
        url: stripe.url,
        enabled: true,
        oauth: false,
        headers: {
          Authorization: `Bearer {env:${PLUGIN_MCP_CREDENTIALS.stripe.credentialEnvironmentVariable}}`,
        },
      },
    },
  };
}

/** Merge only the adapter-produced skills/MCP fragment; authored routing stays separate. */
export function mergeStripeOpenCodeConfiguration(
  authored: string,
  installed: string,
  stateDirectory: string,
): string {
  const config = record(parseJson(authored, 1024 * 1024));
  const fragment = record(parseJson(installed, 1024 * 1024));
  const server = record(record(fragment.mcp).stripe);
  const expected = stripeOpenCodeConfiguration(
    {
      mcpServers: { stripe: { type: 'http', url: server.url } },
    },
    stateDirectory,
  );
  // Exact structure also rejects accidental model/auth overrides in installed state.
  if (!isDeepStrictEqual(fragment, expected))
    throw new Error('Invalid installed OpenCode plugin configuration.');
  const mcp = config.mcp === undefined ? {} : record(config.mcp);
  if (Object.hasOwn(mcp, 'stripe'))
    throw new Error(
      'Authored OpenCode MCP configuration conflicts with the Stripe plugin.',
    );
  const skills = config.skills === undefined ? {} : record(config.skills);
  if (
    skills.paths !== undefined &&
    (!Array.isArray(skills.paths) ||
      !skills.paths.every((item) => typeof item === 'string'))
  )
    throw new Error('Invalid authored OpenCode skill paths.');
  return JSON.stringify({
    ...config,
    skills: {
      ...skills,
      paths: [
        ...new Set([
          ...((skills.paths as string[] | undefined) ?? []),
          ...expected.skills.paths,
        ]),
      ],
    },
    mcp: { ...mcp, ...expected.mcp },
  });
}
