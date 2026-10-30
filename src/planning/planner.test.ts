import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { OPEN_CODE_MODEL_PROFILE } from '../../test/support/opencode.ts';

import { sha256Digest } from '../model/hashes.ts';
import { getMatrixGroups } from '../model/matrix.ts';
import type {
  EvalCaseV1,
  ExperimentConfigV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  RunSelection,
} from '../model/types.ts';
import { FORGE_BUILD_IDENTITY } from '../version.ts';
import {
  expandExperiment,
  PlanningError,
  resolvedRunPlanSha256,
  resolveRunPlan,
  serializeResolvedRunPlan,
} from './planner.ts';

const CASE_A_PATH = 'cases/case/a/case.yaml';
const CASE_B_PATH = 'cases/case-b.case.yaml';

describe('experiment expansion and run planning', () => {
  it('materializes a separate evaluation allowance without mutating config and binds it to plan identity', () => {
    const loaded = inputs();
    const selection = expandExperiment(loaded.experiment, loaded.dataset)[0]!;
    const plan = resolveRunPlan({ ...loaded, selection });
    assert.equal(plan.limits.evaluation_timeout_ms, 300_000);
    assert.equal(
      Object.hasOwn(loaded.experiment.config.limits, 'evaluation_timeout_ms'),
      false,
    );
    assert.ok(Object.isFrozen(plan.limits));
    loaded.experiment.config.limits.evaluation_timeout_ms = 600_000;
    const overridden = resolveRunPlan({ ...loaded, selection });
    assert.equal(overridden.limits.evaluation_timeout_ms, 600_000);
    assert.equal(plan.limits.evaluation_timeout_ms, 300_000);
    assert.notEqual(
      resolvedRunPlanSha256(overridden),
      resolvedRunPlanSha256(plan),
    );
  });

  it('binds named groups to selections and plan identity without using array position', () => {
    const config = experimentConfig();
    const axes = getMatrixGroups(config.matrix)[0]!;
    const experiment = experimentConfig({
      matrix: {
        groups: [{ ...axes, id: 'comparison' }],
        repetitions: 1,
        retries: 0,
      },
    });
    const loaded = inputs({ experiment });
    const selected = expandExperiment(experiment, loaded.dataset)[0]!;
    assert.equal(selected.group_id, 'comparison');
    const plan = resolveRunPlan({ ...loaded, selection: selected });
    assert.equal(plan.selection.group_id, 'comparison');
    const { group_id: _, ...unnamed } = selected;
    assert.deepEqual(resolveRunPlan({ ...loaded, selection: unnamed }), plan);
    assert.throws(
      () =>
        resolveRunPlan({
          ...loaded,
          selection: { ...selected, group_id: 'wrong' },
        }),
      /group ID does not match/,
    );
    const renamed = inputs({
      experiment: {
        ...experiment,
        matrix: {
          repetitions: 1,
          retries: 0,
          groups: [{ ...axes, id: 'renamed' }],
        },
      },
    });
    assert.notEqual(
      resolvedRunPlanSha256(resolveRunPlan({ ...renamed, selection: unnamed })),
      resolvedRunPlanSha256(plan),
    );
    assert.throws(
      () =>
        resolveRunPlan({
          ...inputs({ experiment: config }),
          selection: selected,
        }),
      /group ID does not match/,
    );
  });

  it('resolves authored file paths to stable case IDs while preserving manifest paths in plans', () => {
    const experiment = experimentConfig({
      matrix: {
        ...getMatrixGroups(experimentConfig().matrix)[0]!,
        cases: [CASE_B_PATH, CASE_A_PATH],
        repetitions: 1,
        retries: 0,
      },
    });
    const loaded = inputs({ experiment });
    const selections = expandExperiment(experiment, loaded.dataset);
    assert.deepEqual(
      selections.map(({ case_id }) => case_id),
      ['case/b', 'case/b', 'case/a', 'case/a'],
    );
    const plans = selections.map((selection) =>
      resolveRunPlan({ ...loaded, selection }),
    );
    assert.deepEqual(
      plans.map(({ provenance }) => provenance.case.path),
      [CASE_B_PATH, CASE_B_PATH, CASE_A_PATH, CASE_A_PATH],
    );
    assert.deepEqual(
      plans.map(({ case: definition }) => definition.id),
      ['case/b', 'case/b', 'case/a', 'case/a'],
    );
    assert.throws(
      () =>
        resolveRunPlan({
          ...loaded,
          selection: { ...selections[0]!, case_id: CASE_B_PATH },
        }),
      { code: 'unknown_case' },
    );
  });

  it('requires matrix case references to identify loaded manifest cases without ID aliases', () => {
    for (const casePath of [
      'case/a',
      'fixtures/seed.txt',
      'cases/unlisted.case.yaml',
    ]) {
      const experiment = experimentConfig({
        matrix: {
          ...getMatrixGroups(experimentConfig().matrix)[0]!,
          cases: [casePath],
          repetitions: 1,
          retries: 0,
        },
      });
      const loaded = inputs({ experiment });
      assert.throws(() => expandExperiment(experiment, loaded.dataset), {
        code: 'unknown_case',
      });
      assert.throws(
        () =>
          resolveRunPlan({
            ...loaded,
            selection: selection(
              'case/a',
              'baseline',
              'claude-code',
              'anthropic',
              'sonnet',
              0,
            ),
          }),
        { code: 'unknown_case' },
      );
    }
    const loaded = inputs();
    loaded.dataset.cases = new Map();
    assert.throws(() => expandExperiment(loaded.experiment, loaded.dataset), {
      code: 'invalid_loaded_dataset',
    });
  });

  it('retains frozen model profiles across baseline and plugin plans and distinguishes profiles', () => {
    const experiment = experimentConfig();
    const profile = structuredClone(OPEN_CODE_MODEL_PROFILE);
    const agent = {
      adapter: 'opencode',
      provider: 'openai-compatible',
      model: 'gateway-code',
      model_profile: profile,
    };
    experiment.treatments = {
      baseline: { setup: [] },
      'stripe-plugin': {
        setup: [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }],
      },
    };
    experiment.matrix = {
      cases: [CASE_A_PATH],
      treatments: ['baseline', 'stripe-plugin'],
      agents: [
        agent,
        { ...agent, model_profile: { ...profile, reasoning: true } },
      ],
      repetitions: 1,
      retries: 0,
    };
    const loaded = inputs({ experiment });
    const selections = expandExperiment(experiment, loaded.dataset);
    const plans = selections.map((selection) =>
      resolveRunPlan({ ...loaded, selection }),
    );
    assert.equal(plans.length, 4);
    assert.deepEqual(plans[0]!.agent, plans[2]!.agent);
    assert.deepEqual(plans[0]!.agent.model_profile, OPEN_CODE_MODEL_PROFILE);
    assert.notEqual(
      resolvedRunPlanSha256(plans[0]!),
      resolvedRunPlanSha256(plans[1]!),
    );
    assert.notEqual(plans[0]!.agent.model_profile, profile);
    assert.ok(Object.isFrozen(plans[0]!.agent.model_profile!.limit));
    assert.deepEqual(plans[0]!.agent, plans[0]!.selection.agent);
    experiment.matrix.agents.pop();
    assert.throws(
      () => resolveRunPlan({ ...loaded, selection: selections[1]! }),
      /not in the benchmark matrix/,
    );
    profile.limit.context = 64000;
    assert.equal(plans[0]!.agent.model_profile!.limit.context, 32000);
  });

  it('records Codex hook trust explicitly and separates policies in selection and plan identity', () => {
    const experiment = experimentConfig();
    experiment.matrix.agents = [
      { adapter: 'codex', provider: 'openai', model: 'gpt' },
      {
        adapter: 'codex',
        provider: 'openai',
        model: 'gpt',
        hook_trust: 'automation',
      },
    ];
    const loaded = inputs({ experiment });
    const selections = expandExperiment(experiment, loaded.dataset);
    const plans = selections.map((selected) =>
      resolveRunPlan({ ...loaded, selection: selected }),
    );
    assert.equal(plans[0]!.agent.hook_trust, 'native');
    assert.equal(plans[1]!.agent.hook_trust, 'automation');
    assert.deepEqual(plans[1]!.agent, plans[1]!.selection.agent);
    assert.notEqual(
      resolvedRunPlanSha256(plans[0]!),
      resolvedRunPlanSha256(plans[1]!),
    );
    assert.equal(experiment.matrix.agents[0]!.hook_trust, undefined);
    const implicit = {
      ...selections[0]!,
      agent: { adapter: 'codex', provider: 'openai', model: 'gpt' },
    };
    assert.deepEqual(
      resolveRunPlan({ ...loaded, selection: implicit }),
      plans[0],
    );
    experiment.matrix.agents.pop();
    assert.throws(
      () => resolveRunPlan({ ...loaded, selection: selections[1]! }),
      /not in the benchmark matrix/,
    );
  });

  it('rejects tampered dataset indexes even when the affected case is unselected', () => {
    const original = inputs();
    const selected = selection(
      'case/a',
      'baseline',
      'claude-code',
      'anthropic',
      'sonnet',
      0,
    );
    const other = original.dataset.cases.get('case/b')!;
    const variants: LoadedDatasetV1[] = [
      {
        ...original.dataset,
        cases: new Map([['case/a', original.dataset.cases.get('case/a')!]]),
      },
      {
        ...original.dataset,
        cases: new Map([
          ...original.dataset.cases,
          [
            'extra',
            { ...other, definition: { ...other.definition, id: 'extra' } },
          ],
        ]),
      },
      {
        ...original.dataset,
        manifest: {
          ...original.dataset.manifest,
          cases: [
            original.dataset.manifest.cases[0]!,
            original.dataset.manifest.cases[0]!,
          ],
        },
      },
      {
        ...original.dataset,
        manifest: {
          ...original.dataset.manifest,
          cases: [
            original.dataset.manifest.cases[0]!,
            {
              ...original.dataset.manifest.cases[1]!,
              path: 'cases/ordinary.yaml',
            },
          ],
        },
      },
    ];
    for (const changed of [
      { ...other, definition: { ...other.definition, id: 'case/a' } },
      { ...other, path: original.dataset.cases.get('case/a')!.path },
      { ...other, path: '/outside/other.case.yaml' },
      { ...other, path: `./${CASE_B_PATH}` },
    ]) {
      variants.push({
        ...original.dataset,
        cases: new Map([
          ['case/a', original.dataset.cases.get('case/a')!],
          ['case/b', changed],
        ]),
      });
    }
    for (const dataset of variants) {
      assert.throws(() => expandExperiment(original.experiment, dataset), {
        code: 'invalid_loaded_dataset',
      });
      assert.throws(
        () =>
          resolveRunPlan({
            dataset,
            experiment: original.experiment,
            selection: selected,
          }),
        { code: 'invalid_loaded_dataset' },
      );
    }
  });

  it('accepts complete ReadonlyMap implementations and rejects inconsistent bounded iteration', () => {
    const loaded = inputs();
    const source = loaded.dataset.cases;
    const cases: LoadedDatasetV1['cases'] = {
      size: source.size,
      get: source.get.bind(source),
      has: source.has.bind(source),
      keys: source.keys.bind(source),
      values: source.values.bind(source),
      entries: source.entries.bind(source),
      forEach: source.forEach.bind(source),
      [Symbol.iterator]: source[Symbol.iterator].bind(source),
    };
    const selections = expandExperiment(loaded.experiment, loaded.dataset);
    const dataset = { ...loaded.dataset, cases };
    assert.deepEqual(expandExperiment(loaded.experiment, dataset), selections);
    assert.deepEqual(
      resolveRunPlan({ ...loaded, dataset, selection: selections[0]! }),
      resolveRunPlan({ ...loaded, selection: selections[0]! }),
    );
    const entries = [...source];
    let yielded = 0;
    const invalid = [
      { ...cases, size: 1 },
      { ...cases, get: () => undefined },
      {
        ...cases,
        [Symbol.iterator]: function* () {
          while (true) {
            yielded += 1;
            yield entries[0]!;
          }
        },
      },
    ];
    for (const cases of invalid) {
      assert.throws(
        () => expandExperiment(loaded.experiment, { ...dataset, cases }),
        { code: 'invalid_loaded_dataset' },
      );
    }
    assert.ok(yielded <= source.size + 1);
  });
  it('expands deterministically in case/treatment/agent/repetition order', () => {
    const experiment = experimentConfig({
      matrix: {
        cases: [CASE_B_PATH, CASE_A_PATH],
        treatments: ['with-seed', 'baseline'],
        agents: [
          { adapter: 'codex', provider: 'openai', model: 'gpt' },
          { adapter: 'claude-code', provider: 'anthropic', model: 'sonnet' },
        ],
        repetitions: 2,
        retries: 1,
      },
    });

    const loaded = inputs({ experiment });
    const selections = expandExperiment(experiment, loaded.dataset);
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
    assert.deepEqual(
      expandExperiment(loaded.experiment, loaded.dataset),
      selections,
    );
    selections[0]!.agent.model = 'changed-model';
    assert.equal(selections[1]!.agent.model, 'gpt');
    assert.equal(
      getMatrixGroups(experiment.matrix)[0]!.agents[0]!.model,
      'gpt',
    );
  });

  it('expands sparse groups in group/case/treatment/agent/repetition order', () => {
    const experiment = experimentConfig({
      matrix: {
        groups: [
          {
            cases: [CASE_B_PATH, CASE_A_PATH],
            treatments: ['with-seed', 'baseline'],
            agents: [{ adapter: 'codex', provider: 'openai', model: 'gpt' }],
          },
          {
            cases: [CASE_A_PATH],
            treatments: ['baseline'],
            agents: [
              {
                adapter: 'claude-code',
                provider: 'anthropic',
                model: 'sonnet',
              },
            ],
          },
        ],
        repetitions: 2,
        retries: 3,
      },
    });
    const before = structuredClone(experiment);
    const loaded = inputs({ experiment });
    const selections = expandExperiment(experiment, loaded.dataset);
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
    assert.deepEqual(
      expandExperiment(loaded.experiment, loaded.dataset),
      selections,
    );
    assert.deepEqual(experiment, before);
    selections[0]!.agent.model = 'changed-model';
    assert.equal(selections[1]!.agent.model, 'gpt');
    assert.deepEqual(experiment, before);
  });

  it('requires all selection coordinates to belong to the same group', () => {
    const loaded = inputs({
      experiment: experimentConfig({
        matrix: {
          groups: [
            {
              cases: [CASE_A_PATH],
              treatments: ['baseline'],
              agents: [{ adapter: 'codex', provider: 'openai', model: 'gpt' }],
            },
            {
              cases: [CASE_A_PATH],
              treatments: ['with-seed'],
              agents: [
                {
                  adapter: 'claude-code',
                  provider: 'anthropic',
                  model: 'sonnet',
                },
              ],
            },
          ],
          repetitions: 1,
          retries: 0,
        },
      }),
    });
    const selections = expandExperiment(loaded.experiment, loaded.dataset);
    for (const selected of selections) {
      assert.equal(
        resolveRunPlan({ ...loaded, selection: selected }).selection.case_id,
        'case/a',
      );
    }
    // An omitted Codex hook policy matches its materialized native selection.
    const codex = {
      ...selections[0]!,
      agent: { adapter: 'codex', provider: 'openai', model: 'gpt' },
    };
    assert.deepEqual(
      resolveRunPlan({ ...loaded, selection: codex }),
      resolveRunPlan({ ...loaded, selection: selections[0]! }),
    );
    for (const selected of selections) {
      const treatment =
        selected.treatment === 'baseline' ? 'with-seed' : 'baseline';
      assert.throws(
        () =>
          resolveRunPlan({ ...loaded, selection: { ...selected, treatment } }),
        { code: 'invalid_selection' },
      );
    }
    for (const [changed, code] of [
      [{ case_id: 'case/other' }, 'unknown_case'],
      [{ treatment: 'other' }, 'unknown_treatment'],
      [
        { agent: { ...selections[0]!.agent, model: 'other-model' } },
        'unknown_agent',
      ],
      [{ repetition: 1 }, 'invalid_repetition'],
    ] as const) {
      assert.throws(
        () =>
          resolveRunPlan({
            ...loaded,
            selection: { ...selections[0]!, ...changed },
          }),
        { code },
      );
    }
  });

  it('preserves custom hook policies and uses them for plan identity and group membership', () => {
    const implicit = {
      adapter: 'custom-agent',
      provider: 'custom-provider',
      model: 'model',
    };
    const native = { ...implicit, hook_trust: 'native' as const };
    const flat = experimentConfig({
      matrix: {
        cases: [CASE_A_PATH],
        treatments: ['baseline'],
        agents: [implicit, native],
        repetitions: 1,
        retries: 0,
      },
    });
    const flatLoaded = inputs({ experiment: flat });
    const flatSelections = expandExperiment(flat, flatLoaded.dataset);
    assert.deepEqual(
      flatSelections.map(({ agent }) => agent),
      [implicit, native],
    );
    assert.equal(Object.hasOwn(flatSelections[0]!.agent, 'hook_trust'), false);
    const flatPlans = flatSelections.map((selected) =>
      resolveRunPlan({ ...flatLoaded, selection: selected }),
    );
    assert.deepEqual(
      flatPlans.map(({ agent }) => agent),
      [implicit, native],
    );
    assert.notEqual(
      resolvedRunPlanSha256(flatPlans[0]!),
      resolvedRunPlanSha256(flatPlans[1]!),
    );

    const grouped = experimentConfig({
      matrix: {
        groups: [
          {
            cases: [CASE_A_PATH],
            treatments: ['baseline'],
            agents: [implicit],
          },
          { cases: [CASE_A_PATH], treatments: ['with-seed'], agents: [native] },
        ],
        repetitions: 1,
        retries: 0,
      },
    });
    const loaded = inputs({ experiment: grouped });
    const selections = expandExperiment(grouped, loaded.dataset);
    assert.deepEqual(
      selections.map(({ agent }) => agent),
      [implicit, native],
    );
    for (const [index, selected] of selections.entries()) {
      assert.deepEqual(
        resolveRunPlan({ ...loaded, selection: selected }).agent,
        selected.agent,
      );
      const otherAgent = selections[1 - index]!.agent;
      assert.throws(
        () =>
          resolveRunPlan({
            ...loaded,
            selection: { ...selected, agent: otherAgent },
          }),
        { code: 'invalid_selection' },
      );
    }
  });

  it('validates cases in every group before resolving a selected plan', () => {
    const experiment = experimentConfig();
    const { cases, treatments, agents } = getMatrixGroups(
      experiment.matrix,
    )[0]!;
    const axes = { cases, treatments, agents };
    experiment.matrix = {
      groups: [axes, { ...axes, cases: ['cases/case/missing.case.yaml'] }],
      repetitions: 1,
      retries: 0,
    };
    const loaded = inputs({ experiment });
    const selected = selection(
      'case/a',
      'baseline',
      'claude-code',
      'anthropic',
      'sonnet',
      0,
    );
    assert.throws(() => expandExperiment(experiment, loaded.dataset), {
      code: 'unknown_case',
    });
    assert.throws(() => resolveRunPlan({ ...loaded, selection: selected }), {
      code: 'unknown_case',
    });
  });

  it('keeps resolved plan identities equal for equivalent flat and grouped selections', () => {
    const flat = experimentConfig();
    const { cases, treatments, agents } = getMatrixGroups(flat.matrix)[0]!;
    const axes = { cases, treatments, agents };
    const grouped = experimentConfig({
      matrix: {
        groups: [axes],
        repetitions: flat.matrix.repetitions,
        retries: flat.matrix.retries,
      },
    });
    const selected = expandExperiment(
      flat,
      inputs({ experiment: flat }).dataset,
    )[1]!;
    const flatPlan = resolveRunPlan({
      ...inputs({ experiment: flat }),
      selection: selected,
    });
    const groupedPlan = resolveRunPlan({
      ...inputs({ experiment: grouped }),
      selection: selected,
    });
    assert.deepEqual(groupedPlan, flatPlan);
    assert.equal(
      resolvedRunPlanSha256(groupedPlan),
      resolvedRunPlanSha256(flatPlan),
    );
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
    assert.deepEqual(plan.role_player, {
      provider: 'anthropic',
      model: 'role-model',
    });
    assert.deepEqual(plan.evaluation.judge, {
      provider: 'anthropic',
      model: 'judge-model',
    });
    {
      const actual = plan.provenance;
      assert.ok(actual);
      assert.deepEqual(actual.dataset, { id: 'dataset', version: '2026.09.0' });
      assert.equal(actual.experiment.id, 'experiment/default');
      assert.equal(actual.experiment.version, '2026.09.0');
      assert.equal(actual.case.id, 'case/a');
      assert.equal(actual.case.path, CASE_A_PATH);
      assert.deepEqual(actual.forge, FORGE_BUILD_IDENTITY);
    }
  });

  it('clones and deeply freezes plans without freezing or retaining caller inputs', () => {
    const loaded = inputs({
      caseDefinition: {
        ...evalCase(),
        checks: { files_created: ['answer.txt'] },
        example_answer: 'A complete answer',
        judging_criteria: [
          {
            requirement_level: 'SHOULD' as const,
            value: 'Correct answer',
            label: 'correctness',
          },
        ],
      },
    });
    const selected = expandExperiment(loaded.experiment, loaded.dataset)[1]!;
    const plan = resolveRunPlan({ ...loaded, selection: selected });
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
    const criterion = definition.judging_criteria[0]!;
    assert.equal(typeof criterion, 'object');
    assert.equal(Object.isFrozen(criterion), false);
    criterion.value = 'Changed criterion';
    criterion.requirement_level = 'OPTIONAL';
    definition.judging_criteria.push({
      requirement_level: 'SHOULD' as const,
      value: 'Changed criterion',
    });
    config.treatments['with-seed']!.setup[0]!.with.target = 'changed-seed.txt';
    config.models.role_player!.model = 'changed-role-player';
    config.models.judge!.model = 'changed-judge';
    assert.ok('resources' in config.runtime);
    config.runtime.resources.cpu_count = 8;
    config.limits.run_timeout_ms = 1;
    selected.agent.model = 'changed-agent';

    assert.equal(serializeResolvedRunPlan(plan), serialized);
    assert.equal(plan.evaluation.example_answer, 'A complete answer');
    assert.deepEqual(plan.evaluation.checks, { files_created: ['answer.txt'] });
  });

  it('keeps dataset locations out of resolved plans and their checksums', () => {
    const loaded = inputs();
    const selected = expandExperiment(loaded.experiment, loaded.dataset)[0]!;
    const before = resolveRunPlan({ ...loaded, selection: selected });
    loaded.experiment.config.dataset.path = '../relocated-dataset';
    const after = resolveRunPlan({ ...loaded, selection: selected });
    assert.equal(
      serializeResolvedRunPlan(after),
      serializeResolvedRunPlan(before),
    );
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
        checks: { files_created: ['greeting.txt'] },
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
    assert.deepEqual(plan.evaluation.checks, {
      files_created: ['greeting.txt'],
    });
  });

  it('materializes an authored native Docker platform in the resolved plan', () => {
    const loaded = inputs({
      experiment: experimentConfig({
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

    assert.equal(
      resolveRunPlan({
        ...loaded,
        selection: selected,
        runtimePlatform: 'linux/arm64',
      }).runtime.platform,
      'linux/arm64',
    );
    assert.throws(
      () => resolveRunPlan({ ...loaded, selection: selected }),
      /requires a concrete runtimePlatform/,
    );
  });

  it('defaults omitted host models to Sol without changing authored inputs', () => {
    const loaded = inputs({ experiment: experimentConfig({ models: {} }) });
    const selected = expandExperiment(loaded.experiment, loaded.dataset)[0]!;
    const plan = resolveRunPlan({ ...loaded, selection: selected });
    const expected = { provider: 'openai', model: 'gpt-6.1-sol' };

    assert.deepEqual(plan.role_player, expected);
    assert.deepEqual(plan.evaluation.judge, expected);
    assert.deepEqual(loaded.experiment.config.models, {});
    assert.notEqual(plan.role_player, plan.evaluation.judge);
    assert.equal(Object.isFrozen(plan.role_player), true);
    assert.equal(Object.isFrozen(plan.evaluation.judge), true);
    assert.deepEqual(
      JSON.parse(serializeResolvedRunPlan(plan)).role_player,
      expected,
    );

    const explicit = inputs({
      experiment: experimentConfig({
        models: { role_player: expected, judge: expected },
      }),
    });
    assert.equal(
      resolvedRunPlanSha256(plan),
      resolvedRunPlanSha256(
        resolveRunPlan({ ...explicit, selection: selected }),
      ),
    );
  });

  it.each(['role_player', 'judge'] as const)(
    'allows an independent %s override while the other host model defaults',
    (purpose) => {
      const override = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
      const loaded = inputs({
        experiment: experimentConfig({ models: { [purpose]: override } }),
      });
      const selected = expandExperiment(loaded.experiment, loaded.dataset)[0]!;
      const plan = resolveRunPlan({ ...loaded, selection: selected });
      assert.deepEqual(
        plan.role_player,
        purpose === 'role_player'
          ? override
          : { provider: 'openai', model: 'gpt-6.1-sol' },
      );
      assert.deepEqual(
        plan.evaluation.judge,
        purpose === 'judge'
          ? override
          : { provider: 'openai', model: 'gpt-6.1-sol' },
      );
    },
  );

  it('omits unused default models from one-shot checks-only plans', () => {
    const loaded = inputs({
      experiment: experimentConfig({ models: {} }),
      caseDefinition: {
        ...evalCase(),
        execution_mode: 'one_shot',
        judging_criteria: [],
        checks: { files_created: ['answer.txt'] },
      },
    });
    const selected = expandExperiment(loaded.experiment, loaded.dataset)[0]!;
    const plan = resolveRunPlan({ ...loaded, selection: selected });
    assert.equal(plan.role_player, undefined);
    assert.equal(plan.evaluation.judge, undefined);
  });

  it('requires every component of a programmatic selection to match the matrix', () => {
    const loaded = inputs();
    const selected = expandExperiment(loaded.experiment, loaded.dataset)[0]!;
    const invalid: [string, Partial<RunSelection>, PlanningError['code']][] = [
      ['case', { case_id: 'case/other' }, 'unknown_case'],
      ['treatment', { treatment: 'other' }, 'unknown_treatment'],
      [
        'adapter',
        { agent: { ...selected.agent, adapter: 'codex' } },
        'unknown_agent',
      ],
      [
        'provider',
        { agent: { ...selected.agent, provider: 'openai' } },
        'unknown_agent',
      ],
      [
        'model',
        { agent: { ...selected.agent, model: 'other-model' } },
        'unknown_agent',
      ],
      ['negative repetition', { repetition: -1 }, 'invalid_repetition'],
      ['fractional repetition', { repetition: 0.5 }, 'invalid_repetition'],
      ['repetition upper bound', { repetition: 1 }, 'invalid_repetition'],
    ];
    for (const [label, changed, code] of invalid) {
      assert.throws(
        () =>
          resolveRunPlan({ ...loaded, selection: { ...selected, ...changed } }),
        (error) => error instanceof PlanningError && error.code === code,
        label,
      );
    }
  });

  it('rejects experiment/dataset drift', () => {
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
      { id: 'other-dataset' },
      { version: 'other-version' },
    ]) {
      assert.throws(
        () =>
          expandExperiment(
            {
              ...loaded.experiment.config,
              dataset: { ...loaded.experiment.config.dataset, ...changed },
            },
            loaded.dataset,
          ),
        { code: 'dataset_experiment_mismatch' },
      );
      assert.throws(
        () =>
          resolveRunPlan({
            ...loaded,
            experiment: {
              ...loaded.experiment,
              config: {
                ...loaded.experiment.config,
                dataset: { ...loaded.experiment.config.dataset, ...changed },
              },
            },
            selection: selected,
          }),
        { code: 'dataset_experiment_mismatch' },
      );
    }
  });

  it('validates treatment fixture sources before execution, including directories and case exclusions', () => {
    const treatmentSetup = (datasetPath: string) => ({
      uses: 'forge/write',
      with: { target: 'seed.txt', source: { dataset_path: datasetPath } },
    });
    const planFor = (datasetPath: string, withIndex = true) => {
      const loaded = inputs({
        experiment: experimentConfig({
          treatments: {
            fixture: { setup: [treatmentSetup(datasetPath)] },
          },
          matrix: {
            ...getMatrixGroups(experimentConfig().matrix)[0]!,
            treatments: ['fixture'],
            repetitions: 1,
            retries: 0,
          },
        }),
      });
      if (!withIndex) delete loaded.dataset.inputPaths;
      return resolveRunPlan({
        ...loaded,
        selection: selection(
          'case/a',
          'fixture',
          'claude-code',
          'anthropic',
          'sonnet',
          0,
        ),
      });
    };
    for (const source of ['fixtures/seed.txt', 'fixtures']) {
      assert.deepEqual(planFor(source).setup.at(-1), treatmentSetup(source));
    }
    assert.throws(() => planFor('fixtures/missing.txt'), {
      code: 'invalid_dataset_input',
      message: /absent from the dataset/,
    });
    for (const source of [CASE_A_PATH, 'cases/case', 'cases']) {
      for (const withIndex of [true, false]) {
        assert.throws(() => planFor(source, withIndex), {
          code: 'invalid_dataset_input',
          message: /contains case definitions/,
        });
      }
    }
    // Hosts with virtual inputs may omit the filesystem index and own existence checks.
    assert.deepEqual(
      planFor('fixtures/virtual.txt', false).setup.at(-1),
      treatmentSetup('fixtures/virtual.txt'),
    );
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
        agent: { ...plan.agent },
        treatment: plan.selection.treatment,
        case_id: plan.selection.case_id,
      },
    };
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(plan));
    assert.equal(serializeResolvedRunPlan(reordered), serialized);
    assert.equal(resolvedRunPlanSha256(reordered), resolvedRunPlanSha256(plan));

    const reversedSetup = { ...plan, setup: [...plan.setup].reverse() };
    // Ordered arrays are semantic; object-key canonicalization must not sort them.
    assert.notEqual(
      resolvedRunPlanSha256(reversedSetup),
      resolvedRunPlanSha256(plan),
    );
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
    agent: {
      adapter,
      provider,
      model,
      ...(adapter === 'codex' ? { hook_trust: 'native' as const } : {}),
    },
    repetition,
  };
}

