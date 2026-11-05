import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandRunner } from '../../contracts/command.ts';
import type {
  AgentPluginInstallationReceipt,
  AgentPluginInstallContext,
  AgentPluginInstaller,
  AgentPluginPreflightContext,
} from '../../contracts/plugin.ts';
import type { MutableWorkspace } from '../../contracts/runtime.ts';
import {
  isSafeGitHubRepository,
  isSafeVersion,
  isSafeWorkspaceRelativePath,
} from '../../model/paths.ts';
import type { PluginSelectionV1 } from '../../model/types.ts';
import {
  prepareCodexPluginMcpRelocation,
  writeRelocatedPluginMcp,
} from '../pluginMcp.ts';
import { inspectInstalledPluginTree } from '../pluginTree.ts';
import {
  assertCodexRuntimeLayout,
  CODEX_HOME_STATE_ID,
  type CodexLayout,
  resolveCodexLayout,
} from './layout.ts';
import {
  declareCodexMcpServers,
  prepareCodexPluginConfiguration,
  qualifiedPluginId,
  record,
  safeGitUrl,
} from './pluginConfig.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const CATALOG_PATHS = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
] as const;

/** Native Codex installation into the same run-owned home used by interaction. */
export function createCodexPluginInstaller(options: {
  readonly adapterId: string;
  readonly executable: string;
  readonly layout?: CodexLayout;
}): AgentPluginInstaller {
  const layout = resolveCodexLayout(options.layout);
  return Object.freeze({
    supportsMcpBearerAuth: true as const,
    preflight(
      distribution: PluginSelectionV1,
      context: AgentPluginPreflightContext,
    ) {
      if (context.selection.adapter !== options.adapterId) {
        throw new TypeError(
          'Codex plugin installer does not match the selected adapter.',
        );
      }
      if (
        !record(distribution) ||
        Object.keys(distribution).length !== 2 ||
        typeof distribution.plugin !== 'string' ||
        !qualifiedPluginId(distribution.plugin) ||
        typeof distribution.marketplace !== 'string' ||
        !isSafeGitHubRepository(distribution.marketplace)
      ) {
        throw new TypeError(
          'Codex plugin distribution must specify plugin@marketplace and GitHub owner/repository.',
        );
      }
      const selected = Object.freeze({ ...distribution });
      const identity = qualifiedPluginId(selected.plugin)!;
      const repositoryUrl = `https://github.com/${selected.marketplace}.git`;
      const marketplaceRelative = `.tmp/marketplaces/${identity.marketplace}`;
      const marketplacePath = `${layout.configDirectory}/${marketplaceRelative}`;
      return Object.freeze({
        requirements: Object.freeze({
          executables: Object.freeze([options.executable, 'env', 'git']),
          stateDirectories: Object.freeze([
            Object.freeze({
              id: CODEX_HOME_STATE_ID,
              containerPath: layout.configDirectory,
            }),
          ]),
        }),
        async install(
          installContext: AgentPluginInstallContext,
        ): Promise<AgentPluginInstallationReceipt> {
          assertCodexRuntimeLayout(layout, installContext.paths);
          const home = installContext.stateDirectories.get(CODEX_HOME_STATE_ID);
          if (!home || installContext.stateDirectories.size !== 1) {
            throw new TypeError(
              'Codex plugin installation state is unavailable.',
            );
          }
          const { commands, signal } = installContext;
          signal.throwIfAborted();
          await prepareCodexPluginConfiguration(home);
          const native = (args: readonly string[]) =>
            run(
              commands,
              [...gitEnvironment(), options.executable, 'plugin', ...args],
              signal,
            );
          const git = (args: readonly string[]) =>
            run(
              commands,
              [
                ...gitEnvironment(),
                'git',
                '-c',
                `safe.directory=${marketplacePath}`,
                '-C',
                marketplacePath,
                ...args,
              ],
              signal,
            );

          const before = installedInventory(await native(['list', '--json']));
          const added = objectJson(
            await native([
              'marketplace',
              'add',
              selected.marketplace,
              '--json',
            ]),
          );
          if (
            added.marketplaceName !== identity.marketplace ||
            added.installedRoot !== marketplacePath ||
            typeof added.alreadyAdded !== 'boolean'
          )
            fail('marketplace registration');
          const known = objectJson(
            await native(['marketplace', 'list', '--json']),
          );
          if (!Array.isArray(known.marketplaces)) fail('marketplace inventory');
          const matches = known.marketplaces.filter(
            (row) => record(row) && row.name === identity.marketplace,
          );
          if (
            matches.length !== 1 ||
            !record(matches[0]) ||
            matches[0].root !== marketplacePath ||
            !isDeepStrictEqual(matches[0].marketplaceSource, {
              sourceType: 'git',
              source: repositoryUrl,
            })
          ) {
            fail('marketplace source or path');
          }
          if (
            (await home.inspect(`${marketplaceRelative}/.git/HEAD`)).kind !==
            'file'
          )
            fail('marketplace checkout');
          const commit = (await git(['rev-parse', 'HEAD'])).trim();
          if (!/^[a-f0-9]{40}$/.test(commit)) fail('marketplace commit');
          if (
            (await git(['remote', 'get-url', 'origin'])).trim() !==
            repositoryUrl
          )
            fail('marketplace origin');
          let catalogPath: string | undefined;
          for (const candidate of CATALOG_PATHS) {
            const entry = await home.inspect(
              `${marketplaceRelative}/${candidate}`,
            );
            if (entry.kind === 'absent') continue;
            if (entry.kind !== 'file') fail('marketplace catalog');
            catalogPath = candidate;
            break;
          }
          if (catalogPath === undefined) fail('supported marketplace catalog');
          const snapshot = await git(['show', `${commit}:${catalogPath}`]);
          const onDisk = Buffer.from(
            await home.readFile(`${marketplaceRelative}/${catalogPath}`, {
              maxBytes: MAX_BYTES,
            }),
          ).toString('utf8');
          if (snapshot !== onDisk) fail('marketplace catalog snapshot');
          const catalog = objectJson(snapshot);
          if (
            catalog.name !== identity.marketplace ||
            !Array.isArray(catalog.plugins) ||
            catalog.plugins.length > 10_000
          )
            fail('marketplace catalog identity');
          const entries = catalog.plugins.filter(
            (entry) => record(entry) && entry.name === identity.name,
          );
          if (entries.length !== 1 || !record(entries[0]))
            fail('selected catalog entry');
          const entry = entries[0];
          if (
            entry.dependencies !== undefined &&
            (!Array.isArray(entry.dependencies) || entry.dependencies.length)
          ) {
            fail('unsupported plugin dependencies');
          }
          const source = validatedSource(entry.source, marketplacePath);
          if (
            entry.version !== undefined &&
            (typeof entry.version !== 'string' || !isSafeVersion(entry.version))
          ) {
            fail('catalog version');
          }
          const installed = objectJson(
            await native(['add', selected.plugin, '--json']),
          );
          if (
            installed.pluginId !== selected.plugin ||
            installed.name !== identity.name ||
            installed.marketplaceName !== identity.marketplace ||
            typeof installed.version !== 'string' ||
            !isSafeVersion(installed.version)
          )
            fail('installation identity or version');
          const relative = `plugins/cache/${identity.marketplace}/${identity.name}/${installed.version}`;
          if (
            installed.installedPath !== `${layout.configDirectory}/${relative}`
          )
            fail('installation path');
          const after = installedInventory(await native(['list', '--json']));
          const expected = new Set([...before.keys(), selected.plugin]);
          if (
            after.size !== expected.size ||
            [...after.keys()].some((id) => !expected.has(id))
          ) {
            fail('unexpected plugin installations');
          }
          for (const [id, row] of before) {
            if (
              id !== selected.plugin &&
              !isDeepStrictEqual(after.get(id), row)
            )
              fail('existing plugin state');
          }
          const row = after.get(selected.plugin);
          if (
            !row ||
            row.name !== identity.name ||
            row.marketplaceName !== identity.marketplace ||
            row.version !== installed.version ||
            row.enabled !== true ||
            !isDeepStrictEqual(row.source, source.native) ||
            !isDeepStrictEqual(row.marketplaceSource, {
              sourceType: 'git',
              source: repositoryUrl,
            }) ||
            row.authPolicy !== installed.authPolicy
          )
            fail('installed plugin state or source');
          await prepareCodexPluginConfiguration(home);
          await verifyManifest(
            home,
            relative,
            identity.name,
            installed.version,
          );
          // Fingerprint before Forge edits anything: the move below removes the
          // connection from the tree, so the tree alone would not identify it.
          const installedTree = await inspectInstalledPluginTree(
            home,
            relative,
            signal,
          );
          let connections:
            | NonNullable<AgentPluginInstallationReceipt['mcp_connections']>
            | undefined;
          const mcpServers = context.mcpServers;
          if (mcpServers) {
            // Validate the whole move and the merged configuration before
            // changing either file.
            const relocation = await prepareCodexPluginMcpRelocation(
              home,
              relative,
              mcpServers,
            );
            await declareCodexMcpServers(home, relocation.declarations);
            await writeRelocatedPluginMcp(home, relocation);
            connections = Object.entries(relocation.declarations)
              .sort(([left], [right]) => (left < right ? -1 : 1))
              .map(([name, server]) =>
                Object.freeze({ name, url: server!.url }),
              );
          }
          return Object.freeze({
            adapter: options.adapterId,
            plugin: selected.plugin,
            marketplace: selected.marketplace,
            marketplace_commit: commit,
            native_plugin_id: selected.plugin,
            version: installed.version,
            source: Object.freeze({ kind: source.kind }),
            installed_tree: installedTree,
            ...(connections?.length
              ? {
                  mcp_configuration: 'codex-user-config' as const,
                  mcp_connections: Object.freeze(
                    connections,
                  ) as typeof connections,
                }
              : {}),
          });
        },
      });
    },
  });
}

