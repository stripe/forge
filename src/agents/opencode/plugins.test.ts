import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CommandRunner } from '../../contracts/command.ts';
import { parseAgentPluginInstallationReceipt } from '../../contracts/pluginReceipt.ts';
import type { MutableWorkspace } from '../../contracts/runtime.ts';
import { pluginDefinitionForAgent } from '../../model/plugins.ts';
import {
  createMemoryWorkspace,
  createTestResolvedRunPlan,
} from '../../testing/index.ts';
import { OPENCODE_STATE_ID, resolveOpenCodeLayout } from './layout.ts';
import {
  mergeStripeOpenCodeConfiguration,
  PLUGIN_CONFIG_PATH,
  PLUGIN_ROOT,
  stripeBundleVersion,
  stripeOpenCodeConfiguration,
} from './pluginConfig.ts';
import {
  createOpenCodePluginInstaller,
  stripeCatalogSourceCommit,
} from './plugins.ts';

const sourceCommit = 'a'.repeat(40);
const catalogCommit = 'b'.repeat(40);
const source = {
  source: 'git-subdir',
  url: 'https://github.com/stripe/ai.git',
  path: 'providers/claude/plugin',
  ref: 'main',
  sha: sourceCommit,
};
const catalog = {
  name: 'claude-plugins-official',
  plugins: [{ name: 'stripe', source }],
};
const manifest = {
  name: 'stripe',
  version: '1.2.3',
  hooks: './hooks/hooks.json',
  commands: ['./commands/test.md'],
  agents: ['./agents/test.md'],
};
const mcp = {
  mcpServers: {
    stripe: { type: 'http', url: 'https://mcp.stripe.com' },
  },
};
const layout = resolveOpenCodeLayout(undefined);
const files = {
  '.claude-plugin/plugin.json': JSON.stringify(manifest),
  '.mcp.json': JSON.stringify(mcp),
  'skills/stripe-test/SKILL.md':
    '---\nname: stripe-test\ndescription: Test Stripe integration.\n---\nRead this skill.',
  'skills/stripe-test/references/test.md': 'Use the bundled Stripe MCP server.',
  'hooks/hooks.json': JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'exit 1' }] }],
    },
  }),
  'commands/test.md': 'A Claude command that must not be registered.',
  'agents/test.md': 'A Claude agent that must not be registered.',
};

function fixture(
  options: { checkoutCommit?: string; files?: Record<string, string> } = {},
) {
  const state = createMemoryWorkspace(
    Object.fromEntries(
      Object.entries(options.files ?? files).map(([name, content]) => [
        `stripe-source/${source.path}/${name}`,
        content,
      ]),
    ),
  );
  const calls: string[][] = [];
  const commands: CommandRunner = {
    async run(argv) {
      calls.push([...argv]);
      const stdout = argv.includes('show')
        ? JSON.stringify(catalog)
        : argv.includes('rev-parse')
          ? `${
              argv.includes(`${layout.stateDirectory}/stripe-catalog`)
                ? catalogCommit
                : (options.checkoutCommit ?? sourceCommit)
            }\n`
          : '';
      return { stdout, stderr: '', exitCode: 0, durationMs: 0 };
    },
  };
  const definition = pluginDefinitionForAgent('stripe', 'opencode')!;
  const prepared = createOpenCodePluginInstaller({
    adapterId: 'opencode',
    layout,
  }).preflight(definition.distribution, {
    selection: {
      adapter: 'opencode',
      provider: 'openai-compatible',
      model: 'test',
    },
    runtime: createTestResolvedRunPlan().runtime,
    mcpServers: definition.mcpServers,
  });
  return {
    state,
    calls,
    prepared,
    install: (
      workspace: MutableWorkspace = state.mutable,
      signal = new AbortController().signal,
    ) =>
      prepared.install({
        runId: 'test',
        paths: { workspace: layout.workspace, home: layout.home },
        stateDirectories: new Map([[OPENCODE_STATE_ID, workspace]]),
        commands,
        signal,
      }),
  };
}

