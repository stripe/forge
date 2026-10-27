import type {
  AgentPluginInstaller,
  OpenCodeBundleInstallationReceipt,
} from '../../contracts/plugin.ts';
import type { MutableWorkspace } from '../../contracts/runtime.ts';
import { pluginDefinitionForAgent } from '../../model/plugins.ts';
import { inspectInstalledPluginTree } from '../pluginTree.ts';
import {
  assertOpenCodeRuntimeLayout,
  OPENCODE_STATE_ID,
  type OpenCodeLayout,
} from './layout.ts';
import { parseJson, record } from './native.ts';
import {
  BUNDLE_SOURCE_PATH,
  PLUGIN_CONFIG_PATH,
  PLUGIN_ROOT,
  stripeBundleVersion,
  stripeOpenCodeConfiguration,
} from './pluginConfig.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const SOURCE_URL = 'https://github.com/stripe/ai.git';
const CATALOG_PATH = '.claude-plugin/marketplace.json';

/** The same catalog pin as Codex, realized using OpenCode's native skills and MCP config. */
export function createOpenCodePluginInstaller(options: {
  readonly adapterId: string;
  readonly layout: OpenCodeLayout;
}): AgentPluginInstaller {
  const { layout } = options;
  return Object.freeze({
    supportsMcpBearerAuth: true as const,
    preflight(distribution, context) {
      const registered = pluginDefinitionForAgent(
        'stripe',
        'opencode',
      )!.distribution;
      if (
        context.selection.adapter !== options.adapterId ||
        distribution.plugin !== registered.plugin ||
        distribution.marketplace !== registered.marketplace ||
        Object.keys(distribution).length !== 2 ||
        context.mcpServers?.length !== 1 ||
        context.mcpServers[0] !== 'stripe'
      )
        throw new TypeError(
          'OpenCode supports only the registered Stripe plugin and MCP connection.',
        );
      const selected = Object.freeze({ ...distribution });
      return {
        requirements: {
          executables: ['git', 'env'],
          stateDirectories: [
            { id: OPENCODE_STATE_ID, containerPath: layout.stateDirectory },
          ],
        },
        async install({
          paths,
          stateDirectories,
          commands,
          signal,
        }): Promise<OpenCodeBundleInstallationReceipt> {
          assertOpenCodeRuntimeLayout(layout, paths);
          const state = stateDirectories.get(OPENCODE_STATE_ID);
          if (!state || stateDirectories.size !== 1)
            throw new Error('OpenCode plugin state is unavailable.');
          if ((await state.inspect(PLUGIN_ROOT)).kind !== 'absent')
            throw new Error('Stripe plugin is already installed in this run.');
          const git = async (directory: string, args: readonly string[]) => {
            signal.throwIfAborted();
            const result = await commands.run(
              [
                'env',
                'GIT_CONFIG_NOSYSTEM=1',
                'GIT_CONFIG_GLOBAL=/dev/null',
                'GIT_TERMINAL_PROMPT=0',
                'git',
                '-c',
                `safe.directory=${directory}`,
                '-C',
                directory,
                ...args,
              ],
              { signal, timeoutMs: 5 * 60_000, maxOutputBytes: MAX_BYTES },
            );
            signal.throwIfAborted();
            if (
              result.exitCode !== 0 ||
              Buffer.byteLength(result.stdout) > MAX_BYTES
            )
              throw new Error('OpenCode plugin Git operation failed.');
            return result.stdout;
          };
          const catalog = `${layout.stateDirectory}/stripe-catalog`;
          await git(layout.stateDirectory, ['init', catalog]);
          await git(catalog, [
            'fetch',
            '--depth=1',
            `https://github.com/${selected.marketplace}.git`,
            'HEAD',
          ]);
          const catalogCommit = fullCommit(
            await git(catalog, ['rev-parse', 'FETCH_HEAD']),
          );
          const sourceCommit = stripeCatalogSourceCommit(
            parseJson(
              await git(catalog, ['show', `${catalogCommit}:${CATALOG_PATH}`]),
              MAX_BYTES,
            ),
          );
          const sourceRelative = 'stripe-source';
          const source = `${layout.stateDirectory}/${sourceRelative}`;
          await git(layout.stateDirectory, ['init', source]);
          await git(source, ['fetch', '--depth=1', SOURCE_URL, sourceCommit]);
          if (
            fullCommit(await git(source, ['rev-parse', 'FETCH_HEAD'])) !==
            sourceCommit
          )
            throw new Error(
              'Stripe plugin checkout does not match its source pin.',
            );
          await git(source, ['sparse-checkout', 'set', BUNDLE_SOURCE_PATH]);
          await git(source, ['checkout', '--detach', sourceCommit]);
          const bundle = `${sourceRelative}/${BUNDLE_SOURCE_PATH}`;
          // Inspect before copying to reject symlinks/special entries and bound every byte.
          await inspectInstalledPluginTree(state, bundle, signal);
          const manifest = await readJson(
            state,
            `${bundle}/.claude-plugin/plugin.json`,
          );
          const version = stripeBundleVersion(manifest);
          const entries = await state.listFiles({
            under: bundle,
            maxEntries: 100_000,
            signal,
          });
          if (
            !entries.some(
              (entry) =>
                entry.kind === 'file' &&
                entry.path.startsWith(`${bundle}/skills/`) &&
                entry.path.endsWith('/SKILL.md'),
            )
          )
            throw new Error('Stripe bundle contains no skills.');
          for (const entry of entries) {
            signal.throwIfAborted();
            if (entry.kind !== 'file') continue;
            await state.writeFile(
              `${PLUGIN_ROOT}/bundle/${entry.path.slice(bundle.length + 1)}`,
              await state.readFile(entry.path, { maxBytes: 64 * 1024 * 1024 }),
            );
          }
          // Copy the source intact, but register only its conventional skills and MCP.
          const configuration = stripeOpenCodeConfiguration(
            await readJson(state, `${bundle}/.mcp.json`),
            layout.stateDirectory,
          );
          await state.writeFile(
            PLUGIN_CONFIG_PATH,
            Buffer.from(JSON.stringify(configuration)),
            { mode: 0o600 },
          );
          return Object.freeze({
            adapter: options.adapterId,
            ...selected,
            marketplace_commit: catalogCommit,
            installation: 'opencode-bundle',
            version,
            source: Object.freeze({
              kind: 'git-subdir',
              commit: sourceCommit,
              path: BUNDLE_SOURCE_PATH,
            }),
            installed_tree: await inspectInstalledPluginTree(
              state,
              PLUGIN_ROOT,
              signal,
            ),
          });
        },
      };
    },
  } satisfies AgentPluginInstaller);
}

