import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {ForgeComposition} from '../contracts/composition.js';
import {credentialReference} from '../contracts/credentials.js';
import type {RuntimeAdapter} from '../contracts/runtime.js';
import type {ForgeExternalRuntimeV1} from '../model/types.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../testing/fakes.js';
import {createMemoryRunInputProvider} from '../testing/memoryInputs.js';
import {createTestResolvedRunPlan} from '../testing/plans.js';
import {executeEval, preflightEval} from './execute.js';

const selected: ForgeExternalRuntimeV1 = {
  adapter: 'acme/process', adapter_version: '1', config_version: 1,
  platform: 'linux/amd64', config: {profile: 'test-v1'},
};

function fixture(runtime: RuntimeAdapter): {composition: ForgeComposition; resolutions: string[]} {
  const resolutions: string[] = [];
  const agent = createScriptedAgentAdapter({requirements: {
    executables: ['test-agent'],
    stateDirectories: [{id: 'agent-state', containerPath: '/run/agent-state'}],
    environment: {credentials: {AGENT_TOKEN: {reference: credentialReference('test.token')}}},
  }});
  return {
    resolutions,
    composition: {
      runtime,
      agents: new Map([[agent.adapter.id, agent.adapter]]),
      credentialResolver: createStaticCredentialResolver(
        {'test.token': 'test-only-value'}, {onResolve: (reference) => resolutions.push(reference)},
      ),
      inputProvider: createMemoryRunInputProvider(),
      artifactStore: createMemoryArtifactStore().store,
    },
  };
}

describe('runtime composition preflight', () => {
  it('supplies frozen merged requirements and the exact external configuration without resolving authority', () => {
    const fake = createFakeRuntimeAdapter({id: selected.adapter});
    let calls = 0;
    const current = fixture({...fake.adapter, preflight({plan, requirements, environment}) {
      calls += 1;
      assert.deepEqual(plan.runtime, selected);
      assert(Object.isFrozen(plan.runtime));
      assert(Object.isFrozen(requirements));
      assert(Object.isFrozen(requirements.stateDirectories));
      assert(Object.isFrozen(environment));
      assert(Object.isFrozen(environment.credentials));
      assert.deepEqual(environment.credentials, {
        AGENT_TOKEN: {reference: 'test.token', scopes: ['agent']},
      });
      assert.equal(JSON.stringify(environment).includes('test-only-value'), false);
      assert.deepEqual(requirements.executables, ['plugin-install', 'test-agent']);
      assert.deepEqual(requirements.stateDirectories, [
        {id: 'agent-state', containerPath: '/run/agent-state'},
        {id: 'plugin-state', containerPath: '/run/plugin-state', sealAfterSetup: true},
      ]);
    }});
    const plan = createTestResolvedRunPlan({runtime: selected, caseSetup: [{
      uses: 'forge/plugin@1', with: {agents: {
        'test-agent': {plugin: 'example@marketplace', marketplace: 'acme/plugins'},
      }},
    }]});
    const baseAgent = current.composition.agents.get('test-agent')!;
    preflightEval({plan, composition: {
      ...current.composition,
      agents: new Map([[baseAgent.id, {
        ...baseAgent,
        pluginInstaller: {
          preflight() {
            return {
              requirements: {
                executables: ['plugin-install'],
                stateDirectories: [{id: 'plugin-state', containerPath: '/run/plugin-state', sealAfterSetup: true}],
              },
              async install() {throw new Error('Pure preflight must not install.');},
            };
          },
        },
      }]]),
    }});
    assert.equal(calls, 1);
    assert.deepEqual(current.resolutions, []);
    assert.equal(fake.runs.length, 0);
  });

  it('rejects identity/version mismatches, absent validation and invalid config before credentials or prepare', async () => {
    const fake = createFakeRuntimeAdapter({id: selected.adapter});
    const variants: RuntimeAdapter[] = [
      {...fake.adapter, id: 'acme/other'},
      {...fake.adapter, version: '2'},
      {id: fake.adapter.id, version: fake.adapter.version, prepare: fake.adapter.prepare},
      {...fake.adapter, preflight() {throw new TypeError('Unknown execution profile.');}},
      {...fake.adapter, async preflight() {throw new TypeError('Async validation is unsupported.');}},
    ];
    for (const runtime of variants) {
      const current = fixture(runtime);
      await assert.rejects(executeEval({
        runId: 'preflight-only', plan: createTestResolvedRunPlan({runtime: selected}),
        composition: current.composition,
      }));
      assert.deepEqual(current.resolutions, []);
      assert.equal(fake.runs.length, 0);
    }
  });

  it('rejects substituting a different runtime into a legacy Docker plan', () => {
    const fake = createFakeRuntimeAdapter({id: selected.adapter});
    const current = fixture(fake.adapter);
    assert.throws(() => preflightEval({
      plan: createTestResolvedRunPlan(), composition: current.composition,
    }));
    assert.deepEqual(current.resolutions, []);
  });

  it('accepts both historical Docker identifiers without rewriting the plan', () => {
    for (const id of ['docker', 'forge/docker']) {
      const runtime = createFakeRuntimeAdapter({id}).adapter;
      const current = fixture(runtime);
      const plan = createTestResolvedRunPlan();
      const before = JSON.stringify(plan);
      preflightEval({plan, composition: current.composition});
      assert.equal(JSON.stringify(plan), before);
    }
  });
});
