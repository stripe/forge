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
  BUNDLE_SOURCE_PATH,
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
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'stripe',
  version: '1.2.3',
};
const mcp = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    stripe: { type: 'streamable-http', url: 'https://mcp.stripe.com' },
  },
};
const layout = resolveOpenCodeLayout(undefined);
const files = {
  'plugin.json': JSON.stringify(manifest),
  'mcp.json': JSON.stringify(mcp),
  'skills/stripe-test/SKILL.md':
    '---\nname: stripe-test\ndescription: Test Stripe integration.\n---\nRead this skill.',
};

function fixture(
  options: { checkoutCommit?: string; files?: Record<string, string> } = {},
) {
  const state = createMemoryWorkspace(
    Object.fromEntries(
      Object.entries(options.files ?? files).map(([name, content]) => [
        `stripe-source/${BUNDLE_SOURCE_PATH}/${name}`,
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
  it('binds without I/O and materializes the catalog pin with auditable config and contents', async () => {
    const test = fixture();
    assert.equal(test.calls.length, 0);
    const receipt = await test.install();
    assert.equal(receipt.installation, 'opencode-bundle');
    assert.equal(receipt.marketplace_commit, catalogCommit);
    assert.deepEqual(receipt.source, {
      kind: 'git-subdir',
      commit: sourceCommit,
      path: BUNDLE_SOURCE_PATH,
    });
    assert.equal(Object.hasOwn(receipt, 'native_plugin_id'), false);
    assert.deepEqual(parseAgentPluginInstallationReceipt(receipt), receipt);
    assert.equal(receipt.installed_tree.file_count, 4);
    const config = JSON.parse(
      Buffer.from(
        await test.state.readonly.readFile(PLUGIN_CONFIG_PATH),
      ).toString(),
    );
    assert.equal(
      config.mcp.stripe.headers.Authorization,
      'Bearer {env:STRIPE_API_KEY}',
    );
    assert.equal(config.mcp.stripe.oauth, false);
    assert.ok(
      test.calls.some(
        (argv) => argv.includes('fetch') && argv.at(-1) === sourceCommit,
      ),
    );
    assert.ok(
      test.calls.every((argv) => !argv.join(' ').includes('STRIPE_API_KEY')),
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

  it('rejects unsupported behavior, missing skills, and unsafe filesystem entries', async () => {
    await assert.rejects(
      fixture({ files: { ...files, 'hooks/hooks.json': '{}' } }).install(),
      /unsupported agent behavior/,
    );
    await assert.rejects(
      fixture({ files: { 'plugin.json': JSON.stringify(manifest) } }).install(),
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
              path: `stripe-source/${BUNDLE_SOURCE_PATH}/link`,
              kind: 'symlink',
            },
          ];
        },
      }),
      /unsupported filesystem/,
    );
    assert.throws(
      () => stripeBundleVersion({ ...manifest, hooks: {} }),
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
        source: { ...receipt.source, path: 'providers/claude/plugin' },
      },
    ])
      assert.throws(() => parseAgentPluginInstallationReceipt(changed));
  });
});

describe('OpenCode installed plugin configuration', () => {
  const installed = JSON.stringify(
    stripeOpenCodeConfiguration(mcp, layout.stateDirectory),
  );
  it('combines authored model configuration with skills and MCP without mutating inputs', () => {
    const authored = JSON.stringify({
      provider: { forge: { models: { test: {} } } },
      skills: { paths: ['/workspace/skills'] },
    });
    const result = JSON.parse(
      mergeStripeOpenCodeConfiguration(
        authored,
        installed,
        layout.stateDirectory,
      ),
    );
    assert.deepEqual(result.provider, JSON.parse(authored).provider);
    assert.deepEqual(result.skills.paths, [
      '/workspace/skills',
      `${layout.stateDirectory}/${PLUGIN_ROOT}/bundle/skills`,
    ]);
    assert.equal(result.mcp.stripe.url, mcp.mcpServers.stripe.url);
  });
  it('rejects an authored Stripe override or model changes in the installed fragment', () => {
    assert.throws(
      () =>
        mergeStripeOpenCodeConfiguration(
          '{"mcp":{"stripe":{"enabled":false}}}',
          installed,
          layout.stateDirectory,
        ),
      /conflicts/,
    );
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
