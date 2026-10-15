import { defaultForgeEngine } from '../../src/engine.js';
import { runExperiment } from '../../src/experiment.js';
import { createArtifactStore } from '../../src/results/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../../src/testing/index.js';

const root = process.argv[2]!;
const resume = process.argv[3] === 'resume';
const plans = ['first', 'interrupted', 'pending'].map((id) =>
  createTestResolvedRunPlan({ caseId: `testing/${id}` }),
);

function composition() {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter();
  return {
    runtime: runtime.adapter,
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    inputProvider: createMemoryRunInputProvider(),
    credentialResolver: createStaticCredentialResolver(),
    artifactStore: createArtifactStore({ root }),
  };
}

let nextId = 0;
const summary = await runExperiment({
  root,
  plans,
  resume,
  jobs: 1,
  composition: composition(),
  engine: defaultForgeEngine,
  signal: new AbortController().signal,
  progress: () => undefined,
  runIdFactory: () => `${resume ? 'resumed' : 'crashed'}-${++nextId}`,
  async execute(input) {
    if (!resume && input.plan.selection.case_id === 'testing/interrupted') {
      // Reservation is already durable when execute is called. Keep the real
      // owner process alive until the parent kills it, without allocating a runtime.
      setInterval(() => undefined, 1_000);
      process.send!({ type: 'reserved', run_id: input.runId });
      return await new Promise<never>(() => undefined);
    }
    return defaultForgeEngine.executeEval({
      ...input,
      composition: composition(),
    });
  },
});
process.send!({ type: 'completed', summary }, () => process.disconnect!());