function validatedSource(
  value: unknown,
  marketplacePath: string,
): {
  native: Record<string, unknown>;
  kind: AgentPluginInstallationReceipt['source']['kind'];
} {
  const source =
    typeof value === 'string' ? { source: 'local', path: value } : value;
  if (!record(source)) fail('unsupported plugin source');
  if (source.source === 'local') {
    const relativePath =
      typeof source.path === 'string'
        ? source.path.replace(/\/$/, '').slice(2)
        : undefined;
    if (
      Object.keys(source).some((key) => !['source', 'path'].includes(key)) ||
      typeof source.path !== 'string' ||
      !source.path.startsWith('./') ||
      relativePath === undefined ||
      !isSafeWorkspaceRelativePath(relativePath)
    )
      fail('marketplace plugin path');
    return {
      kind: 'marketplace-path',
      native: { source: 'local', path: `${marketplacePath}/${relativePath}` },
    };
  }
  if (source.source !== 'url' && source.source !== 'git-subdir')
    fail('unsupported plugin source');
  if (
    Object.keys(source).some(
      (key) => !['source', 'url', 'path', 'ref', 'sha'].includes(key),
    ) ||
    typeof source.url !== 'string' ||
    !safeGitUrl(source.url) ||
    (source.sha !== undefined &&
      (typeof source.sha !== 'string' || !/^[a-f0-9]{40}$/.test(source.sha))) ||
    (source.ref !== undefined &&
      (typeof source.ref !== 'string' ||
        !source.ref.length ||
        source.ref.length > 4_096 ||
        /[\u0000-\u001f\u007f]/.test(source.ref))) ||
    (source.path !== undefined &&
      (typeof source.path !== 'string' ||
        !isSafeWorkspaceRelativePath(source.path) ||
        path.posix.normalize(source.path) !== source.path)) ||
    (source.source === 'git-subdir' && source.path === undefined)
  ) {
    fail('unsupported Git source');
  }
  return {
    kind: source.source,
    native: {
      source: source.path === undefined ? 'git' : 'git-subdir',
      url: source.url,
      ...(source.path === undefined ? {} : { path: source.path }),
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      ...(source.sha === undefined ? {} : { sha: source.sha }),
    },
  };
}

