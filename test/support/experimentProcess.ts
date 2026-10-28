import { defaultForgeEngine } from '../../src/engine.ts';
import { runExperiment } from '../../src/experiment.ts';
import { createArtifactStore } from '../../src/results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../../src/testing/index.ts';

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
      const scoped = composition();
      return defaultForgeEngine.executeEval({
        ...input,
        composition: {
          ...scoped,
          runtime: {
            ...scoped.runtime,
            async prepare() {
              // Execution entry and runtime phase are durable before this signal.
              setInterval(() => undefined, 1_000);
              process.send!({ type: 'started', run_id: input.runId });
              return await new Promise<never>(() => undefined);
            },
          },
        },
      });
    }
    return defaultForgeEngine.executeEval({
      ...input,
      composition: composition(),
    });
  },
});
process.send!({ type: 'completed', summary }, () => process.disconnect!());
