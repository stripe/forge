import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { AgentAdapter } from '../contracts/agent.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type { AgentPluginInstaller } from '../contracts/plugin.ts';
import { defaultForgeEngine } from '../engine.ts';
import type { PluginMcpServerId } from '../model/types.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../testing/fakes.ts';
import { createMemoryRunInputProvider } from '../testing/memoryInputs.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { executeEval, preflightEval } from './execute.ts';

function fixture(
  fail?: 'setup' | 'mcp' | 'prepare' | 'finalize' | 'cleanup',
  adapterId: 'codex' | 'claude-code' = 'codex',
) {
  const mcpServers: PluginMcpServerId[] = ['stripe'];
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter({
    id: adapterId,
    requirements: {
      executables: [],
      stateDirectories: [],
      environment: {
        credentials: {
          MODEL_KEY: { reference: credentialReference('model-key') },
        },
      },
    },
  });
  const resolutions: string[] = [];
  const checkedServers: PluginMcpServerId[] = [];
  const installer: AgentPluginInstaller = {
    supportsMcpBearerAuth: true,
    preflight(distribution, context) {
      assert.deepEqual(context.mcpServers, mcpServers);
      return {
        requirements: { executables: [], stateDirectories: [] },
        async install({ commands }) {
          await commands.run(['install']);
          if (fail === 'setup') throw new Error('install failed');
          return {
            adapter: adapterId,
            plugin: distribution.plugin,
            marketplace: distribution.marketplace,
            marketplace_commit: 'a'.repeat(40),
            native_plugin_id: distribution.plugin,
            version: '1.0.0',
            source: { kind: 'marketplace-path' },
            installed_tree: {
              format: 'forge-plugin-tree-v1',
              sha256: `sha256:${'b'.repeat(64)}`,
              entry_count: 1,
              file_count: 1,
              size_bytes: 10,
            },
          };
        },
      };
    },
    async checkMcp({ commands, servers }) {
      checkedServers.push(...servers);
      await commands.run(['check-mcp']);
      if (fail === 'mcp') throw new Error('mock-token authentication failed');
    },
  };
  const configured: AgentAdapter = {
    ...agent.adapter,
    pluginInstaller: installer,
    async prepare(context) {
      await context.runtime.commands.uncredentialed.run(['prepare']);
      if (fail === 'prepare') throw new Error('prepare failed');
      await agent.adapter.prepare(context);
    },
  };
  const plan = createTestResolvedRunPlan({
    agent: { adapter: adapterId, provider: 'openai', model: 'unused' },
    treatmentSetup: [
      {
        uses: 'forge/plugin',
        with: { plugin: 'stripe' },
      },
    ],
  });
  const composition = {
    runtime: {
      ...runtime.adapter,
      async prepare(input: Parameters<typeof runtime.adapter.prepare>[0]) {
        const prepared = await runtime.adapter.prepare(input);
        return {
          ...prepared,
          async finalizeSetup() {
            if (fail === 'finalize') throw new Error('finalize failed');
            await prepared.finalizeSetup();
          },
          async dispose() {
            await prepared.dispose();
            if (fail === 'cleanup') throw new Error('cleanup failed');
          },
        };
      },
    },
    agents: new Map([[configured.id, configured]]),
    credentialResolver: createStaticCredentialResolver(
      { 'env:STRIPE_API_KEY': 'mock-token' },
      {
        onResolve(reference) {
          resolutions.push(reference);
        },
      },
    ),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createMemoryArtifactStore().store,
  };
  return { runtime, agent, plan, composition, resolutions, checkedServers };
}