describe('OpenCode Stripe bundle installation', () => {
  it('loads skills and MCP from the selected Claude bundle without running its other behavior', async () => {
    const test = fixture();
    assert.equal(test.calls.length, 0);
    const receipt = await test.install();
    assert.equal(receipt.installation, 'opencode-bundle');
    assert.equal(receipt.marketplace_commit, catalogCommit);
    assert.equal(receipt.version, manifest.version);
    assert.deepEqual(receipt.dropped_parts, ['hooks', 'commands', 'agents']);
    assert.deepEqual(receipt.source, {
      kind: 'git-subdir',
      commit: sourceCommit,
      path: source.path,
    });
    assert.equal(Object.hasOwn(receipt, 'native_plugin_id'), false);
    assert.deepEqual(parseAgentPluginInstallationReceipt(receipt), receipt);
    assert.equal(receipt.installed_tree.file_count, 8);
    const config = JSON.parse(
      Buffer.from(
        await test.state.readonly.readFile(PLUGIN_CONFIG_PATH),
      ).toString(),
    );
    assert.deepEqual(config, {
      skills: {
        paths: [`${layout.stateDirectory}/plugins/stripe/bundle/skills`],
      },
      mcp: {
        stripe: {
          type: 'remote',
          url: mcp.mcpServers.stripe.url,
          enabled: true,
          oauth: false,
          headers: { Authorization: 'Bearer {env:STRIPE_API_KEY}' },
        },
      },
    });
    assert.ok(
      test.calls.some(
        (argv) => argv.includes('fetch') && argv.at(-1) === sourceCommit,
      ),
    );
    assert.ok(
      test.calls.some(
        (argv) =>
          argv.includes('sparse-checkout') && argv.at(-1) === source.path,
      ),
    );
    assert.ok(
      test.calls.every(
        (argv) =>
          argv[4] === 'git' && !argv.join(' ').includes('STRIPE_API_KEY'),
      ),
    );
    for (const [name, body] of Object.entries(files))
      assert.equal(
        Buffer.from(
          await test.state.readonly.readFile(`${PLUGIN_ROOT}/bundle/${name}`),
        ).toString(),
        body,
      );
  });

  it('fails closed on changed or unpinned catalogs', () => {
    for (const patch of [
      { sha: undefined },
      { sha: 'main' },
      { url: 'https://other.example/repo.git' },
      { path: '../plugin' },
      { source: 'url' },
    ])
      assert.throws(() =>
        stripeCatalogSourceCommit({
          ...catalog,
          plugins: [{ name: 'stripe', source: { ...source, ...patch } }],
        }),
      );
    assert.throws(() =>
      stripeCatalogSourceCommit({
        ...catalog,
        plugins: [...catalog.plugins, ...catalog.plugins],
      }),
    );
    assert.throws(() => stripeCatalogSourceCommit({ ...catalog, plugins: [] }));
  });

  it('rejects a checkout that differs from the catalog pin and cancellation', async () => {
    await assert.rejects(
      fixture({ checkoutCommit: 'c'.repeat(40) }).install(),
      /source pin/,
    );
    const test = fixture();
    await assert.rejects(
      test.install(undefined, AbortSignal.abort()),
      /abort/i,
    );
    assert.equal(test.calls.length, 0);
  });

  it('rejects missing skills, unsafe filesystem entries, and unsupported MCP overrides', async () => {
    await assert.rejects(
      fixture({
        files: { '.claude-plugin/plugin.json': JSON.stringify(manifest) },
      }).install(),
      /no skills/,
    );
    const test = fixture();
    await assert.rejects(
      test.install({
        ...test.state.mutable,
        async listFiles(options) {
          return [
            ...(await test.state.mutable.listFiles(options)),
            {
              path: `stripe-source/${source.path}/link`,
              kind: 'symlink',
            },
          ];
        },
      }),
      /unsupported filesystem/,
    );
    for (const override of [
      { mcpServers: './other-mcp.json' },
      { skills: './other-skills' },
      { name: 'other-plugin' },
      { version: '../unsafe' },
    ])
      assert.throws(
        () => stripeBundleVersion({ ...manifest, ...override }),
        /manifest/,
      );
    assert.throws(
      () =>
        stripeOpenCodeConfiguration(
          {
            ...mcp,
            mcpServers: {
              stripe: {
                ...mcp.mcpServers.stripe,
                headers: { Authorization: 'embedded-key' },
              },
            },
          },
          layout.stateDirectory,
        ),
      /MCP configuration/,
    );
  });

  it('binds bundle receipts strictly and rejects mixed native/materialized identities', async () => {
    const receipt = await fixture().install();
    for (const changed of [
      { ...receipt, native_plugin_id: receipt.plugin },
      { ...receipt, installation: 'other' },
      { ...receipt, source: { ...receipt.source, commit: 'main' } },
      {
        ...receipt,
        source: { ...receipt.source, path: 'providers/agent-plugins/plugin' },
      },
    ])
      assert.throws(() => parseAgentPluginInstallationReceipt(changed));
  });
});

describe('OpenCode installed plugin configuration', () => {
  const installed = JSON.stringify(
    stripeOpenCodeConfiguration(mcp, layout.stateDirectory),
  );
  it('combines generated model configuration with skills and MCP without mutating inputs', () => {
    const generated = JSON.stringify({
      provider: { forge: { models: { test: {} } } },
    });
    const result = JSON.parse(
      mergeStripeOpenCodeConfiguration(
        generated,
        installed,
        layout.stateDirectory,
      ),
    );
    assert.deepEqual(result.provider, JSON.parse(generated).provider);
    assert.deepEqual(result.skills.paths, [
      `${layout.stateDirectory}/${PLUGIN_ROOT}/bundle/skills`,
    ]);
    assert.equal(result.mcp.stripe.url, mcp.mcpServers.stripe.url);
  });
  it('rejects model changes in the installed fragment', () => {
    assert.throws(
      () =>
        mergeStripeOpenCodeConfiguration(
          '{}',
          JSON.stringify({ ...JSON.parse(installed), model: 'other' }),
          layout.stateDirectory,
        ),
      /installed/,
    );
  });
});
