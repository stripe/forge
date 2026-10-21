import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { ForgeComposition } from '../contracts/composition.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type { RuntimeAdapter } from '../contracts/runtime.ts';
import type { ForgeExternalRuntimeV1 } from '../model/types.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../testing/fakes.ts';
import { createMemoryRunInputProvider } from '../testing/memoryInputs.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { executeEval, preflightEval } from './execute.ts';

const selected: ForgeExternalRuntimeV1 = {
  adapter: 'acme/process',
  platform: 'linux/amd64',
  config: { profile: 'test' },
};

function fixture(
  runtime: RuntimeAdapter,
  agentId = 'test-agent',
): {
  composition: ForgeComposition;
  resolutions: string[];
} {
  const resolutions: string[] = [];
  const agent = createScriptedAgentAdapter({
    id: agentId,
    requirements: {
      executables: ['test-agent'],
      stateDirectories: [
        { id: 'agent-state', containerPath: '/run/agent-state' },
      ],
      environment: {
        credentials: {
          AGENT_TOKEN: { reference: credentialReference('test.token') },
        },
      },
    },
  });
  return {
    resolutions,
    composition: {
      runtime,
      agents: new Map([[agent.adapter.id, agent.adapter]]),
      credentialResolver: createStaticCredentialResolver(
        { 'test.token': 'test-only-value' },
        { onResolve: (reference) => resolutions.push(reference) },
      ),
      stripeKeyProvisioner: {
        async provisionKey(recipe) {
          resolutions.push(`provision:${recipe}`);
          return 'rk_test_only_value';
        },
      },
      inputProvider: createMemoryRunInputProvider(),
      artifactStore: createMemoryArtifactStore().store,
    },
  };
}

