import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {CommandResult, CommandRunner} from '../../contracts/command.js';
import type {PluginSelectionV1} from '../../model/types.js';
import type {ClaudeCodeLayout} from './layout.js';
import {
  createMemoryWorkspace,
  type MemoryWorkspaceFixture,
} from '../../testing/memoryWorkspace.js';
import {
  CLAUDE_PLUGIN_STATE_ID,
  CLAUDE_PLUGIN_STATE_PATH,
  createClaudePluginInstaller,
} from './plugins.js';

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
  it('installs and verifies receipts against the explicit separate configuration root', async () => {
    const layout: ClaudeCodeLayout = {
      workspace: '/tmp/run-123/workspace',
      home: '/tmp/run-123/home',
      configDirectory: '/tmp/run-123/session',
    };
    const pluginStatePath = `${layout.configDirectory}/plugins`;
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {pluginStatePath});
    const prepared = createClaudePluginInstaller({
      adapterId: 'claude-code', executable: 'claude', layout,
    }).preflight(distribution, {
      selection: {adapter: 'claude-code', provider: 'anthropic', model: 'claude-test'},
      runtime: runtimeSelection(),
    });
    assert.equal(prepared.requirements.stateDirectories[0]?.containerPath, pluginStatePath);
    const receipt = await prepared.install({...installContext(state, harness.commands), paths: layout});
    assert.equal(receipt.native_plugin_id, distribution.plugin);
    assert.equal(readInstalledState(state)[distribution.plugin]?.[0]?.installPath,
      `${pluginStatePath}/cache/claude-plugins-official/stripe/${LATEST_VERSION}`);

    const otherState = createMemoryWorkspace();
    const otherHarness = nativeCommandHarness(otherState, {
      pluginStatePath,
      listedInstallPath: `${CLAUDE_PLUGIN_STATE_PATH}/cache/claude-plugins-official/stripe/${LATEST_VERSION}`,
    });
    await assert.rejects(prepared.install({
      ...installContext(otherState, otherHarness.commands), paths: layout,
    }), /invalid installed plugin/);
  });

  it('rejects a mismatched runtime layout before reading or installing plugin state', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state);
    await assert.rejects(installerPreflight().install({
      ...installContext(state, harness.commands),
      paths: {workspace: '/another/workspace', home: '/home/forge'},
    }), /do not match the declared layout/);
    assert.equal(harness.calls.length, 0);
    assert.equal(state.snapshot().size, 0);
  });

  it('verifies the native plugin in writable per-run state without unused hashes', async () => {
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
      executables: ['claude', 'env', 'git'],
      stateDirectories: [
        {
          id: CLAUDE_PLUGIN_STATE_ID,
          containerPath: '/home/forge/.claude/plugins',
          sealAfterSetup: false,
        },
      ],
    });
    const receipt = await prepared.install(installContext(state, harness.commands));

    assert.equal(harness.calls.some((argv) => argv.includes('update')), false);
    const add = harness.calls.find(
      (argv) => argv.includes('marketplace') && argv.includes('add'),
    )!;
    assert.equal(add[add.indexOf('add') + 1], distribution.marketplace);
    const marketplacePath = `${CLAUDE_PLUGIN_STATE_PATH}/marketplaces/claude-plugins-official`;
    for (const argv of harness.calls.filter((command) => command.includes('git'))) {
      assert.deepEqual(
        argv.filter((argument) => argument.startsWith('safe.directory=')),
        [`safe.directory=${marketplacePath}`],
      );
    }
    assert.equal(harness.calls.some((argv) => argv.includes('ln')), false);
    assert.equal(
      harness.calls.some((argv) => argv.some((arg) =>
        /^(HOME|CLAUDE_CODE_PLUGIN_(SEED|CACHE)_DIR)=/.test(arg))),
      false,
    );

    const install = harness.calls.find(
      (argv) => argv.includes('plugin') && argv.includes('install'),
    )!;
    const nativeId = install[install.indexOf('install') + 1]!;
    assert.equal(nativeId, distribution.plugin);
    assert.equal(state.snapshot().has('session-settings.json'), false);

    const catalog = JSON.parse(
      Buffer.from(state.snapshot().get(
        'marketplaces/claude-plugins-official/.claude-plugin/marketplace.json',
      )!).toString('utf8'),
    ) as {name: string; plugins: Array<{name: string}>};
    assert.equal(catalog.name, 'claude-plugins-official');
    assert.deepEqual(catalog.plugins.map(({name}) => name), ['stripe', 'formatter']);
    assert.deepEqual(receipt, {
      adapter: 'claude-code',
      plugin: distribution.plugin,
      marketplace: distribution.marketplace,
      native_plugin_id: nativeId,
      version: LATEST_VERSION,
      source: {kind: 'git-subdir'},
    });
    assert.equal(harness.calls.some((argv) => argv.includes('rev-parse')), false);
  });

  it('reuses the registered marketplace across repeated plugin setup', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state);
    const context = installContext(state, harness.commands);
    await installerPreflight().install(context);
    await installerPreflight().install(context);
    assert.equal(harness.calls.filter((argv) => argv.includes('add')).length, 1);
    assert.equal(harness.calls.some((argv) => argv.includes('update')), false);
  });

  it('preserves earlier plugins when installing another entry from the same marketplace', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state);
    const context = installContext(state, harness.commands);
    await installerPreflight().install(context);
    const receipt = await installerPreflight({
      ...distribution,
      plugin: 'formatter@claude-plugins-official',
    }).install(context);
    assert.equal(harness.calls.filter((argv) => argv.includes('add')).length, 1);
    assert.equal(receipt.native_plugin_id, 'formatter@claude-plugins-official');
    assert.deepEqual(Object.keys(readInstalledState(state)).sort(), [
      'formatter@claude-plugins-official',
      distribution.plugin,
    ]);
  });

  it('rejects a registered marketplace pointing at another repository or path', async () => {
    for (const override of [
      {source: {source: 'github', repo: 'other/marketplace'}},
      {installLocation: '/workspace/marketplace'},
    ]) {
      const state = createMemoryWorkspace({
        'known_marketplaces.json': JSON.stringify({
          'claude-plugins-official': {
            source: {source: 'github', repo: distribution.marketplace},
            installLocation: `${CLAUDE_PLUGIN_STATE_PATH}/marketplaces/claude-plugins-official`,
            ...override,
          },
        }),
      });
      const harness = nativeCommandHarness(state);
      await assert.rejects(
        installerPreflight().install(installContext(state, harness.commands)),
        /does not match its repository or path/,
      );
      assert.equal(harness.calls.length, 0);
    }
  });

  it('rejects a fetched checkout whose origin differs from the selected repository', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {origin: 'https://github.com/other/repo.git'});
    await assert.rejects(
      installerPreflight().install(installContext(state, harness.commands)),
      /checkout does not match its repository/,
    );
    assert.equal(harness.calls.some((argv) => argv.includes('install')), false);
  });

  it('accepts a native checkout origin without the optional .git suffix', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {
      origin: MARKETPLACE_REPOSITORY.replace(/\.git$/, ''),
    });
    await installerPreflight().install(installContext(state, harness.commands));
  });

  it('requires its plugin state before running commands', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state);
    const context = installContext(state, harness.commands);
    context.stateDirectories.delete(CLAUDE_PLUGIN_STATE_ID);
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
      assert.ok(state.snapshot().has(
        `cache/claude-plugins-official/stripe/${candidate.version}/.claude-plugin/plugin.json`,
      ));
      assert.deepEqual(
        receipt.source,
        typeof candidate.source === 'string'
          ? {kind: 'marketplace-path'}
          : {kind: 'archive'},
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

    assert.ok(state.snapshot().has('installed_plugins.json'));
  });

  it('rejects a native commit which differs from the catalog source assertion', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {installedCommit: 'c'.repeat(40)});
    await assert.rejects(installerPreflight().install(installContext(state, harness.commands)),
      /does not match the marketplace commit/);
  });

  it('rejects a missing native commit when the catalog supplies an assertion', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {installedCommit: null});
    await assert.rejects(installerPreflight().install(installContext(state, harness.commands)),
      /does not match the marketplace commit/);
  });

  it('accepts an unpinned Git source without requiring observed commit metadata', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {
      catalogSource: {source: 'github', repo: 'example/plugin', ref: 'main'},
      installedCommit: null,
    });
    const receipt = await installerPreflight().install(installContext(state, harness.commands));
    assert.deepEqual(receipt.source, {kind: 'github'});
  });

  it('accepts the version currently resolved by the marketplace', async () => {
    const state = createMemoryWorkspace();
    const harness = nativeCommandHarness(state, {installedVersion: '0.9.3'});
    const prepared = installerPreflight();

    await prepared.install(installContext(state, harness.commands));

    const installed = JSON.parse(
      Buffer.from(
        state.snapshot().get('installed_plugins.json')!,
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
    readonly installedCommit?: string | null;
    readonly extraPlugin?: boolean;
    readonly origin?: string;
    readonly requireSafeDirectory?: boolean;
    readonly pluginStatePath?: string;
    readonly listedInstallPath?: string;
  } = {},
): {readonly commands: CommandRunner; readonly calls: readonly string[][]} {
  const calls: string[][] = [];
  const pluginStatePath = options.pluginStatePath ?? CLAUDE_PLUGIN_STATE_PATH;
  const catalogSource = options.catalogSource ?? DEFAULT_CATALOG_SOURCE;
  const catalog = JSON.stringify({
    name: 'claude-plugins-official',
    owner: {name: 'Anthropic'},
    plugins: [
      {
        name: 'stripe',
        source: catalogSource,
      },
      {
        name: 'formatter',
        source: './plugins/formatter',
      },
    ],
  });

  const commands: CommandRunner = {
    async run(argv): Promise<CommandResult> {
      const command = [...argv];
      calls.push(command);
      const gitIndex = command.indexOf('git');
      if (gitIndex >= 0) {
        const git = command.slice(gitIndex + 1);
        const root = git.includes('-C') ? git[git.indexOf('-C') + 1] : undefined;
        assert.equal(root, `${pluginStatePath}/marketplaces/claude-plugins-official`);
        if (options.requireSafeDirectory && !git.includes(`safe.directory=${root}`)) {
          return {...result(), exitCode: 128, stderr: 'fatal: detected dubious ownership'};
        }
        if (git.includes('get-url')) return result(options.origin ?? MARKETPLACE_REPOSITORY);
        if (git.includes('show')) return result(catalog);
        assert.fail('Unexpected Git command.');
      }

      const marketplaceIndex = command.indexOf('marketplace');
      if (marketplaceIndex >= 0 && command[marketplaceIndex + 1] === 'add') {
        assert.equal(command[marketplaceIndex + 2], distribution.marketplace);
        const relative = 'marketplaces/claude-plugins-official';
        await state.mutable.writeFile(`${relative}/.git/HEAD`, Buffer.from('ref'));
        await state.mutable.writeFile(
          `${relative}/.claude-plugin/marketplace.json`,
          Buffer.from(catalog),
        );
        await state.mutable.writeFile(
          'known_marketplaces.json',
          Buffer.from(
            JSON.stringify({
              'claude-plugins-official': {
                source: {source: 'github', repo: distribution.marketplace},
                installLocation: `${pluginStatePath}/${relative}`,
              },
            }),
          ),
        );
        return result('Successfully added marketplace');
      }

      const installIndex = command.indexOf('install');
      if (installIndex >= 0) {
        const nativePluginId = command[installIndex + 1]!;
        const [plugin, marketplace] = nativePluginId.split('@');
        const version = options.installedVersion ?? LATEST_VERSION;
        const installPath = `${pluginStatePath}/cache/${marketplace}/${plugin}/${version}`;
        const relativeInstallPath = stateRelativePath(installPath, pluginStatePath);
        await state.mutable.writeFile(
          `${relativeInstallPath}/.claude-plugin/plugin.json`,
          Buffer.from(JSON.stringify({name: plugin, version})),
        );
        const plugins = readInstalledState(state);
        const commit = options.installedCommit === null
          ? undefined
          : options.installedCommit ?? (plugin === 'stripe' ? catalogSourceCommit(catalogSource) : undefined);
        plugins[nativePluginId] = [{
          scope: 'user',
          installPath,
          version,
          ...(commit === undefined ? {} : {gitCommitSha: commit}),
        }];
        if (options.extraPlugin) {
          plugins['dependency@unexpected'] = [{
            scope: 'user',
            installPath: `${pluginStatePath}/cache/unexpected/dependency/1.0.0`,
            version: '1.0.0',
          }];
        }
        await state.mutable.writeFile('installed_plugins.json', Buffer.from(
          JSON.stringify({version: 2, plugins}),
        ));
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
        const rows = Object.entries(readInstalledState(state)).map(([id, records]) => ({
          ...records[0], id, enabled: true,
          ...(options.listedInstallPath === undefined ? {} : {installPath: options.listedInstallPath}),
        }));
        return result(JSON.stringify(rows));
      }
      assert.fail('Unexpected native command.');
    },
  };
  return {commands, calls};
}

interface NativeInstalledRecord {
  scope: 'user';
  installPath: string;
  version: string;
  gitCommitSha?: string;
}

function readInstalledState(state: MemoryWorkspaceFixture): Record<string, NativeInstalledRecord[]> {
  const file = state.snapshot().get('installed_plugins.json');
  if (file === undefined) return {};
  return (JSON.parse(Buffer.from(file).toString('utf8')) as {
    plugins: Record<string, NativeInstalledRecord[]>;
  }).plugins;
}

function stateRelativePath(absolutePath: string, pluginStatePath: string): string {
  assert.ok(absolutePath.startsWith(`${pluginStatePath}/`));
  return absolutePath.slice(pluginStatePath.length + 1);
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
