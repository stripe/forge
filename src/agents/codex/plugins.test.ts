import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommandRunner } from '../../contracts/command.js';
import { parseAgentPluginInstallationReceipt } from '../../contracts/pluginReceipt.js';
import { createMemoryWorkspace } from '../../testing/memoryWorkspace.js';
import { createTestResolvedRunPlan } from '../../testing/plans.js';
import { CODEX_HOME_STATE_ID } from './layout.js';
import { createCodexPluginInstaller } from './plugins.js';

const commit = 'a'.repeat(40);
const catalogRelative = '.tmp/marketplaces/test';
const configRoot = '/home/forge/.codex';
const catalogRoot = `${configRoot}/${catalogRelative}`;
const cache = 'plugins/cache/test/fixture/1.2.3';
const distribution = { plugin: 'fixture@test', marketplace: 'example/plugins' };

function fixture(
  options: {
    source?: unknown;
    catalogPath?: string;
    manifestPath?: string;
    mutate?: (argv: readonly string[], output: unknown) => unknown;
    manifest?: Record<string, unknown>;
    existing?: Record<string, unknown>[];
    exitCode?: number;
  } = {},
) {
  const state = createMemoryWorkspace();
  const calls: string[][] = [];
  let installed = false;
  const catalog = JSON.stringify({
    name: 'test',
    plugins: [
      {
        name: 'fixture',
        source: options.source ?? {
          source: 'local',
          path: './plugins/fixture',
        },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    ],
  });
  const catalogPath = options.catalogPath ?? '.agents/plugins/marketplace.json';
  const source = options.source ?? {
    source: 'local',
    path: './plugins/fixture',
  };
  const nativeSource =
    typeof source === 'string' ||
    (source as { source?: string }).source === 'local'
      ? { source: 'local', path: `${catalogRoot}/plugins/fixture` }
      : {
          source:
            (source as { path?: string }).path === undefined
              ? 'git'
              : 'git-subdir',
          ...Object.fromEntries(
            Object.entries(source as Record<string, unknown>).filter(
              ([key]) => key !== 'source',
            ),
          ),
        };
  const row = () => ({
    pluginId: distribution.plugin,
    name: 'fixture',
    marketplaceName: 'test',
    version: '1.2.3',
    installed: true,
    enabled: true,
    source: nativeSource,
    marketplaceSource: {
      sourceType: 'git',
      source: 'https://github.com/example/plugins.git',
    },
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_INSTALL',
  });
  const commands: CommandRunner = {
    async run(argv, commandOptions) {
      assert.equal(commandOptions?.maxOutputBytes, 8 * 1024 * 1024);
      calls.push([...argv]);
      let output: unknown;
      if (argv.includes('rev-parse')) output = `${commit}\n`;
      else if (argv.includes('get-url'))
        output = 'https://github.com/example/plugins.git\n';
      else if (argv.includes('show')) output = catalog;
      else if (argv.includes('marketplace') && argv.includes('add')) {
        await state.mutable.writeFile(
          `${catalogRelative}/.git/HEAD`,
          Buffer.from(`ref: refs/heads/main\n`),
        );
        await state.mutable.writeFile(
          `${catalogRelative}/${catalogPath}`,
          Buffer.from(catalog),
        );
        await state.mutable.writeFile(
          'config.toml',
          Buffer.from(
            '[marketplaces.test]\nsource_type="git"\nsource="https://github.com/example/plugins.git"\n',
          ),
        );
        output = {
          marketplaceName: 'test',
          installedRoot: catalogRoot,
          alreadyAdded: false,
        };
      } else if (argv.includes('marketplace'))
        output = {
          marketplaces: [
            {
              name: 'test',
              root: catalogRoot,
              marketplaceSource: {
                sourceType: 'git',
                source: 'https://github.com/example/plugins.git',
              },
            },
          ],
        };
      else if (argv.includes('add')) {
        installed = true;
        await state.mutable.writeFile(
          `${cache}/${options.manifestPath ?? '.codex-plugin/plugin.json'}`,
          Buffer.from(
            JSON.stringify(
              options.manifest ?? { name: 'fixture', version: '1.2.3' },
            ),
          ),
        );
        await state.mutable.writeFile(
          'config.toml',
          Buffer.from(
            '[marketplaces.test]\nsource_type="git"\nsource="https://github.com/example/plugins.git"\n[plugins."fixture@test"]\nenabled=true\n',
          ),
        );
        output = {
          pluginId: distribution.plugin,
          name: 'fixture',
          marketplaceName: 'test',
          version: '1.2.3',
          installedPath: `${configRoot}/${cache}`,
          authPolicy: 'ON_INSTALL',
        };
      } else
        output = {
          installed: [
            ...(options.existing ?? []),
            ...(installed ? [row()] : []),
          ],
          available: [],
        };
      output = options.mutate?.(argv, output) ?? output;
      return {
        exitCode: options.exitCode ?? 0,
        stdout: typeof output === 'string' ? output : JSON.stringify(output),
        stderr: '',
        durationMs: 1,
      };
    },
  };
  const plan = createTestResolvedRunPlan({
    agent: { adapter: 'codex', provider: 'openai', model: 'test' },
  });
  const prepared = createCodexPluginInstaller({
    adapterId: 'codex',
    executable: 'codex',
  }).preflight(distribution, { selection: plan.agent, runtime: plan.runtime });
  const install = (signal = new AbortController().signal) =>
    prepared.install({
      runId: 'test',
      paths: { workspace: '/workspace', home: '/home/forge' },
      commands,
      stateDirectories: new Map([[CODEX_HOME_STATE_ID, state.mutable]]),
      signal,
    });
  return { state, calls, prepared, install };
}

describe('Codex native plugin installer', () => {
  it('binds installation without commands and shares the adapter home mount', async () => {
    const test = fixture();
    assert.equal(test.calls.length, 0);
    assert.deepEqual(test.prepared.requirements, {
      executables: ['codex', 'env', 'git'],
      stateDirectories: [
        { id: CODEX_HOME_STATE_ID, containerPath: configRoot },
      ],
    });
    const receipt = await test.install();
    assert.deepEqual(parseAgentPluginInstallationReceipt(receipt), receipt);
    assert.equal(receipt.marketplace_commit, commit);
    assert.deepEqual(receipt.source, { kind: 'marketplace-path' });
    assert.equal(receipt.installed_tree.file_count, 1);
    assert.match(receipt.installed_tree.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(
      test.calls.every((argv) => argv.includes('GIT_CONFIG_GLOBAL=/dev/null')),
    );
    assert.ok(
      test.calls.some((argv) =>
        argv.includes(`${commit}:.agents/plugins/marketplace.json`),
      ),
    );
  });

  it('accepts native legacy catalogs, path strings and unpinned HTTPS Git subdirectories', async () => {
    for (const options of [
      {
        source: './plugins/fixture',
        catalogPath: '.claude-plugin/marketplace.json',
      },
      {
        source: {
          source: 'git-subdir',
          url: 'https://github.com/example/plugin.git',
          path: 'plugin',
          ref: 'main',
        },
      },
    ]) {
      const receipt = await fixture(options).install();
      assert.equal(
        receipt.source.kind,
        typeof options.source === 'string' ? 'marketplace-path' : 'git-subdir',
      );
      assert.equal(receipt.source.commit, undefined);
    }
  });

  it('accepts all supported native catalog paths, trailing slashes and HTTPS Git roots', async () => {
    for (const catalogPath of [
      '.agents/plugins/marketplace.json',
      '.agents/plugins/api_marketplace.json',
      '.claude-plugin/marketplace.json',
      '.cursor-plugin/marketplace.json',
    ]) {
      await fixture({ catalogPath, source: './plugins/fixture/' }).install();
    }
    const receipt = await fixture({
      source: { source: 'url', url: 'https://github.com/example/plugin.git' },
    }).install();
    assert.deepEqual(receipt.source, { kind: 'url' });
  });

  it('uses native catalog precedence and rejects an unsupported Codex catalog', async () => {
    const test = fixture({ catalogPath: '.claude-plugin/marketplace.json' });
    await test.state.mutable.writeFile(
      `${catalogRelative}/.agents/plugins/marketplace.json`,
      Buffer.from('{"name":"different","plugins":[]}'),
    );
    await assert.rejects(test.install(), /catalog snapshot/);
    assert.ok(
      test.calls.some((argv) =>
        argv.includes(`${commit}:.agents/plugins/marketplace.json`),
      ),
    );
    assert.equal(
      test.calls.some(
        (argv) => argv.includes('add') && !argv.includes('marketplace'),
      ),
      false,
    );
    await assert.rejects(
      fixture({ catalogPath: '.codex-plugin/marketplace.json' }).install(),
      /supported marketplace catalog/,
    );
  });

  it('verifies native Agent Plugins manifests and rejects unsupported schema revisions', async () => {
    const manifest = {
      name: 'fixture',
      version: '1.2.3',
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    };
    await fixture({ manifestPath: 'plugin.json', manifest }).install();
    await assert.rejects(
      fixture({
        manifestPath: 'plugin.json',
        manifest: {
          ...manifest,
          $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
        },
      }).install(),
      /manifest schema/,
    );
  });

  it('preserves earlier plugin state and fails if native installation changes it', async () => {
    const existing = [
      { pluginId: 'prior@test', version: '1', installed: true, enabled: false },
    ];
    await fixture({ existing }).install();
    let installed = false;
    const test = fixture({
      existing,
      mutate(argv, output) {
        if (argv.includes('add') && !argv.includes('marketplace'))
          installed = true;
        const value = output as { installed?: Record<string, unknown>[] };
        if (installed && value.installed?.[0])
          value.installed[0] = { ...value.installed[0], enabled: true };
        return value;
      },
    });
    await assert.rejects(test.install(), /existing plugin state/);
  });

  it('stops on native command failure and cancellation before installation', async () => {
    const failed = fixture({ exitCode: 1 });
    await assert.rejects(failed.install(), /native command/);
    assert.equal(failed.calls.length, 1);
    const cancelled = fixture();
    await assert.rejects(
      cancelled.install(AbortSignal.abort(new Error('cancelled'))),
      /cancelled/,
    );
    assert.equal(cancelled.calls.length, 0);
  });

  it('rejects unprovable or unsupported sources before installing', async () => {
    for (const source of [
      '../escape',
      { source: 'local', path: './plugins/../escape' },
      { source: 'archive', url: 'https://example.test/plugin.zip' },
      { source: 'npm', package: 'fixture' },
      { source: 'github', repo: 'example/plugin' },
      {
        source: 'url',
        url: 'https://user:synthetic-secret@example.test/plugin.git',
      },
      {
        source: 'git-subdir',
        url: 'https://example.test/plugin.git',
        path: '../escape',
      },
      {
        source: 'git-subdir',
        url: 'https://example.test/plugin.git',
        path: 'plugin',
        sha: commit,
      },
    ]) {
      const test = fixture({ source });
      await assert.rejects(test.install(), /source|path/);
      assert.equal(
        test.calls.some(
          (argv) => argv.includes('add') && !argv.includes('marketplace'),
        ),
        false,
      );
    }
  });

  it('rejects wrong native identity, origin, snapshot, path, disabled state, source and extra installations', async () => {
    const mutations = [
      (argv: readonly string[], output: unknown) =>
        argv.includes('get-url')
          ? 'https://github.com/wrong/source.git'
          : output,
      (argv: readonly string[], output: unknown) =>
        argv.includes('show') ? '{"name":"wrong","plugins":[]}' : output,
      (argv: readonly string[], output: unknown) =>
        argv.includes('add') && !argv.includes('marketplace')
          ? { ...(output as object), installedPath: '/outside/cache' }
          : output,
      (_argv: readonly string[], output: unknown) => {
        const list = output as { installed?: Record<string, unknown>[] };
        if (list.installed?.length) list.installed[0]!.enabled = false;
        return output;
      },
      (_argv: readonly string[], output: unknown) => {
        const list = output as { installed?: Record<string, unknown>[] };
        if (list.installed?.length)
          list.installed[0]!.source = { source: 'local', path: '/outside' };
        return output;
      },
      (_argv: readonly string[], output: unknown) => {
        const list = output as { installed?: Record<string, unknown>[] };
        if (list.installed?.length)
          list.installed.push({ ...list.installed[0], pluginId: 'extra@test' });
        return output;
      },
    ];
    for (const mutate of mutations)
      await assert.rejects(
        fixture({ mutate }).install(),
        /verification failed/,
      );
    await assert.rejects(
      fixture({ manifest: { name: 'wrong', version: '1.2.3' } }).install(),
      /manifest/,
    );
    await assert.rejects(
      fixture({
        manifest: {
          name: 'fixture',
          version: '1.2.3',
          dependencies: ['extra'],
        },
      }).install(),
      /dependencies/,
    );
  });
});
