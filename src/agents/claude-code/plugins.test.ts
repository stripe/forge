import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {CommandResult, CommandRunner} from '../../contracts/command.js';
import type {PluginSelectionV1} from '../../model/types.js';
import {
  createMemoryWorkspace,
  type MemoryWorkspaceFixture,
} from '../../testing/memoryWorkspace.js';
import {
  CLAUDE_PLUGIN_DATA_STATE_ID,
  CLAUDE_PLUGIN_DATA_STATE_PATH,
  CLAUDE_PLUGIN_STATE_ID,
  CLAUDE_PLUGIN_STATE_PATH,
  createClaudePluginInstaller,
} from './plugins.js';

const CATALOG_COMMIT = 'a'.repeat(40);
const PLUGIN_COMMIT = 'b'.repeat(40);
const MARKETPLACE_REPOSITORY =
  'https://github.com/anthropics/claude-plugins-official.git';
const PLUGIN_REPOSITORY = 'https://github.com/stripe/ai.git';
const LATEST_VERSION = '0.9.2';
const DEFAULT_CATALOG_SOURCE = {
  source: 'git-subdir',
  url: PLUGIN_REPOSITORY,
  path: 'providers/claude/plugin',
  ref: 'main',
  sha: PLUGIN_COMMIT,
} as const;

const distribution: PluginSelectionV1 = {
  plugin: 'stripe@claude-plugins-official',
  marketplace: 'anthropics/claude-plugins-official',
};