async function verifyManifest(
  home: MutableWorkspace,
  root: string,
  name: string,
  version: string,
): Promise<void> {
  const agentManifestPath = `${root}/plugin.json`;
  const agentManifestEntry = await home.inspect(agentManifestPath);
  if (agentManifestEntry.kind !== 'absent') {
    if (agentManifestEntry.kind !== 'file') fail('plugin manifest');
    const manifest = objectJson(
      Buffer.from(
        await home.readFile(agentManifestPath, { maxBytes: MAX_BYTES }),
      ).toString('utf8'),
    );
    if (
      typeof manifest.$schema === 'string' &&
      manifest.$schema.startsWith('https://agent-plugins.org/schemas/')
    ) {
      if (
        manifest.$schema !==
        'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
      )
        fail('unsupported plugin manifest schema');
      validateManifestIdentity(manifest, name, version);
      return;
    }
  }
  for (const candidate of [
    '.codex-plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
  ]) {
    const manifestPath = `${root}/${candidate}`;
    const entry = await home.inspect(manifestPath);
    if (entry.kind === 'absent') continue;
    if (entry.kind !== 'file') fail('plugin manifest');
    const manifest = objectJson(
      Buffer.from(
        await home.readFile(manifestPath, { maxBytes: MAX_BYTES }),
      ).toString('utf8'),
    );
    validateManifestIdentity(manifest, name, version);
    return;
  }
  fail('supported plugin manifest');
}