describe('runtime readiness', () => {
  it('keeps native discovery out of measured evals, including failed and unsupported checkers', async () => {
    for (const [adapterId, supported] of [
      ['codex', true],
      ['codex', false],
      ['claude-code', true],
    ] as const) {
      const test = fixture('mcp', adapterId);
      const agent = test.composition.agents.get(adapterId)!;
      const composition = {
        ...test.composition,
        credentialResolver: createStaticCredentialResolver({
          'model-key': 'mock-model-token',
          'env:STRIPE_API_KEY': 'mock-token',
        }),
        agents: new Map([
          [
            adapterId,
            {
              ...agent,
              pluginInstaller: supported
                ? agent.pluginInstaller!
                : {
                    supportsMcpBearerAuth: true as const,
                    preflight: agent.pluginInstaller!.preflight,
                  },
            },
          ],
        ]),
      };
      const completed = await defaultForgeEngine.executeEval({
        runId: `discovery-${adapterId}-${supported}`,
        plan: test.plan,
        composition,
      });
      assert.equal(completed.result.agent.session_id, 'test-session');
      assert.deepEqual(test.checkedServers, []);
      assert.ok(
        !test.runtime.runs[0]!.commands.some(
          (command) => command.argv[0] === 'check-mcp',
        ),
      );
    }
  });

  it('keeps the plugin key outside the agent environment during an evaluation', async () => {
    const test = fixture();
    test.composition.credentialResolver = createStaticCredentialResolver({
      'env:STRIPE_API_KEY': 'synthetic-plugin-key',
      'model-key': 'synthetic-model-key',
    });
    const completed = await executeEval({ ...test, runId: 'relay-evaluation' });
    const run = test.runtime.runs[0]!;
    assert.deepEqual(run.input.mcpRelayCredentials, [
      { server: 'stripe', value: 'synthetic-plugin-key' },
    ]);
    assert.equal(
      Object.hasOwn(run.input.environment.credentials, 'STRIPE_API_KEY'),
      false,
    );
    assert.deepEqual(run.input.requirements.mcpRelays, ['stripe']);
    assert.equal(
      run.commands.some(({ credentialEnvironmentNames }) =>
        credentialEnvironmentNames.includes('STRIPE_API_KEY'),
      ),
      false,
    );
    assert.ok(
      !JSON.stringify(completed.result).includes('synthetic-plugin-key'),
    );
    assert.equal(run.events.at(-1), 'dispose');
  });

  it('requires a relay-capable runtime before resolving credentials', () => {
    const test = fixture();
    const { supportsMcpCredentialRelay: _capability, ...runtime } =
      test.composition.runtime;
    assert.throws(() =>
      preflightEval({ ...test, composition: { ...test.composition, runtime } }),
    );
    assert.deepEqual(test.resolutions, []);
    assert.equal(test.runtime.runs.length, 0);
  });

  it('rejects a plugin key also declared for command environments before lookup', () => {
    const test = fixture();
    const agent = test.composition.agents.get('codex')!;
    const composition = {
      ...test.composition,
      agents: new Map([
        [
          'codex',
          {
            ...agent,
            requirements(selection: Parameters<typeof agent.requirements>[0]) {
              return {
                ...agent.requirements(selection),
                environment: {
                  credentials: {
                    API_KEY: {
                      reference: credentialReference('env:STRIPE_API_KEY'),
                    },
                  },
                },
              };
            },
          },
        ],
      ]),
    };
    assert.throws(() => preflightEval({ ...test, composition }));
    assert.deepEqual(test.resolutions, []);
  });

  it('checks MCP after setup finalization, keeps upstream keys outside command environments and skips model auth', async () => {
    const test = fixture();
    const results = await defaultForgeEngine.validateRuntime([test]);
    assert.deepEqual(test.resolutions, ['env:STRIPE_API_KEY']);
    assert.equal(results[0]?.mcp_authentication, 'verified');
    assert.equal(results[0]?.model_authentication, 'untested');
    assert.deepEqual(test.agent.events, ['prepare']);
    const run = test.runtime.runs[0]!;
    assert.deepEqual(run.input.mcpRelayCredentials, [
      { server: 'stripe', value: 'mock-token' },
    ]);
    assert.equal(
      Object.hasOwn(run.input.environment.credentials, 'STRIPE_API_KEY'),
      false,
    );
    assert.deepEqual(
      run.commands.map(({ argv, scope, credentialEnvironmentNames }) => ({
        argv,
        scope,
        credentialEnvironmentNames,
      })),
      [
        {
          argv: ['prepare'],
          scope: 'uncredentialed',
          credentialEnvironmentNames: [],
        },
        {
          argv: ['install'],
          scope: 'uncredentialed',
          credentialEnvironmentNames: [],
        },
        {
          argv: ['check-mcp'],
          scope: 'agent',
          credentialEnvironmentNames: [],
        },
      ],
    );
    assert.ok(
      run.events.indexOf('finalizeSetup') < run.events.indexOf('command:agent'),
    );
    assert.equal(run.events.at(-1), 'dispose');
  });

  it('rejects a missing native MCP checker before credential lookup or allocation', async () => {
    const test = fixture();
    const agent = test.composition.agents.get('codex')!;
    test.composition.agents.set('codex', {
      ...agent,
      pluginInstaller: {
        supportsMcpBearerAuth: true,
        preflight: agent.pluginInstaller!.preflight,
      },
    });
    await assert.rejects(
      defaultForgeEngine.validateRuntime([test]),
      /does not support native MCP readiness checks/,
    );
    assert.deepEqual(test.resolutions, []);
    assert.equal(test.runtime.runs.length, 0);
  });

  it('redacts relay capabilities from native readiness errors', async () => {
    const test = fixture();
    const agent = test.composition.agents.get('codex')!;
    test.composition.agents.set('codex', {
      ...agent,
      pluginInstaller: {
        ...agent.pluginInstaller!,
        async checkMcp() {
          throw new Error(
            `Native auth rejected ${test.runtime.runs[0]!.prepared.pluginMcpConnections!.stripe!.token}`,
          );
        },
      },
    });
    await assert.rejects(
      defaultForgeEngine.validateRuntime([test]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Native auth rejected \[REDACTED\]/);
        assert.ok(!error.message.includes('a'.repeat(64)));
        return true;
      },
    );
    assert.equal(test.runtime.runs[0]?.events.at(-1), 'dispose');
  });

  it('checks the code-owned MCP servers for the plugin, not receipt-supplied ones', async () => {
    const test = fixture();
    await defaultForgeEngine.validateRuntime([test]);
    assert.deepEqual(test.checkedServers, ['stripe']);
  });

  for (const [field, value] of [
    ['adapter', 'claude-code'],
    ['plugin', 'other@stripe'],
    ['marketplace', 'example/plugins'],
    ['native_plugin_id', 'other@stripe'],
  ] as const)
    it(`rejects readiness for a receipt with a mismatched ${field}`, async () => {
      const test = fixture();
      const agent = test.composition.agents.get('codex')!;
      const installer = agent.pluginInstaller!;
      test.composition.agents.set('codex', {
        ...agent,
        pluginInstaller: {
          ...installer,
          preflight(distribution, context) {
            const prepared = installer.preflight(distribution, context);
            return {
              ...prepared,
              async install(input) {
                return { ...(await prepared.install(input)), [field]: value };
              },
            };
          },
        },
      });
      await assert.rejects(
        defaultForgeEngine.validateRuntime([test]),
        /receipt does not match the expected plugin and authentication/,
      );
      assert.equal(test.runtime.runs[0]?.events.at(-1), 'dispose');
      assert.ok(
        !test.runtime.runs[0]?.commands.some(
          ({ argv }) => argv[0] === 'check-mcp',
        ),
      );
    });

  it('preflights all selections before lookup and resolves all tokens before allocation', async () => {
    const first = fixture();
    const second = fixture();
    second.composition.credentialResolver = createStaticCredentialResolver({});
    await assert.rejects(
      defaultForgeEngine.validateRuntime([first, second]),
      /credentials/,
    );
    assert.equal(first.runtime.runs.length, 0);
    assert.equal(second.runtime.runs.length, 0);
    first.resolutions.length = 0;
    await assert.rejects(
      defaultForgeEngine.validateRuntime([
        first,
        {
          ...second,
          plan: {
            ...second.plan,
            agent: { ...second.plan.agent, adapter: 'missing' },
          },
        },
      ]),
      /agent|plan/,
    );
    assert.deepEqual(first.resolutions, []);
  });

  for (const stage of [
    'setup',
    'mcp',
    'prepare',
    'finalize',
    'cleanup',
  ] as const)
    it(`cleans up after a ${stage} failure without exposing tokens`, async () => {
      const test = fixture(stage);
      await assert.rejects(
        defaultForgeEngine.validateRuntime([test]),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /readiness|cleanup/);
          assert.ok(!error.message.includes('[object Object]'));
          if (stage === 'mcp')
            assert.match(error.message, /\[REDACTED\] authentication failed/);
          assert.ok(!error.message.includes('mock-token'));
          return true;
        },
      );
      assert.equal(test.runtime.runs[0]?.events.at(-1), 'dispose');
    });

  it('honors cancellation before allocating', async () => {
    const test = fixture();
    await assert.rejects(
      defaultForgeEngine.validateRuntime([test], AbortSignal.abort()),
    );
    assert.equal(test.runtime.runs.length, 0);
  });

  it('redacts a resolved token if cancellation interrupts the remaining resolution', async () => {
    const test = fixture();
    const secret = 'partially-resolved-synthetic-token';
    const controller = new AbortController();
    test.composition.credentialResolver = {
      async resolve() {
        controller.abort(
          new Error(`Credential lookup interrupted after ${secret}`),
        );
        return secret;
      },
    };
    await assert.rejects(
      defaultForgeEngine.validateRuntime([test], controller.signal),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /credentials: Credential lookup interrupted after \[REDACTED\]/,
        );
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    assert.equal(test.runtime.runs.length, 0);
  });

  it('reports invalid host resolver values at the credential stage', async () => {
    const test = fixture();
    test.composition.credentialResolver = {
      async resolve() {
        return null as unknown as string;
      },
    };
    await assert.rejects(
      defaultForgeEngine.validateRuntime([test]),
      /Runtime readiness failed at credentials: Credential resolver returned an invalid value/,
    );
    assert.equal(test.runtime.runs.length, 0);
  });
});