describe('Claude plugin installer', () => {
  it('installs the latest entry through an aliased marketplace and records sealed seed state', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {requireSafeDirectory: true});
    const prepared = createClaudePluginInstaller({
      adapterId: 'claude-code',
      executable: 'claude',
    }).preflight(distribution, {
      selection: {
        adapter: 'claude-code',
        provider: 'anthropic',
        model: 'claude-test',
      },
      runtime: runtimeSelection(),
    });

    assert.deepEqual(prepared.requirements, {
      executables: ['claude', 'env', 'git', 'mkdir', 'ln', 'readlink'],
      stateDirectories: [
        {
          id: CLAUDE_PLUGIN_STATE_ID,
          containerPath: CLAUDE_PLUGIN_STATE_PATH,
          sealAfterSetup: true,
        },
        {
          id: CLAUDE_PLUGIN_DATA_STATE_ID,
          containerPath: CLAUDE_PLUGIN_DATA_STATE_PATH,
          sealAfterSetup: false,
        },
      ],
    });
    const receipt = await prepared.install(installContext(state, harness.commands));

    const fetch = harness.calls.find((argv) => argv.includes('fetch'))!;
    assert.ok(fetch.includes('HEAD'));
    assert.ok(fetch.includes('--depth'));
    assert.equal(harness.calls.some((argv) => argv.includes('update')), false);
    const add = harness.calls.find(
      (argv) => argv.includes('marketplace') && argv.includes('add'),
    )!;
    const addedPath = add[add.indexOf('add') + 1]!;
    assert.match(addedPath, /\/seed\/marketplaces\/forge-[a-f0-9]{32}$/);
    assert.doesNotMatch(addedPath, /claude-plugins-official$/);
    for (const argv of harness.calls.filter((command) => command.includes('git'))) {
      assert.deepEqual(
        argv.filter((argument) => argument.startsWith('safe.directory=')),
        [`safe.directory=${addedPath}`],
      );
    }
    assert.deepEqual(harness.calls.find((argv) => argv[0] === 'ln'), [
      'ln', '-s', CLAUDE_PLUGIN_DATA_STATE_PATH,
      `${CLAUDE_PLUGIN_STATE_PATH}/seed/data`,
    ]);

    const install = harness.calls.find(
      (argv) => argv.includes('plugin') && argv.includes('install'),
    )!;
    const nativeId = install[install.indexOf('install') + 1]!;
    assert.match(nativeId, /^stripe@forge-[a-f0-9]{32}$/);
    const settings = JSON.parse(
      Buffer.from(
        state.snapshot().get('session-settings.json')!,
      ).toString('utf8'),
    ) as {enabledPlugins: Record<string, boolean>};
    assert.deepEqual(settings, {enabledPlugins: {[nativeId]: true}});

    const syntheticPath =
      `seed/marketplaces/${nativeId.slice(nativeId.indexOf('@') + 1)}` +
      '/.claude-plugin/marketplace.json';
    const synthetic = JSON.parse(
      Buffer.from(state.snapshot().get(syntheticPath)!).toString('utf8'),
    ) as {name: string; plugins: Array<{name: string}>};
    assert.equal(synthetic.name, nativeId.slice(nativeId.indexOf('@') + 1));
    assert.deepEqual(synthetic.plugins.map(({name}) => name), ['stripe']);
    assert.deepEqual(receipt, {
      adapter: 'claude-code',
      plugin: distribution.plugin,
      marketplace: distribution.marketplace,
      marketplace_commit: CATALOG_COMMIT,
      native_plugin_id: nativeId,
      version: LATEST_VERSION,
      source: {kind: 'git-subdir', commit: PLUGIN_COMMIT},
      installed_tree: {
        format: 'forge-plugin-tree-v1',
        sha256: receipt.installed_tree.sha256,
        entry_count: 2,
        file_count: 1,
        size_bytes: Buffer.byteLength(
          JSON.stringify({name: 'stripe', version: LATEST_VERSION}),
        ),
      },
    });
    assert.match(receipt.installed_tree.sha256, /^sha256:[a-f0-9]{64}$/);
  });

  it('reuses the declared data link across repeated plugin setup', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state);
    const context = installContext(state, harness.commands);
    await installerPreflight().install(context);
    await installerPreflight().install(context);
    assert.equal(harness.calls.filter((argv) => argv[0] === 'ln').length, 1);
    assert.equal(harness.calls.filter((argv) => argv.includes('fetch')).length, 1);
  });

  it('rejects a data link outside its declared state before native installation', async () => {
    for (const initialDataLink of ['/workspace', `${CLAUDE_PLUGIN_DATA_STATE_PATH}\n`]) {
      const state = createMemoryWorkspace();
      const harness = nativeCommandHarness(state, {initialDataLink});
      await assert.rejects(
        installerPreflight().install(installContext(state, harness.commands)),
        /data link does not match/,
      );
      assert.equal(harness.calls.some((argv) => argv.includes('install')), false);
    }
  });

  it('does not overwrite an unexpected data file', async () => {
    const state = createMemoryWorkspace({'seed/data': 'preserve me'});
    const harness = nativeCommandHarness(state);
    await assert.rejects(
      installerPreflight().install(installContext(state, harness.commands)),
      /data path already contains unexpected state/,
    );
    assert.equal(harness.calls.some((argv) => argv[0] === 'ln'), false);
    assert.equal(Buffer.from(state.snapshot().get('seed/data')!).toString(), 'preserve me');
  });

  it('requires its separate data state before running commands', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state);
    const context = installContext(state, harness.commands);
    context.stateDirectories.delete(CLAUDE_PLUGIN_DATA_STATE_ID);
    await assert.rejects(installerPreflight().install(context), /state is unavailable/);
    assert.equal(harness.calls.length, 0);
  });

  it('rejects a catalog whose selected entry has an unsafe source', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {
      catalogSource: {
        source: 'git-subdir',
        url: PLUGIN_REPOSITORY,
        path: 'providers/claude/plugin',
        sha: 'not-a-commit',
      },
    });
    const prepared = installerPreflight();

    await assert.rejects(
      prepared.install(installContext(state, harness.commands)),
      /source/,
    );
    assert.equal(harness.calls.some((argv) => argv.includes('install')), false);
  });

  it('supports latest entries stored in the marketplace or in an archive', async () => {
    for (const candidate of [
      {
        version: '1.0.0',
        source: './plugins/formatter',
      },
      {
        version: '2.0.0',
        source: {
          source: 'archive',
          url: 'https://artifacts.example.test/plugin-2.0.0.zip',
          sha256: 'c'.repeat(64),
        },
      },
    ]) {
      const state = createMemoryWorkspace();
      const harness = nativeCommandHarness(state, {
        catalogSource: candidate.source,
        installedVersion: candidate.version,
      });
      const receipt = await installerPreflight().install(
        installContext(state, harness.commands),
      );
      assert.ok(state.snapshot().has('session-settings.json'));
      assert.deepEqual(
        receipt.source,
        typeof candidate.source === 'string'
          ? {kind: 'marketplace-path'}
          : {kind: 'archive', sha256: `sha256:${'c'.repeat(64)}`},
      );
    }
  });

  it('accepts a commit-pinned url source with an exact plugin subdirectory', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {
      catalogSource: {
        source: 'url',
        url: PLUGIN_REPOSITORY,
        path: 'providers/claude/plugin',
        sha: PLUGIN_COMMIT,
      },
    });

    await installerPreflight().install(installContext(state, harness.commands));

    assert.ok(state.snapshot().has('session-settings.json'));
  });

  it('accepts the version currently resolved by the marketplace', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {installedVersion: '0.9.3'});
    const prepared = installerPreflight();

    await prepared.install(installContext(state, harness.commands));

    const installed = JSON.parse(
      Buffer.from(
        state.snapshot().get('seed/installed_plugins.json')!,
      ).toString('utf8'),
    ) as {plugins: Record<string, Array<{version: string}>>};
    assert.equal(Object.values(installed.plugins)[0]?.[0]?.version, '0.9.3');
  });

  it('rejects an unplanned transitive plugin dependency', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {extraPlugin: true});
    const prepared = installerPreflight();

    await assert.rejects(
      prepared.install(installContext(state, harness.commands)),
      /unexpected plugin dependency/,
    );
  });

  it('rejects a capability invoked for a different adapter', () => {
    assert.throws(
      () =>
        createClaudePluginInstaller({
          adapterId: 'claude-code',
          executable: 'claude',
        }).preflight(distribution, {
          selection: {
            adapter: 'other-agent',
            provider: 'anthropic',
            model: 'model',
          },
          runtime: runtimeSelection(),
        }),
      /does not match/,
    );
  });
});

