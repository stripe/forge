import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ForgeComposition } from '../contracts/composition.ts';
import type {
  EvalCaseV1,
  ForgeRuntimeV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  ResolvedRunPlanV1,
} from '../model/types.ts';
import type { PlanRunInput } from './planRun.ts';
import {
  type PlanValidationOperations,
  validateExperiment,
} from './validateExperiment.ts';

const CASE_PATH = 'cases/a.case.yaml';

describe('validateExperiment', () => {
  it('preflights every selection once per platform with one composition per platform', async () => {
    const recorded = recordingOperations();
    const composedFor: (ForgeRuntimeV1 | undefined)[] = [];

    const validation = await validateExperiment(
      {
        ...inputs(),
        runtimePlatforms: ['linux/amd64', 'linux/arm64'],
        compose: async (runtime) => {
          composedFor.push(runtime);
          return composition(runtime);
        },
      },
      recorded.operations,
    );

    assert.deepEqual(validation, {
      dataset: { id: 'dataset', version: '2026.09.0' },
      experiment: { id: 'experiment/default', version: '2026.09.0' },
      run_count: 2,
      valid: true,
    });
    assert.deepEqual(
      recorded.resolved.map(({ selection, runtimePlatform }) => [
        selection.treatment,
        runtimePlatform,
      ]),
      [
        ['baseline', 'linux/amd64'],
        ['seeded', 'linux/amd64'],
        ['baseline', 'linux/arm64'],
        ['seeded', 'linux/arm64'],
      ],
    );
    assert.deepEqual(
      composedFor.map((runtime) => runtime?.platform),
      ['linux/amd64', 'linux/arm64'],
    );
    assert.deepEqual(
      recorded.preflighted.map(({ plan, composition }) => [
        plan.runtime.platform,
        composition.runtime.id,
      ]),
      [
        ['linux/amd64', 'runtime/linux/amd64'],
        ['linux/amd64', 'runtime/linux/amd64'],
        ['linux/arm64', 'runtime/linux/arm64'],
        ['linux/arm64', 'runtime/linux/arm64'],
      ],
    );
  });

  it("plans once with the experiment's own runtime when no platform is given", async () => {
    const recorded = recordingOperations();

    await validateExperiment(
      { ...inputs(), runtimePlatforms: [], compose: async () => composition() },
      recorded.operations,
    );

    assert.deepEqual(
      recorded.resolved.map((input) => 'runtimePlatform' in input),
      [false, false],
    );
    assert.equal(recorded.preflighted.length, 2);
  });

  it('fails when a plan fails preflight', async () => {
    const operations: PlanValidationOperations = {
      ...recordingOperations().operations,
      preflightEval: () => {
        throw new Error('unsupported agent adapter');
      },
    };

    await assert.rejects(
      validateExperiment(
        {
          ...inputs(),
          runtimePlatforms: [],
          compose: async () => composition(),
        },
        operations,
      ),
      /unsupported agent adapter/,
    );
  });
});

function recordingOperations() {
  const resolved: PlanRunInput[] = [];
  const preflighted: {
    plan: ResolvedRunPlanV1;
    composition: ForgeComposition;
  }[] = [];
  const operations: PlanValidationOperations = {
    resolveRunPlan: (input) => {
      resolved.push(input);
      return {
        selection: input.selection,
        runtime: { platform: input.runtimePlatform ?? 'linux/amd64' },
      } as unknown as ResolvedRunPlanV1;
    },
    preflightEval: (request) => {
      preflighted.push(request);
    },
  };
  return { operations, resolved, preflighted };
}

function composition(runtime?: ForgeRuntimeV1): ForgeComposition {
  return {
    runtime: { id: `runtime/${runtime?.platform ?? 'default'}` },
  } as unknown as ForgeComposition;
}

function inputs(): {
  dataset: LoadedDatasetV1;
  experiment: LoadedExperimentConfigV1;
} {
  const definition: EvalCaseV1 = {
    id: 'case/a',
    version: '0.1.0',
    task: 'Complete the task',
    initial_prompt: 'Please start here',
    execution_mode: 'one_shot',
    setup: [],
    judging_criteria: [],
  };
  return {
    dataset: {
      root: '/dataset',
      manifestPath: '/dataset/manifest.json',
      manifestRaw: '{}',
      manifest: {
        dataset: { id: 'dataset', version: '2026.09.0' },
        cases: [{ id: 'case/a', version: '0.1.0', path: CASE_PATH }],
      },
      cases: new Map([
        ['case/a', { definition, path: `/dataset/${CASE_PATH}` }],
      ]),
    },
    experiment: {
      path: '/experiment/default.yaml',
      root: '/experiment',
      raw: '',
      config: {
        id: 'experiment/default',
        version: '2026.09.0',
        dataset: { id: 'dataset', version: '2026.09.0' },
        runtime: {
          adapter: 'docker',
          image: { kind: 'forge' },
          platform: 'native',
          resources: {
            memory_bytes: 4 * 1024 * 1024 * 1024,
            cpu_count: 2,
            process_count: 512,
          },
        },
        models: {
          role_player: { provider: 'anthropic', model: 'role-model' },
          judge: { provider: 'anthropic', model: 'judge-model' },
        },
        treatments: { baseline: { setup: [] }, seeded: { setup: [] } },
        matrix: {
          cases: [CASE_PATH],
          treatments: ['baseline', 'seeded'],
          agents: [
            { adapter: 'claude-code', provider: 'anthropic', model: 'sonnet' },
          ],
          repetitions: 1,
          retries: 0,
        },
        limits: { run_timeout_ms: 1_800_000 },
      },
    },
  };
}