function validateManifestIdentity(
  manifest: Record<string, unknown>,
  name: string,
  version: string,
): void {
  if (
    manifest.name !== name ||
    (manifest.version ?? 'local') !== version ||
    (manifest.dependencies !== undefined &&
      (!Array.isArray(manifest.dependencies) || manifest.dependencies.length))
  ) {
    fail('plugin manifest identity, version or dependencies');
  }
}

function installedInventory(
  output: string,
): Map<string, Record<string, unknown>> {
  const value = objectJson(output);
  if (
    !Array.isArray(value.installed) ||
    value.installed.length > 10_000 ||
    !Array.isArray(value.available) ||
    value.available.length !== 0
  )
    fail('plugin inventory');
  const plugins = new Map<string, Record<string, unknown>>();
  for (const row of value.installed) {
    if (
      !record(row) ||
      typeof row.pluginId !== 'string' ||
      !qualifiedPluginId(row.pluginId) ||
      row.installed !== true ||
      typeof row.enabled !== 'boolean' ||
      typeof row.version !== 'string' ||
      !isSafeVersion(row.version) ||
      plugins.has(row.pluginId)
    )
      fail('installed plugin inventory');
    plugins.set(row.pluginId, row);
  }
  return plugins;
}

function objectJson(output: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    fail('JSON output');
  }
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 100_000 || current.depth > 64) fail('JSON limits');
    if (typeof current.value === 'object' && current.value !== null) {
      for (const child of Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  if (!record(value)) fail('JSON object');
  return value;
}

function gitEnvironment(): string[] {
  return [
    'env',
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_TERMINAL_PROMPT=0',
  ];
}

async function run(
  commands: CommandRunner,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await commands.run(argv, {
    signal,
    timeoutMs: 5 * 60_000,
    maxOutputBytes: MAX_BYTES,
  });
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > MAX_BYTES)
    fail('native command');
  return result.stdout;
}

function fail(detail: string): never {
  throw new Error(`Codex plugin verification failed: ${detail}.`);
}