function installerPreflight(selected: PluginSelectionV1 = distribution) {
  return createClaudePluginInstaller({
    adapterId: 'claude-code',
    executable: 'claude',
  }).preflight(selected, {
    selection: {
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-test',
    },
    runtime: runtimeSelection(),
  });
}

function runtimeSelection() {
  return {
    adapter: 'docker' as const,
    image: {kind: 'forge' as const},
    platform: 'linux/amd64' as const,
    resources: {
      memory_bytes: 1024 * 1024 * 1024,
      cpu_count: 1,
      process_count: 128,
    },
  };
}

function installContext(
  state: MemoryWorkspaceFixture,
  commands: CommandRunner,
) {
  return {
    runId: 'run-plugin',
    paths: {workspace: '/workspace', home: '/home/forge'},
    stateDirectories: new Map([
      [CLAUDE_PLUGIN_STATE_ID, state.mutable],
      [CLAUDE_PLUGIN_DATA_STATE_ID, createMemoryWorkspace().mutable],
    ]),
    commands,
    signal: new AbortController().signal,
  };
}

function nativeCommandHarness(
  state: MemoryWorkspaceFixture,
  options: {
    readonly catalogSource?: unknown;
    readonly installedVersion?: string;
    readonly extraPlugin?: boolean;
    readonly initialDataLink?: string;
    readonly requireSafeDirectory?: boolean;
  } = {},
): {readonly commands: CommandRunner; readonly calls: readonly string[][]} {
  const calls: string[][] = [];
  const catalogSource = options.catalogSource ?? DEFAULT_CATALOG_SOURCE;
  const catalog = JSON.stringify({
    name: 'claude-plugins-official',
    owner: {name: 'Anthropic'},
    plugins: [
      {
        name: 'stripe',
        source: catalogSource,
      },
    ],
  });
  let nativePluginId: string | undefined;
  let installPath: string | undefined;
  let dataLink = options.initialDataLink;

  const commands: CommandRunner = {
    async run(argv): Promise<CommandResult> {
      const command = [...argv];
      calls.push(command);
      if (command[0] === 'readlink') {
        return dataLink === undefined
          ? {...result(), exitCode: 1}
          : result(`${dataLink}\n`);
      }
      if (command[0] === 'ln') {
        assert.equal(dataLink, undefined);
        dataLink = command[2];
        return result();
      }
      const gitIndex = command.indexOf('git');
      if (gitIndex >= 0) {
        const git = command.slice(gitIndex + 1);
        const root = git.includes('-C') ? git[git.indexOf('-C') + 1] : undefined;
        if (git.includes('checkout')) {
          const init = calls.find((candidate) => candidate.includes('init'))!;
          const marketplacePath = init.at(-1)!;
          const relative = stateRelativePath(marketplacePath);
          await state.mutable.writeFile(`${relative}/.git/HEAD`, Buffer.from('ref'));
          await state.mutable.writeFile(
            `${relative}/.claude-plugin/marketplace.json`,
            Buffer.from(catalog),
          );
          return result();
        }
        if (git.includes('rev-parse')) {
          if (options.requireSafeDirectory && !git.includes(`safe.directory=${root}`)) {
            return {...result(), exitCode: 128, stderr: 'fatal: detected dubious ownership'};
          }
          return result(CATALOG_COMMIT);
        }
        if (git.includes('get-url')) return result(MARKETPLACE_REPOSITORY);
        if (git.includes('show')) return result(catalog);
        assert.ok(root === undefined || root.startsWith(CLAUDE_PLUGIN_STATE_PATH));
        return result();
      }

      const marketplaceIndex = command.indexOf('marketplace');
      if (marketplaceIndex >= 0 && command[marketplaceIndex + 1] === 'add') {
        assert.equal(dataLink, CLAUDE_PLUGIN_DATA_STATE_PATH);
        const marketplacePath = command[marketplaceIndex + 2]!;
        const alias = marketplacePath.slice(marketplacePath.lastIndexOf('/') + 1);
        await state.mutable.writeFile(
          'seed/known_marketplaces.json',
          Buffer.from(
            JSON.stringify({
              [alias]: {
                source: {source: 'directory', path: marketplacePath},
                installLocation: marketplacePath,
              },
            }),
          ),
        );
        return result('Successfully added marketplace');
      }

      const installIndex = command.indexOf('install');
      if (installIndex >= 0) {
        nativePluginId = command[installIndex + 1]!;
        const [plugin, alias] = nativePluginId.split('@');
        const version = options.installedVersion ?? LATEST_VERSION;
        installPath =
          typeof catalogSource === 'string'
            ? `${CLAUDE_PLUGIN_STATE_PATH}/seed/marketplaces/${alias}/${catalogSource.slice(2)}`
            : `${CLAUDE_PLUGIN_STATE_PATH}/seed/cache/${alias}/${plugin}/${version}`;
        const relativeInstallPath = stateRelativePath(installPath);
        await state.mutable.writeFile(
          `${relativeInstallPath}/.claude-plugin/plugin.json`,
          Buffer.from(JSON.stringify({name: plugin, version})),
        );
        await state.mutable.writeFile(
          'seed/installed_plugins.json',
          Buffer.from(
            JSON.stringify({
              version: 2,
              plugins: {
                [nativePluginId]: [
                  {
                    scope: 'user',
                    installPath,
                    version,
                    ...(catalogSourceCommit(catalogSource) === undefined
                      ? {}
                      : {gitCommitSha: catalogSourceCommit(catalogSource)}),
                  },
                ],
              },
            }),
          ),
        );
        return result(
          JSON.stringify({
            command: 'install',
            outcome: 'ok',
            plugin: nativePluginId,
            pluginId: nativePluginId,
            scope: 'user',
            message: 'installed',
          }),
        );
      }

      if (command.includes('list')) {
        assert.ok(nativePluginId && installPath);
        const version = options.installedVersion ?? LATEST_VERSION;
        const rows: unknown[] = [
          {
            id: nativePluginId,
            version,
            scope: 'user',
            enabled: true,
            installPath,
          },
        ];
        if (options.extraPlugin) {
          rows.push({
            id: 'dependency@unexpected',
            version: '1.0.0',
            scope: 'user',
            enabled: true,
            installPath: `${CLAUDE_PLUGIN_STATE_PATH}/seed/cache/unexpected/dependency/1.0.0`,
          });
        }
        return result(JSON.stringify(rows));
      }
      return result();
    },
  };
  return {commands, calls};
}

function stateRelativePath(absolutePath: string): string {
  assert.ok(absolutePath.startsWith(`${CLAUDE_PLUGIN_STATE_PATH}/`));
  return absolutePath.slice(CLAUDE_PLUGIN_STATE_PATH.length + 1);
}

function catalogSourceCommit(source: unknown): string | undefined {
  return source !== null &&
    typeof source === 'object' &&
    'sha' in source &&
    typeof source.sha === 'string'
    ? source.sha
    : undefined;
}

function result(stdout = ''): CommandResult {
  return {stdout, stderr: '', exitCode: 0, durationMs: 1};
}
