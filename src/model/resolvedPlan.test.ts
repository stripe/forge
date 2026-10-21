import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { FORGE_VERSION } from '../version.ts';
import { BenchmarkModelError } from './errors.ts';
import { parseResolvedRunPlan } from './parse.ts';
import type { ResolvedRunPlanV1 } from './types.ts';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;

function validPlan(): ResolvedRunPlanV1 {
  const setup = [
    {
      uses: 'forge/write' as const,
      with: { target: 'prompt.txt', source: { content: 'hello' } },
    },
  ];
  const checks = { files_created: ['prompt.txt'] };
  const agent = {
    adapter: 'claude-code',
    provider: 'anthropic',
    model: 'claude-test',
  };
  return {
    selection: {
      case_id: 'sample/write',
      treatment: 'baseline',
      agent: { ...agent },
      repetition: 0,
    },
    provenance: {
      dataset: {
        id: 'sample',
        version: '1.0.0',
        manifest_sha256: DIGEST,
      },
      experiment: {
        id: 'sample/experiment',
        version: '1.0.0',
      },
      case: {
        id: 'sample/write',
        path: 'cases/sample/write/eval.yaml',
      },
      forge: { version: FORGE_VERSION },
    },
    case: {
      id: 'sample/write',
      version: '0.1.0',
      initial_prompt: 'Create the requested file.',
      execution_mode: 'one_shot',
      setup,
      judging_criteria: [],
      checks,
    },
    treatment: { id: 'baseline', setup: [] },
    setup,
    interaction: {
      mode: 'one_shot',
      initial_prompt: 'Create the requested file.',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Create the requested file.',
      max_turns: 1,
    },
    evaluation: { judging_criteria: [], checks },
    agent,
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
    limits: { run_timeout_ms: 30 * 60 * 1_000 },
  };
}

