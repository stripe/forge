import assert from 'node:assert/strict';
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
        cases: ['case/b', 'case/a'],
        treatments: ['with-seed', 'baseline'],
        agents: [
          {adapter: 'codex', provider: 'openai', model: 'gpt'},
          {adapter: 'claude-code', provider: 'anthropic', model: 'sonnet'},
        ],
        repetitions: 2,
        retries: 1,
      },
    });

    const selections = expandExperiment(experiment);
    expect(selections).toEqual([
      selection('case/b', 'with-seed', 'codex', 'openai', 'gpt', 0),
      selection('case/b', 'with-seed', 'codex', 'openai', 'gpt', 1),
      selection('case/b', 'with-seed', 'claude-code', 'anthropic', 'sonnet', 0),
      selection('case/b', 'with-seed', 'claude-code', 'anthropic', 'sonnet', 1),
      selection('case/b', 'baseline', 'codex', 'openai', 'gpt', 0),
      selection('case/b', 'baseline', 'codex', 'openai', 'gpt', 1),
      selection('case/b', 'baseline', 'claude-code', 'anthropic', 'sonnet', 0),
      selection('case/b', 'baseline', 'claude-code', 'anthropic', 'sonnet', 1),
      selection('case/a', 'with-seed', 'codex', 'openai', 'gpt', 0),
      selection('case/a', 'with-seed', 'codex', 'openai', 'gpt', 1),
      selection('case/a', 'with-seed', 'claude-code', 'anthropic', 'sonnet', 0),
      selection('case/a', 'with-seed', 'claude-code', 'anthropic', 'sonnet', 1),
      selection('case/a', 'baseline', 'codex', 'openai', 'gpt', 0),
      selection('case/a', 'baseline', 'codex', 'openai', 'gpt', 1),
      selection('case/a', 'baseline', 'claude-code', 'anthropic', 'sonnet', 0),
      selection('case/a', 'baseline', 'claude-code', 'anthropic', 'sonnet', 1),
    ]);
    const loaded = inputs({experiment});
    expect(expandExperiment(loaded.experiment)).toEqual(selections);
    selections[0]!.agent.model = 'changed-model';
    expect(selections[1]!.agent.model).toBe('gpt');
    expect(experiment.matrix.agents[0]!.model).toBe('gpt');
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
    expect(plan.setup).toEqual([
      ...loaded.dataset.cases.get('case/a')!.definition.setup,
      ...loaded.experiment.config.treatments['with-seed']!.setup,
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
  });

  it('clones and deeply freezes plans without freezing or retaining caller inputs', () => {
    const loaded = inputs({
      caseDefinition: {
        ...evalCase(),
        checks: {files_created: ['answer.txt']},
        example_answer: 'A complete answer',
      },
    });
    const selected = expandExperiment(loaded.experiment)[1]!;
    const plan = resolveRunPlan({...loaded, selection: selected});
    const serialized = serializeResolvedRunPlan(plan);
    const definition = loaded.dataset.cases.get('case/a')!.definition;
    const config = loaded.experiment.config;

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.setup[0]!.with)).toBe(true);
    expect(Object.isFrozen(plan.evaluation.checks!.files_created)).toBe(true);
    expect(() => {
      plan.evaluation.checks!.files_created!.push('extra.txt');
    }).toThrow(TypeError);
    expect(() => {
      plan.selection.agent.model = 'changed-model';
    }).toThrow(TypeError);
    expect(Object.isFrozen(definition)).toBe(false);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(selected.agent)).toBe(false);

    definition.setup[0]!.with.argv = ['changed-command'];
    definition.checks!.files_created!.push('changed.txt');
    definition.success_guidelines.push('Changed guideline');
    config.treatments['with-seed']!.setup[0]!.with.target = 'changed-seed.txt';
    config.models.role_player!.model = 'changed-role-player';
    config.models.judge!.model = 'changed-judge';
    assert.ok('resources' in config.runtime);
    config.runtime.resources.cpu_count = 8;
    config.limits.run_timeout_ms = 1;
    selected.agent.model = 'changed-agent';

    expect(serializeResolvedRunPlan(plan)).toBe(serialized);
    expect(plan.evaluation.example_answer).toBe('A complete answer');
    expect(plan.evaluation.checks).toEqual({files_created: ['answer.txt']});
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
        checks: {files_created: ['greeting.txt']},
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
    expect(plan.evaluation.checks).toEqual({files_created: ['greeting.txt']});
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

  it('requires every component of a programmatic selection to match the matrix', () => {
    const loaded = inputs();
    const selected = expandExperiment(loaded.experiment)[0]!;
    const invalid: [string, Partial<RunSelection>, PlanningError['code']][] = [
      ['case', {case_id: 'case/other'}, 'unknown_case'],
      ['treatment', {treatment: 'other'}, 'unknown_treatment'],
      ['adapter', {agent: {...selected.agent, adapter: 'codex'}}, 'unknown_agent'],
      ['provider', {agent: {...selected.agent, provider: 'openai'}}, 'unknown_agent'],
      ['model', {agent: {...selected.agent, model: 'other-model'}}, 'unknown_agent'],
      ['negative repetition', {repetition: -1}, 'invalid_repetition'],
      ['fractional repetition', {repetition: 0.5}, 'invalid_repetition'],
      ['repetition upper bound', {repetition: 1}, 'invalid_repetition'],
    ];
    for (const [label, changed, code] of invalid) {
      assert.throws(
        () => resolveRunPlan({...loaded, selection: {...selected, ...changed}}),
        (error) => error instanceof PlanningError && error.code === code,
        label,
      );
    }
  });

  it('rejects experiment/dataset drift and missing manifest inputs', () => {
    const loaded = inputs();
    const selected = selection(
      'case/a',
      'baseline',
      'claude-code',
      'anthropic',
      'sonnet',
      0,
    );
    for (const changed of [
      {id: 'other-dataset'},
      {version: 'other-version'},
      {manifest_sha256: `sha256:${'0'.repeat(64)}` as const},
    ]) {
      expect(() =>
        resolveRunPlan({
          ...loaded,
          experiment: {
            ...loaded.experiment,
            config: {
              ...loaded.experiment.config,
              dataset: {...loaded.experiment.config.dataset, ...changed},
            },
          },
          selection: selected,
        }),
      ).toThrowError(expect.objectContaining({code: 'dataset_experiment_mismatch'}));
    }

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
        'with-seed',
        'claude-code',
        'anthropic',
        'sonnet',
        0,
      ),
    });
    const serialized = serializeResolvedRunPlan(plan);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(resolvedRunPlanSha256(plan)).toBe(sha256Digest(serialized));
    const reordered = {
      ...plan,
      agent: {
        model: plan.agent.model,
        provider: plan.agent.provider,
        adapter: plan.agent.adapter,
      },
      selection: {
        repetition: plan.selection.repetition,
        agent: {...plan.agent},
        treatment: plan.selection.treatment,
        case_id: plan.selection.case_id,
      },
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(serializeResolvedRunPlan(reordered)).toBe(serialized);
    expect(resolvedRunPlanSha256(reordered)).toBe(resolvedRunPlanSha256(plan));

    const reversedSetup = {...plan, setup: [...plan.setup].reverse()};
    // Ordered arrays are semantic; object-key canonicalization must not sort them.
    expect(resolvedRunPlanSha256(reversedSetup)).not.toBe(resolvedRunPlanSha256(plan));
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