describe('runtime composition preflight', () => {
  it('supplies frozen merged requirements and the exact external configuration without resolving authority', () => {
    const fake = createFakeRuntimeAdapter({ id: selected.adapter });
    let calls = 0;
    const current = fixture(
      {
        ...fake.adapter,
        preflight({ plan, requirements, environment }) {
          calls += 1;
          assert.deepEqual(plan.runtime, selected);
          assert(Object.isFrozen(plan.runtime));
          assert(Object.isFrozen(requirements));
          assert(Object.isFrozen(requirements.stateDirectories));
          assert(Object.isFrozen(environment));
          assert(Object.isFrozen(environment.credentials));
          assert.deepEqual(environment.credentials, {
            AGENT_TOKEN: { reference: 'test.token', scopes: ['agent'] },
            STRIPE_API_KEY: {
              reference: 'stripe-merchant:default',
              scopes: ['agent'],
            },
          });
          assert.equal(
            JSON.stringify(environment).includes('test-only-value'),
            false,
          );
          assert.deepEqual(requirements.executables, [
            'plugin-install',
            'test-agent',
          ]);
          assert.deepEqual(requirements.stateDirectories, [
            { id: 'agent-state', containerPath: '/run/agent-state' },
            {
              id: 'plugin-state',
              containerPath: '/run/plugin-state',
              sealAfterSetup: true,
            },
          ]);
        },
      },
      'codex',
    );
    const plan = createTestResolvedRunPlan({
      runtime: selected,
      agent: { adapter: 'codex', provider: 'openai', model: 'test' },
      merchant: { recipe: 'default' },
      caseSetup: [
        {
          uses: 'forge/plugin',
          with: { plugin: 'stripe' },
        },
      ],
    });
    const baseAgent = current.composition.agents.get('codex')!;
    preflightEval({
      plan,
      composition: {
        ...current.composition,
        agents: new Map([
          [
            baseAgent.id,
            {
              ...baseAgent,
              pluginInstaller: {
                supportsMcpBearerAuth: true,
                preflight() {
                  return {
                    requirements: {
                      executables: ['plugin-install'],
                      stateDirectories: [
                        {
                          id: 'plugin-state',
                          containerPath: '/run/plugin-state',
                          sealAfterSetup: true,
                        },
                      ],
                    },
                    async install() {
                      throw new Error('Pure preflight must not install.');
                    },
                  };
                },
              },
            },
          ],
        ]),
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(current.resolutions, []);
    assert.equal(fake.runs.length, 0);
  });

  it('rejects unsupported named-plugin agents before credentials, installation, or runtime preparation', async () => {
    const runtime = createFakeRuntimeAdapter({ id: selected.adapter });
    const current = fixture(runtime.adapter);
    const baseAgent = current.composition.agents.get('test-agent')!;
    let installerCalled = false;
    const composition = {
      ...current.composition,
      agents: new Map([
        [
          baseAgent.id,
          {
            ...baseAgent,
            pluginInstaller: {
              supportsMcpBearerAuth: true as const,
              preflight() {
                installerCalled = true;
                throw new Error(
                  'Unsupported plugin must not reach the installer.',
                );
              },
            },
          },
        ],
      ]),
    };
    const plan = createTestResolvedRunPlan({
      runtime: selected,
      merchant: { recipe: 'default' },
      treatmentSetup: [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }],
    });
    assert.throws(() => preflightEval({ plan, composition }));
    await assert.rejects(
      executeEval({ runId: 'unsupported-plugin', plan, composition }),
    );
    assert.equal(installerCalled, false);
    assert.deepEqual(current.resolutions, []);
    assert.equal(runtime.runs.length, 0);
  });

  for (const [label, merchant, environment] of [
    [
      'a conflicting credential',
      { recipe: 'default' },
      {
        credentials: {
          STRIPE_API_KEY: { reference: credentialReference('test.token') },
        },
      },
    ],
    [
      'the merchant reference',
      { recipe: 'default' },
      {
        credentials: {
          STRIPE_API_KEY: {
            reference: credentialReference('stripe-merchant:default'),
          },
        },
      },
    ],
    [
      'a plain variable',
      { recipe: 'default' },
      { variables: { STRIPE_API_KEY: 'x' } },
    ],
    [
      'a credential without a merchant',
      undefined,
      {
        credentials: {
          STRIPE_API_KEY: { reference: credentialReference('test.token') },
        },
      },
    ],
  ] as const) {
    it(`rejects STRIPE_API_KEY from ${label} before credentials or runtime`, async () => {
      const runtime = createFakeRuntimeAdapter({ id: selected.adapter });
      const current = fixture(runtime.adapter);
      const agent = createScriptedAgentAdapter({
        id: 'test-agent',
        requirements: { executables: [], stateDirectories: [], environment },
      });
      const composition = {
        ...current.composition,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
      };
      const plan = createTestResolvedRunPlan({
        runtime: selected,
        ...(merchant === undefined ? {} : { merchant }),
      });
      assert.throws(
        () => preflightEval({ plan, composition }),
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          /STRIPE_API_KEY comes only from the experiment merchant/.test(
            error.cause.message,
          ),
      );
      await assert.rejects(
        executeEval({ runId: 'conflicting-merchant', plan, composition }),
        { code: 'invalid_plan', phase: 'preflight' },
      );
      assert.deepEqual(current.resolutions, []);
      assert.equal(runtime.runs.length, 0);
    });
  }

  it('requires a key provisioner when a merchant is planned', async () => {
    const runtime = createFakeRuntimeAdapter({ id: selected.adapter });
    const { stripeKeyProvisioner: _, ...composition } = fixture(
      runtime.adapter,
    ).composition;
    const plan = createTestResolvedRunPlan({
      runtime: selected,
      merchant: { recipe: 'default' },
    });
    assert.throws(() => preflightEval({ plan, composition }), {
      code: 'unsupported_capability',
      message: /supply composition.stripeKeyProvisioner/,
    });
    await assert.rejects(
      executeEval({ runId: 'missing-provisioner', plan, composition }),
      { code: 'unsupported_capability', phase: 'preflight' },
    );
    assert.equal(runtime.runs.length, 0);
  });

  it('rejects identity mismatches, absent validation and invalid config before credentials or prepare', async () => {
    const fake = createFakeRuntimeAdapter({ id: selected.adapter });
    const variants: RuntimeAdapter[] = [
      { ...fake.adapter, id: 'acme/other' },
      { id: fake.adapter.id, prepare: fake.adapter.prepare } as RuntimeAdapter,
      {
        ...fake.adapter,
        preflight() {
          throw new TypeError('Unknown execution profile.');
        },
      },
      {
        ...fake.adapter,
        async preflight() {
          throw new TypeError('Async validation is unsupported.');
        },
      },
    ];
    for (const runtime of variants) {
      const current = fixture(runtime);
      await assert.rejects(
        executeEval({
          runId: 'preflight-only',
          plan: createTestResolvedRunPlan({ runtime: selected }),
          composition: current.composition,
        }),
      );
      assert.deepEqual(current.resolutions, []);
      assert.equal(fake.runs.length, 0);
    }
  });

  it('rejects substituting a different runtime into a Docker plan', () => {
    const fake = createFakeRuntimeAdapter({ id: selected.adapter });
    const current = fixture(fake.adapter);
    assert.throws(() =>
      preflightEval({
        plan: createTestResolvedRunPlan(),
        composition: current.composition,
      }),
    );
    assert.deepEqual(current.resolutions, []);
  });

  it('accepts only the built-in Docker identity without rewriting the plan', () => {
    const plan = createTestResolvedRunPlan();
    const before = JSON.stringify(plan);
    preflightEval({
      plan,
      composition: fixture(createFakeRuntimeAdapter().adapter).composition,
    });
    assert.equal(JSON.stringify(plan), before);
    assert.throws(() =>
      preflightEval({
        plan,
        composition: fixture(createFakeRuntimeAdapter({ id: 'docker' }).adapter)
          .composition,
      }),
    );
  });
});
