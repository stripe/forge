import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {sha256Digest} from '../model/hashes.js';
import type {
  EvalCaseV1,
  ExperimentConfigV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  RunSelection,
} from '../model/types.js';
import {
  PlanningError,
  expandExperiment,
  resolveRunPlan,
  resolvedRunPlanSha256,
  serializeResolvedRunPlan,
} from './planner.js';
import {FORGE_VERSION} from '../version.js';

const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}` as const;

describe('experiment expansion and run planning', () => {
  it('expands deterministically in case/treatment/agent/repetition order', () => {
    const experiment = experimentConfig({
      matrix: {
        cases: ['case/a', 'case/b'],
        treatments: ['baseline', 'with-seed'],
        agents: [
          {adapter: 'claude-code', provider: 'anthropic', model: 'sonnet'},
          {adapter: 'codex', provider: 'openai', model: 'gpt'},
        ],
        repetitions: 2,
        retries: 1,
      },
    });

    const selections = expandExperiment(experiment);
    expect(selections).toHaveLength(16);
    expect(selections.slice(0, 5)).toEqual([
      selection('case/a', 'baseline', 'claude-code', 'anthropic', 'sonnet', 0),
      selection('case/a', 'baseline', 'claude-code', 'anthropic', 'sonnet', 1),
      selection('case/a', 'baseline', 'codex', 'openai', 'gpt', 0),
      selection('case/a', 'baseline', 'codex', 'openai', 'gpt', 1),
      selection('case/a', 'with-seed', 'claude-code', 'anthropic', 'sonnet', 0),
    ]);
  });

  it('materializes current multi-turn prompt semantics and ordered setup', () => {
    const loaded = inputs();
    const plan = resolveRunPlan({
      ...loaded,
      selection: selection(
        'case/a',
        'with-seed',
        'claude-code',
        'anthropic',
        'sonnet',
        0,
      ),
    });

    expect(plan.interaction).toEqual({
      mode: 'multi_turn',
      task: 'Complete the task',
      context: 'Existing application',
      initial_prompt: 'Please start here',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Please start here',
      max_turns: 7,
    });
    expect(plan.setup.map(({uses}) => uses)).toEqual([
      'forge/command',
      'forge/write',
    ]);
    expect(plan.role_player).toEqual({provider: 'anthropic', model: 'role-model'});
    expect(plan.evaluation.judge).toEqual({
      provider: 'anthropic',
      model: 'judge-model',
    });
    expect(plan.provenance).toMatchObject({
      dataset: {manifest_sha256: MANIFEST_DIGEST},
      experiment: {id: 'experiment/default', version: '2026.09.0'},
      case: {id: 'case/a', path: 'cases/case/a/eval.yaml'},
      forge: {version: FORGE_VERSION},
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.setup)).toBe(true);
  });

  it('keeps dataset locations out of resolved plans and their checksums', () => {
    const loaded = inputs();
    const selected = expandExperiment(loaded.experiment)[0]!;
    const before = resolveRunPlan({...loaded, selection: selected});
    loaded.experiment.config.dataset.path = '../relocated-dataset';
    const after = resolveRunPlan({...loaded, selection: selected});
    expect(serializeResolvedRunPlan(after)).toBe(serializeResolvedRunPlan(before));
    expect(resolvedRunPlanSha256(after)).toBe(resolvedRunPlanSha256(before));
  });

  it('supports one-shot checks-only plans without role-player or judge models', () => {
    const {
      task: _task,
      initial_prompt: _initialPrompt,
      context: _context,
      ...caseWithoutPromptFields
    } = evalCase();
    const loaded = inputs({
      caseDefinition: {
        ...caseWithoutPromptFields,
        initial_prompt: 'Create greeting.txt',
        execution_mode: 'one_shot',
        success_guidelines: [],
      },
      // Configured but unused harness models must not enter a one-shot,
      // checks-only resolved plan.
      experiment: experimentConfig(),
    });
    const plan = resolveRunPlan({
      ...loaded,
      selection: selection(
        'case/a',
        'baseline',
        'claude-code',
        'anthropic',
        'sonnet',
        0,
      ),
    });

    expect(plan.interaction).toMatchObject({
      mode: 'one_shot',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Create greeting.txt',
      max_turns: 1,
    });
    expect(plan.role_player).toBeUndefined();
    expect(plan.evaluation.judge).toBeUndefined();
  });

  it('materializes an authored native Docker platform in the resolved plan', () => {
    const loaded = inputs({
      experiment: experimentConfig({
        runtime: {
          adapter: 'docker',
          image: {kind: 'forge'},
          platform: 'native',
          resources: {
            memory_bytes: 4 * 1024 * 1024 * 1024,
            cpu_count: 2,
            process_count: 512,
          },
        },
      }),
    });
    const selected = selection(
      'case/a',
      'baseline',
      'claude-code',
      'anthropic',
      'sonnet',
      0,
    );

    expect(
      resolveRunPlan({
        ...loaded,
        selection: selected,
        runtimePlatform: 'linux/arm64',
      }).runtime.platform,
    ).toBe('linux/arm64');
    expect(() =>
      resolveRunPlan({...loaded, selection: selected}),
    ).toThrow(/requires a concrete runtimePlatform/);
  });

  it('requires harness models only when their behavior is selected', () => {
    const noModels = inputs({experiment: experimentConfig({models: {}})});
    expect(() =>
      resolveRunPlan({
        ...noModels,
        selection: selection(
          'case/a',
          'baseline',
          'claude-code',
          'anthropic',
          'sonnet',
          0,
        ),
      }),
    ).toThrowError(expect.objectContaining({code: 'missing_role_player'}));

    const noJudge = inputs({
      experiment: experimentConfig({
        models: {role_player: {provider: 'anthropic', model: 'role-model'}},
      }),
    });
    expect(() =>
      resolveRunPlan({
        ...noJudge,
        selection: selection(
          'case/a',
          'baseline',
          'claude-code',
          'anthropic',
          'sonnet',
          0,
        ),
      }),
    ).toThrowError(expect.objectContaining({code: 'missing_judge'}));
  });

  it('rejects experiment/dataset drift, selections outside the matrix, and missing inputs', () => {
    const loaded = inputs();
    const selected = selection(
      'case/a',
      'baseline',
      'claude-code',
      'anthropic',
      'sonnet',
      0,
    );
    expect(() =>
      resolveRunPlan({
        ...loaded,
        experiment: {
          ...loaded.experiment,
          config: {
            ...loaded.experiment.config,
            dataset: {
              ...loaded.experiment.config.dataset,
              manifest_sha256: `sha256:${'0'.repeat(64)}`,
            },
          },
        },
        selection: selected,
      }),
    ).toThrowError(
      expect.objectContaining({code: 'dataset_experiment_mismatch'}),
    );
    expect(() =>
      resolveRunPlan({...loaded, selection: {...selected, repetition: 2}}),
    ).toThrowError(expect.objectContaining({code: 'invalid_repetition'}));

    const missingInput = inputs({manifestFiles: []});
    expect(() =>
      resolveRunPlan({
        ...missingInput,
        selection: selection(
          'case/a',
          'with-seed',
          'claude-code',
          'anthropic',
          'sonnet',
          0,
        ),
      }),
    ).toThrowError(expect.objectContaining({code: 'missing_dataset_input'}));

    const directoryInput = inputs({
      experiment: experimentConfig({
        treatments: {
          directory: {
            setup: [
              {
                uses: 'forge/write',
                with: {
                  target: 'seed.txt',
                  source: {dataset_path: 'fixtures'},
                },
              },
            ],
          },
        },
        matrix: {
          ...experimentConfig().matrix,
          treatments: ['directory'],
        },
      }),
    });
    expect(() =>
      resolveRunPlan({
        ...directoryInput,
        selection: selection(
          'case/a',
          'directory',
          'claude-code',
          'anthropic',
          'sonnet',
          0,
        ),
      }),
    ).toThrowError(expect.objectContaining({code: 'missing_dataset_input'}));
  });

  it('serializes plans canonically and hashes equivalent object key order equally', () => {
    const loaded = inputs();
    const plan = resolveRunPlan({
      ...loaded,
      selection: selection(
        'case/a',
        'baseline',
        'claude-code',
        'anthropic',
        'sonnet',
        0,
      ),
    });
    const serialized = serializeResolvedRunPlan(plan);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(resolvedRunPlanSha256(plan)).toBe(sha256Digest(serialized));
    expect(resolvedRunPlanSha256({...plan})).toBe(resolvedRunPlanSha256(plan));
  });
});

function selection(
  caseId: string,
  treatment: string,
  adapter: string,
  provider: string,
  model: string,
  repetition: number,
): RunSelection {
  return {
    case_id: caseId,
    treatment,
    agent: {adapter, provider, model},
    repetition,
  };
}

function evalCase(): EvalCaseV1 {
  return {
    schema_version: 1,
    id: 'case/a',
    task: 'Complete the task',
    initial_prompt: 'Please start here',
    context: 'Existing application',
    execution_mode: 'multi_turn',
    max_turns: 7,
    setup: [
      {uses: 'forge/command', with: {argv: ['git', 'init']}},
    ],
    success_guidelines: ['The task is complete'],
  };
}

function experimentConfig(
  overrides: Partial<ExperimentConfigV1> = {},
): ExperimentConfigV1 {
  const config: ExperimentConfigV1 = {
    schema_version: 1,
    id: 'experiment/default',
    version: '2026.09.0',
    dataset: {
      id: 'dataset',
      version: '2026.09.0',
      manifest_sha256: MANIFEST_DIGEST,
    },
    runtime: {
      adapter: 'docker',
      image: {kind: 'forge'},
      platform: 'linux/amd64',
      resources: {
        memory_bytes: 4 * 1024 * 1024 * 1024,
        cpu_count: 2,
        process_count: 512,
      },
    },
    models: {
      role_player: {provider: 'anthropic', model: 'role-model'},
      judge: {provider: 'anthropic', model: 'judge-model'},
    },
    treatments: {
      baseline: {setup: []},
      'with-seed': {
        setup: [
          {
            uses: 'forge/write',
            with: {
              target: 'seed.txt',
              source: {dataset_path: 'fixtures/seed.txt'},
            },
          },
        ],
      },
    },
    matrix: {
      cases: ['case/a'],
      treatments: ['baseline', 'with-seed'],
      agents: [
        {adapter: 'claude-code', provider: 'anthropic', model: 'sonnet'},
      ],
      repetitions: 1,
      retries: 0,
    },
    limits: {run_timeout_ms: 1_800_000},
  };
  return {...config, ...overrides};
}

function inputs(
  options: {
    caseDefinition?: EvalCaseV1;
    experiment?: ExperimentConfigV1;
    manifestFiles?: LoadedDatasetV1['manifest']['files'];
  } = {},
): {dataset: LoadedDatasetV1; experiment: LoadedExperimentConfigV1} {
  const definition = options.caseDefinition ?? evalCase();
  const config = options.experiment ?? experimentConfig();
  const manifestFiles = options.manifestFiles ?? [
    {path: 'cases/case/a/eval.yaml', size: 100, sha256: 'b'.repeat(64)},
    {path: 'fixtures/seed.txt', size: 4, sha256: 'd'.repeat(64)},
  ];
  return {
    dataset: {
      root: '/dataset',
      manifestPath: '/dataset/manifest.json',
      manifestRaw: '{}',
      manifestSha256: MANIFEST_DIGEST,
      manifest: {
        schema_version: 1,
        dataset: {id: 'dataset', version: '2026.09.0'},
        cases: [{id: 'case/a', path: 'cases/case/a/eval.yaml'}],
        files: manifestFiles,
      },
      cases: new Map([
        [
          'case/a',
          {definition, path: '/dataset/cases/case/a/eval.yaml'},
        ],
      ]),
    },
    experiment: {
      path: '/experiment/default.yaml',
      root: '/experiment',
      raw: '',
      config,
    },
  };
}

// Keep the public error class reachable in this test module's type graph.
void PlanningError;