describe('parseResolvedRunPlan', () => {
  it('retains historical case identities and filenames in saved artifacts', () => {
    const plan = validPlan();
    const id = 'Legacy_Suite/Case.1';
    plan.selection.case_id = id;
    plan.provenance.case.id = id;
    plan.case.id = id;
    plan.provenance.case.path = 'cases/Legacy_Suite/ordinary.yaml';
    assert.deepEqual(parseResolvedRunPlan(plan), plan);
  });
  it('preserves saved Codex plans without a hook policy and rejects policy drift', () => {
    const input = validPlan();
    input.agent = { adapter: 'codex', provider: 'openai', model: 'gpt-test' };
    input.selection.agent = { ...input.agent };
    assert.deepEqual(parseResolvedRunPlan(input), input);
    assert.equal(parseResolvedRunPlan(input).agent.hook_trust, undefined);

    input.agent.hook_trust = 'native';
    assert.throws(() => parseResolvedRunPlan(input), {
      message: /selection agent must match/,
    });
    input.selection.agent.hook_trust = 'native';
    assert.deepEqual(parseResolvedRunPlan(input), input);
    input.selection.agent.hook_trust = 'automation';
    assert.throws(() => parseResolvedRunPlan(input), {
      message: /selection agent must match/,
    });
  });

  it('rejects removed plan schema and source digest fields', () => {
    assert.throws(
      () => parseResolvedRunPlan({ ...validPlan(), schema_version: 2 }),
      BenchmarkModelError,
    );
    for (const source of ['experiment', 'case'] as const) {
      const plan = validPlan();
      assert.throws(
        () =>
          parseResolvedRunPlan({
            ...plan,
            provenance: {
              ...plan.provenance,
              [source]: { ...plan.provenance[source], sha256: DIGEST },
            },
          }),
        BenchmarkModelError,
      );
    }
  });

  it('checks official producer compatibility before interpreting the plan payload', () => {
    assert.throws(
      () =>
        parseResolvedRunPlan({ provenance: { forge: { version: '99.0.0' } } }),
      (error: unknown) =>
        error instanceof BenchmarkModelError &&
        error.cause instanceof TypeError &&
        /Forge 99\.0\.0 is incompatible/.test(error.cause.message),
    );
    const input = validPlan();
    assert.throws(
      () =>
        parseResolvedRunPlan({
          ...input,
          provenance: { ...input.provenance, forge: {} },
        }),
      BenchmarkModelError,
    );
  });

  it('preserves source provenance without using development commit identity as a compatibility gate', () => {
    for (const length of [40, 64]) {
      const input = validPlan();
      input.provenance.forge = {
        version: FORGE_VERSION,
        commit_sha: 'a'.repeat(length),
        dirty: true,
      };
      const parsed = parseResolvedRunPlan(input);
      assert.deepEqual(parsed.provenance.forge, input.provenance.forge);
      assert.equal(Object.isFrozen(parsed.provenance.forge), true);
      assert.throws(
        () =>
          parseResolvedRunPlan({
            ...input,
            provenance: {
              ...input.provenance,
              forge: { ...input.provenance.forge, commit_sha: 'short' },
            },
          }),
        BenchmarkModelError,
      );
      assert.throws(
        () =>
          parseResolvedRunPlan({
            ...input,
            provenance: {
              ...input.provenance,
              forge: { ...input.provenance.forge, unexpected: true },
            },
          }),
        BenchmarkModelError,
      );
    }
    if (FORGE_VERSION.includes('-dev.')) {
      const input = validPlan();
      input.provenance.forge = {
        version: '0.0.0-dev.1',
        commit_sha: 'b'.repeat(40),
        dirty: false,
      };
      assert.deepEqual(
        parseResolvedRunPlan(input).provenance.forge,
        input.provenance.forge,
      );
    }
  });

  it('accepts and projects a complete planner output', () => {
    const input = validPlan();
    const parsed = parseResolvedRunPlan(input);

    assert.deepEqual(parsed, input);
    assert.notEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.setup), true);
    assert.equal(Object.isFrozen(parsed.case), true);
    assert.equal(
      'resources' in parsed.runtime &&
        Object.isFrozen(parsed.runtime.resources),
      true,
    );
    assert.equal(Object.isFrozen(input), false);
    input.case.setup[0]!.with.target = 'changed.txt';
    assert.equal(parsed.case.setup[0]!.with.target, 'prompt.txt');
    assert.equal(parsed.setup[0]!.with.target, 'prompt.txt');
  });

  it('rejects selection identity drift from the resolved case and agent', () => {
    const input = validPlan();
    input.selection.case_id = 'sample/other';
    assert.throws(() => parseResolvedRunPlan(input), {
      code: 'invalid_plan',
      message: /case IDs must match/,
    });

    const changedAgent = validPlan();
    changedAgent.selection.agent.model = 'other-model';
    assert.throws(() => parseResolvedRunPlan(changedAgent), {
      code: 'invalid_plan',
      message: /selection agent must match/,
    });
  });

  it('rejects reordered case and treatment setup in a serialized plan', () => {
    const input = validPlan();
    const treatmentStep = {
      uses: 'forge/write',
      with: { target: 'treatment.txt', source: { content: 'treatment' } },
    };
    input.selection.treatment = 'with-file';
    input.treatment = { id: 'with-file', setup: [treatmentStep] };
    input.setup = [...input.case.setup, treatmentStep];
    assert.deepEqual(parseResolvedRunPlan(input).setup, input.setup);
    input.setup = [...input.setup].reverse();
    assert.throws(() => parseResolvedRunPlan(input), {
      code: 'invalid_plan',
      message: /case setup followed by treatment setup/,
    });
  });

  it('rejects evaluation checks edited independently of the selected case', () => {
    const input = validPlan();
    input.evaluation.checks = { files_created: ['other.txt'] };
    assert.throws(() => parseResolvedRunPlan(input), {
      code: 'invalid_plan',
      message: /evaluation checks must match/,
    });
  });

  it('binds judging criteria to the selected case and rejects former plan fields', () => {
    const input = validPlan();
    input.case.judging_criteria = [
      {
        requirement_level: 'SHOULD' as const,
        value: 'The task is complete.',
      },
    ];
    input.evaluation.judging_criteria = [...input.case.judging_criteria];
    input.evaluation.judge = { provider: 'anthropic', model: 'claude-judge' };
    assert.deepEqual(parseResolvedRunPlan(input), input);
    const authoredCriterion = {
      value: 'The task is complete.',
    };
    const omittedRequirement = {
      ...input,
      case: { ...input.case, judging_criteria: [authoredCriterion] },
      evaluation: {
        ...input.evaluation,
        judging_criteria: [authoredCriterion],
      },
    };
    assert.deepEqual(parseResolvedRunPlan(omittedRequirement), input);
    assert.deepEqual(
      parseResolvedRunPlan({
        ...omittedRequirement,
        case: { ...input.case, judging_criteria: ['The task is complete.'] },
      }),
      input,
    );
    assert.deepEqual(
      parseResolvedRunPlan({
        ...omittedRequirement,
        evaluation: input.evaluation,
      }),
      input,
    );
    assert.equal(Object.hasOwn(authoredCriterion, 'requirement_level'), false);

    assert.throws(
      () =>
        parseResolvedRunPlan({
          ...input,
          evaluation: {
            ...input.evaluation,
            judging_criteria: [
              {
                ...input.case.judging_criteria[0]!,
                requirement_level: 'SHOULD',
                label: 'changed',
              },
            ],
          },
        }),
      /evaluation criteria must match/,
    );
    for (const section of ['case', 'evaluation'] as const) {
      assert.throws(
        () =>
          parseResolvedRunPlan({
            ...input,
            [section]: {
              ...input[section],
              success_guidelines: input[section].judging_criteria,
            },
          }),
        BenchmarkModelError,
      );
    }
    input.evaluation.judging_criteria = [
      {
        requirement_level: 'SHOULD' as const,
        value: 'A different requirement.',
      },
    ];
    assert.throws(() => parseResolvedRunPlan(input), {
      code: 'invalid_plan',
      message: /evaluation criteria must match/,
    });
  });

  it('rejects inconsistent duplicated execution fields', () => {
    const input = validPlan();
    input.interaction.effective_prompt = 'A changed prompt.';

    try {
      parseResolvedRunPlan(input);
      throw new Error('Expected the resolved plan to be rejected.');
    } catch (error) {
      assert.ok(error instanceof BenchmarkModelError);
      assert.equal((error as BenchmarkModelError).code, 'invalid_plan');
      assert.ok(
        error !== null && typeof error === 'object' && 'message' in error,
      );
      assert.equal(typeof error.message, 'string');
      assert.ok((error.message as string).includes('effective prompt'));
    }
  });

  it('requires materialized defaults and rejects unknown fields', () => {
    const missingDefaults = validPlan() as unknown as Record<string, unknown>;
    missingDefaults.case = {
      id: 'sample/write',
      initial_prompt: 'Create the requested file.',
    };
    assert.throws(
      () => parseResolvedRunPlan(missingDefaults),
      BenchmarkModelError,
    );

    assert.throws(
      () => parseResolvedRunPlan({ ...validPlan(), private_overlay: true }),
      BenchmarkModelError,
    );
  });

  it('rejects completion models when their score-affecting behavior is unused', () => {
    const withRolePlayer = validPlan();
    withRolePlayer.role_player = {
      provider: 'anthropic',
      model: 'claude-role-player',
    };
    assert.throws(() => parseResolvedRunPlan(withRolePlayer), {
      message: /cannot include a role_player model/,
    });

    const withJudge = validPlan();
    withJudge.evaluation.judge = {
      provider: 'anthropic',
      model: 'claude-judge',
    };
    assert.throws(() => parseResolvedRunPlan(withJudge), {
      message: /cannot include a judge model/,
    });
  });

  it('classifies structural failures as invalid plans', () => {
    const cyclic = validPlan() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;

    try {
      parseResolvedRunPlan(cyclic);
      throw new Error('Expected the cyclic plan to be rejected.');
    } catch (error) {
      assert.ok(error instanceof BenchmarkModelError);
      assert.equal((error as BenchmarkModelError).code, 'invalid_plan');
    }
  });
});
