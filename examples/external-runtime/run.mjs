import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createArtifactStore, executeEval, verifyCompletedRun} from '@stripe/forge';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '@stripe/forge/testing';

const descriptor = {
  adapter: 'example/memory',
  adapter_version: '1',
  config_version: 1,
  platform: 'linux/amd64',
  config: {profile: 'offline-example-v1'},
};
const runtime = createFakeRuntimeAdapter({id: descriptor.adapter});
const agent = createScriptedAgentAdapter();
const completed = await executeEval({
  runId: `external-${randomUUID()}`,
  plan: createTestResolvedRunPlan({runtime: descriptor}),
  composition: {
    runtime: {
      ...runtime.adapter,
      preflight({plan, requirements}) {
        assert.deepEqual(plan.runtime, descriptor);
        assert.deepEqual(requirements, {executables: [], stateDirectories: []});
      },
    },
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({
      root: fileURLToPath(new URL('../../results/external-runtime/', import.meta.url)),
    }),
  },
});
const verified = await verifyCompletedRun(completed.location);
console.log(JSON.stringify({location: verified.location, runtime: verified.result.runtime}));