/** Use the exact source path and pin selected for the registered Claude-format plugin. */
export function stripeCatalogSourceCommit(catalog: unknown): string {
  const value = record(catalog);
  if (
    value.name !== 'claude-plugins-official' ||
    !Array.isArray(value.plugins) ||
    value.plugins.length > 10_000
  )
    throw new Error('Invalid Stripe plugin marketplace.');
  const entries = value.plugins.filter(
    (entry) => record(entry).name === 'stripe',
  );
  if (entries.length !== 1)
    throw new Error('Stripe marketplace entry is missing or ambiguous.');
  const entry = record(entries[0]);
  const source = record(entry.source);
  if (
    source.source !== 'git-subdir' ||
    source.url !== SOURCE_URL ||
    source.path !== BUNDLE_SOURCE_PATH ||
    (entry.dependencies !== undefined &&
      (!Array.isArray(entry.dependencies) ||
        entry.dependencies.length !== 0)) ||
    Object.keys(source).some(
      (key) => !['source', 'url', 'path', 'ref', 'sha'].includes(key),
    )
  )
    throw new Error('Unsupported Stripe marketplace source.');
  return fullCommit(source.sha);
}

function fullCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value.trim()))
    throw new Error('Stripe plugin requires a full Git commit pin.');
  return value.trim();
}

async function readJson(
  state: MutableWorkspace,
  file: string,
): Promise<unknown> {
  return parseJson(
    new TextDecoder('utf-8', { fatal: true }).decode(
      await state.readFile(file, { maxBytes: MAX_BYTES }),
    ),
    MAX_BYTES,
  );
}
