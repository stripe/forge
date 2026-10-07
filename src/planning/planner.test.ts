import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {sha256Digest} from '../model/hashes.js';
import {getMatrixGroups} from '../model/matrix.js';
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
import {FORGE_BUILD_IDENTITY} from '../version.js';

const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}` as const;

describe('experiment expansion and run planning', () => {
  it('records Codex hook trust explicitly and separates policies in selection and plan identity', () => {
    const experiment = experimentConfig();
    experiment.matrix.agents = [
      {adapter: 'codex', provider: 'openai', model: 'gpt'},
      {adapter: 'codex', provider: 'openai', model: 'gpt', hook_trust: 'automation'},
    ];
    const loaded = inputs({experiment});
    const selections = expandExperiment(experiment);
    const plans = selections.map((selected) => resolveRunPlan({...loaded, selection: selected}));
    assert.equal(plans[0]!.agent.hook_trust, 'native');
    assert.equal(plans[1]!.agent.hook_trust, 'automation');
    assert.deepEqual(plans[1]!.agent, plans[1]!.selection.agent);
    assert.notEqual(resolvedRunPlanSha256(plans[0]!), resolvedRunPlanSha256(plans[1]!));
    assert.equal(experiment.matrix.agents[0]!.hook_trust, undefined);
    const implicit = {...selections[0]!, agent: {adapter: 'codex', provider: 'openai', model: 'gpt'}};
    assert.deepEqual(resolveRunPlan({...loaded, selection: implicit}), plans[0]);
    experiment.matrix.agents.pop();
    assert.throws(() => resolveRunPlan({...loaded, selection: selections[1]!}), /not in the benchmark matrix/);
  });
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
    assert.deepEqual(selections, [
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
    assert.deepEqual(expandExperiment(loaded.experiment), selections);
    selections[0]!.agent.model = 'changed-model';
    assert.equal(selections[1]!.agent.model, 'gpt');
    assert.equal(getMatrixGroups(experiment.matrix)[0]!.agents[0]!.model, 'gpt');
  });

  it('expands sparse groups in group/case/treatment/agent/repetition order', () => {
    const experiment = experimentConfig({
      matrix: {
        groups: [
          {
            cases: ['case/b', 'case/a'],
            treatments: ['with-seed', 'baseline'],
            agents: [{adapter: 'codex', provider: 'openai', model: 'gpt'}],
          },
          {
            cases: ['case/a'],
            treatments: ['baseline'],
            agents: [{adapter: 'claude-code', provider: 'anthropic', model: 'sonnet'}],
          },
        ],
        repetitions: 2,
        retries: 3,
      },
    });
    const before = structuredClone(experiment);
    const selections = expandExperiment(experiment);
    assert.deepEqual(selections, [
      selection('case/b', 'with-seed', 'codex', 'openai', 'gpt', 0),
      selection('case/b', 'with-seed', 'codex', 'openai', 'gpt', 1),
      selection('case/b', 'baseline', 'codex', 'openai', 'gpt', 0),
      selection('case/b', 'baseline', 'codex', 'openai', 'gpt', 1),
      selection('case/a', 'with-seed', 'codex', 'openai', 'gpt', 0),
      selection('case/a', 'with-seed', 'codex', 'openai', 'gpt', 1),
      selection('case/a', 'baseline', 'codex', 'openai', 'gpt', 0),
      selection('case/a', 'baseline', 'codex', 'openai', 'gpt', 1),
      selection('case/a', 'baseline', 'claude-code', 'anthropic', 'sonnet', 0),
      selection('case/a', 'baseline', 'claude-code', 'anthropic', 'sonnet', 1),
    ]);
    assert.deepEqual(expandExperiment(inputs({experiment}).experiment), selections);
    assert.deepEqual(experiment, before);
    selections[0]!.agent.model = 'changed-model';
    assert.equal(selections[1]!.agent.model, 'gpt');
    assert.deepEqual(experiment, before);
  });

  it('requires all selection coordinates to belong to the same group', () => {
    const loaded = inputs({experiment: experimentConfig({
      matrix: {
        groups: [
          {
            cases: ['case/a'],
            treatments: ['baseline'],
            agents: [{adapter: 'codex', provider: 'openai', model: 'gpt'}],
          },
          {
            cases: ['case/a'],
            treatments: ['with-seed'],
            agents: [{adapter: 'claude-code', provider: 'anthropic', model: 'sonnet'}],
          },
        ],
        repetitions: 1,
        retries: 0,
      },
    })});
    const selections = expandExperiment(loaded.experiment);
    for (const selected of selections) {
      assert.equal(resolveRunPlan({...loaded, selection: selected}).selection.case_id, 'case/a');
    }
    // An omitted Codex hook policy matches its materialized native selection.
    const codex = {...selections[0]!, agent: {adapter: 'codex', provider: 'openai', model: 'gpt'}};
    assert.deepEqual(resolveRunPlan({...loaded, selection: codex}),
      resolveRunPlan({...loaded, selection: selections[0]!}));
    for (const selected of selections) {
      const treatment = selected.treatment === 'baseline' ? 'with-seed' : 'baseline';
      assert.throws(() => resolveRunPlan({...loaded, selection: {...selected, treatment}}),
        {code: 'invalid_selection'});
    }
    for (const [changed, code] of [
      [{case_id: 'case/other'}, 'unknown_case'],
      [{treatment: 'other'}, 'unknown_treatment'],
      [{agent: {...selections[0]!.agent, model: 'other-model'}}, 'unknown_agent'],
      [{repetition: 1}, 'invalid_repetition'],
    ] as const) {
      assert.throws(() => resolveRunPlan({...loaded, selection: {...selections[0]!, ...changed}}), {code});
    }
  });

  it('preserves custom hook policies and uses them for plan identity and group membership', () => {
    const implicit = {adapter: 'custom-agent', provider: 'custom-provider', model: 'model'};
    const native = {...implicit, hook_trust: 'native' as const};
    const flat = experimentConfig({matrix: {
      cases: ['case/a'],
      treatments: ['baseline'],
      agents: [implicit, native],
      repetitions: 1,
      retries: 0,
    }});
    const flatSelections = expandExperiment(flat);
    assert.deepEqual(flatSelections.map(({agent}) => agent), [implicit, native]);
    assert.equal(Object.hasOwn(flatSelections[0]!.agent, 'hook_trust'), false);
    const flatPlans = flatSelections.map((selected) =>
      resolveRunPlan({...inputs({experiment: flat}), selection: selected}));
    assert.deepEqual(flatPlans.map(({agent}) => agent), [implicit, native]);
    assert.notEqual(resolvedRunPlanSha256(flatPlans[0]!), resolvedRunPlanSha256(flatPlans[1]!));

    const grouped = experimentConfig({matrix: {
      groups: [
        {cases: ['case/a'], treatments: ['baseline'], agents: [implicit]},
        {cases: ['case/a'], treatments: ['with-seed'], agents: [native]},
      ],
      repetitions: 1,
      retries: 0,
    }});
    const selections = expandExperiment(grouped);
    assert.deepEqual(selections.map(({agent}) => agent), [implicit, native]);
    const loaded = inputs({experiment: grouped});
    for (const [index, selected] of selections.entries()) {
      assert.deepEqual(resolveRunPlan({...loaded, selection: selected}).agent, selected.agent);
      const otherAgent = selections[1 - index]!.agent;
      assert.throws(() => resolveRunPlan({...loaded, selection: {...selected, agent: otherAgent}}),
        {code: 'invalid_selection'});
    }
  });

  it('validates cases in every group before resolving a selected plan', () => {
    const experiment = experimentConfig();
    const {cases, treatments, agents} = getMatrixGroups(experiment.matrix)[0]!;
    const axes = {cases, treatments, agents};
    experiment.matrix = {
      groups: [axes, {...axes, cases: ['case/missing']}],
      repetitions: 1,
      retries: 0,
    };
    const loaded = inputs({experiment});
    const selected = expandExperiment(experiment)[0]!;
    assert.throws(() => resolveRunPlan({...loaded, selection: selected}), {code: 'unknown_case'});
  });

  it('keeps resolved plan identities equal for equivalent flat and grouped selections', () => {
    const flat = experimentConfig();
    const {cases, treatments, agents} = getMatrixGroups(flat.matrix)[0]!;
    const axes = {cases, treatments, agents};
    const grouped = experimentConfig({matrix: {
      groups: [axes],
      repetitions: flat.matrix.repetitions,
      retries: flat.matrix.retries,
    }});
    const selected = expandExperiment(flat)[1]!;
    const flatPlan = resolveRunPlan({...inputs({experiment: flat}), selection: selected});
    const groupedPlan = resolveRunPlan({...inputs({experiment: grouped}), selection: selected});
    assert.deepEqual(groupedPlan, flatPlan);
    assert.equal(resolvedRunPlanSha256(groupedPlan), resolvedRunPlanSha256(flatPlan));
    assert.equal(Object.hasOwn(groupedPlan, 'groups'), false);
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

    assert.deepEqual(plan.interaction, {
      mode: 'multi_turn',
      task: 'Complete the task',
      context: 'Existing application',
      initial_prompt: 'Please start here',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Please start here',
      max_turns: 7,
    });
    assert.deepEqual(plan.setup, [
      ...loaded.dataset.cases.get('case/a')!.definition.setup,
      ...loaded.experiment.config.treatments['with-seed']!.setup,
    ]);
    assert.deepEqual(plan.role_player, {provider: 'anthropic', model: 'role-model'});
    assert.deepEqual(plan.evaluation.judge, {
      provider: 'anthropic',
      model: 'judge-model',
    });
    {
      const actual = plan.provenance;
      assert.ok(actual);
      assert.equal(actual.dataset.manifest_sha256, MANIFEST_DIGEST);
      assert.equal(actual.experiment.id, 'experiment/default');
      assert.equal(actual.experiment.version, '2026.09.0');
      assert.equal(actual.case.id, 'case/a');
      assert.equal(actual.case.path, 'cases/case/a/eval.yaml');
      assert.deepEqual(actual.forge, FORGE_BUILD_IDENTITY);
    }
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

    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.setup[0]!.with), true);
    assert.equal(Object.isFrozen(plan.evaluation.checks!.files_created), true);
    assert.throws(() => {
      plan.evaluation.checks!.files_created!.push('extra.txt');
    }, TypeError);
    assert.throws(() => {
      plan.selection.agent.model = 'changed-model';
    }, TypeError);
    assert.equal(Object.isFrozen(definition), false);
    assert.equal(Object.isFrozen(config), false);
    assert.equal(Object.isFrozen(selected.agent), false);

    definition.setup[0]!.with.argv = ['changed-command'];
    definition.checks!.files_created!.push('changed.txt');
    definition.judging_criteria.push('Changed criterion');
    config.treatments['with-seed']!.setup[0]!.with.target = 'changed-seed.txt';
    config.models.role_player!.model = 'changed-role-player';
    config.models.judge!.model = 'changed-judge';
    assert.ok('resources' in config.runtime);
    config.runtime.resources.cpu_count = 8;
    config.limits.run_timeout_ms = 1;
    selected.agent.model = 'changed-agent';

    assert.equal(serializeResolvedRunPlan(plan), serialized);
    assert.equal(plan.evaluation.example_answer, 'A complete answer');
    assert.deepEqual(plan.evaluation.checks, {files_created: ['answer.txt']});
  });

  it('keeps dataset locations out of resolved plans and their checksums', () => {
    const loaded = inputs();
    const selected = expandExperiment(loaded.experiment)[0]!;
    const before = resolveRunPlan({...loaded, selection: selected});
    loaded.experiment.config.dataset.path = '../relocated-dataset';
    const after = resolveRunPlan({...loaded, selection: selected});
    assert.equal(serializeResolvedRunPlan(after), serializeResolvedRunPlan(before));
    assert.equal(resolvedRunPlanSha256(after), resolvedRunPlanSha256(before));
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
        judging_criteria: [],
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

    {
      const actual = plan.interaction;
      assert.ok(actual);
      assert.equal(actual.mode, 'one_shot');
      assert.equal(actual.initial_prompt_source, 'case.initial_prompt');
      assert.equal(actual.effective_prompt, 'Create greeting.txt');
      assert.equal(actual.max_turns, 1);
    }
    assert.equal(plan.role_player, undefined);
    assert.equal(plan.evaluation.judge, undefined);
    assert.deepEqual(plan.evaluation.checks, {files_created: ['greeting.txt']});
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

    assert.equal(resolveRunPlan({
      ...loaded,
      selection: selected,
      runtimePlatform: 'linux/arm64',
    }).runtime.platform, 'linux/arm64');
    assert.throws(() =>
      resolveRunPlan({...loaded, selection: selected}), /requires a concrete runtimePlatform/);
  });

  it('requires harness models only when their behavior is selected', () => {
    const noModels = inputs({experiment: experimentConfig({models: {}})});
    assert.throws(() =>
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
      }), {code: 'missing_role_player'});

    const noJudge = inputs({
      experiment: experimentConfig({
        models: {role_player: {provider: 'anthropic', model: 'role-model'}},
      }),
    });
    assert.throws(() =>
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
      }), {code: 'missing_judge'});
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
      assert.throws(() =>
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
        }), {code: 'dataset_experiment_mismatch'});
    }

    const missingInput = inputs({manifestFiles: []});
    assert.throws(() =>
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
      }), {code: 'missing_dataset_input'});

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
          ...getMatrixGroups(experimentConfig().matrix)[0]!,
          treatments: ['directory'],
          repetitions: 1,
          retries: 0,
        },
      }),
    });
    assert.throws(() =>
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
      }), {code: 'missing_dataset_input'});
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
    assert.equal(serialized.endsWith('\n'), true);
    assert.equal(resolvedRunPlanSha256(plan), sha256Digest(serialized));
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
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(plan));
    assert.equal(serializeResolvedRunPlan(reordered), serialized);
    assert.equal(resolvedRunPlanSha256(reordered), resolvedRunPlanSha256(plan));

    const reversedSetup = {...plan, setup: [...plan.setup].reverse()};
    // Ordered arrays are semantic; object-key canonicalization must not sort them.
    assert.notEqual(resolvedRunPlanSha256(reversedSetup), resolvedRunPlanSha256(plan));
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
    agent: {adapter, provider, model, ...(adapter === 'codex' ? {hook_trust: 'native' as const} : {})},
    repetition,
  };
}

function evalCase(): EvalCaseV1 {
  return {
    id: 'case/a',
    task: 'Complete the task',
    initial_prompt: 'Please start here',
    context: 'Existing application',
    execution_mode: 'multi_turn',
    max_turns: 7,
    setup: [
      {uses: 'forge/command', with: {argv: ['git', 'init']}},
    ],
    judging_criteria: ['The task is complete'],
  };
}

function experimentConfig(
  overrides: Partial<ExperimentConfigV1> = {},
): ExperimentConfigV1 {
  const config: ExperimentConfigV1 = {
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