function evalCase(): EvalCaseV1 {
  return {
    id: 'case/a',
    version: '0.1.0',
    task: 'Complete the task',
    initial_prompt: 'Please start here',
    context: 'Existing application',
    execution_mode: 'multi_turn',
    max_turns: 7,
    setup: [{ uses: 'forge/command', with: { argv: ['git', 'init'] } }],
    judging_criteria: [
      {
        requirement_level: 'SHOULD' as const,
        value: 'The task is complete',
      },
    ],
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
    },
    runtime: {
      adapter: 'docker',
      image: { kind: 'forge' },
      platform: 'linux/amd64',
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
    treatments: {
      baseline: { setup: [] },
      'with-seed': {
        setup: [
          {
            uses: 'forge/write',
            with: {
              target: 'seed.txt',
              source: { dataset_path: 'fixtures/seed.txt' },
            },
          },
        ],
      },
    },
    matrix: {
      cases: [CASE_A_PATH],
      treatments: ['baseline', 'with-seed'],
      agents: [
        { adapter: 'claude-code', provider: 'anthropic', model: 'sonnet' },
      ],
      repetitions: 1,
      retries: 0,
    },
    limits: { run_timeout_ms: 1_800_000 },
  };
  return { ...config, ...overrides };
}

function inputs(
  options: {
    caseDefinition?: EvalCaseV1;
    experiment?: ExperimentConfigV1;
  } = {},
): { dataset: LoadedDatasetV1; experiment: LoadedExperimentConfigV1 } {
  const config = options.experiment ?? experimentConfig();
  const definition = options.caseDefinition ?? evalCase();
  return {
    dataset: {
      root: '/dataset',
      manifestPath: '/dataset/manifest.json',
      manifestRaw: '{}',
      manifest: {
        dataset: { id: 'dataset', version: '2026.09.0' },
        cases: [
          {
            id: definition.id,
            version: definition.version,
            path: CASE_A_PATH,
          },
          {
            id: 'case/b',
            version: definition.version,
            path: CASE_B_PATH,
          },
        ],
      },
      cases: new Map([
        ['case/a', { definition, path: `/dataset/${CASE_A_PATH}` }],
        [
          'case/b',
          {
            definition: { ...definition, id: 'case/b' },
            path: `/dataset/${CASE_B_PATH}`,
          },
        ],
      ]),
      inputPaths: new Set([
        CASE_A_PATH,
        CASE_B_PATH,
        'cases',
        'cases/case',
        'cases/case/a',
        'fixtures',
        'fixtures/seed.txt',
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
