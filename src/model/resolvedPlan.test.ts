import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {BenchmarkModelError} from './errors.js';
import {parseResolvedRunPlan} from './parse.js';
import type {ResolvedRunPlanV2} from './types.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;

function validPlan(): ResolvedRunPlanV2 {
  const setup = [
    {
      uses: 'forge/write' as const,
      with: {target: 'prompt.txt', source: {content: 'hello'}},
    },
  ];
  const checks = {files_created: ['prompt.txt']};
  const agent = {
    adapter: 'claude-code',
    provider: 'anthropic',
    model: 'claude-test',
  };
  return {
    schema_version: 2,
    selection: {
      case_id: 'sample/write',
      treatment: 'baseline',
      agent: {...agent},
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
      forge: {version: '0.1.0'},
    },
    case: {
      schema_version: 1,
      id: 'sample/write',
      initial_prompt: 'Create the requested file.',
      execution_mode: 'one_shot',
      setup,
      success_guidelines: [],
      checks,
    },
    treatment: {id: 'baseline', setup: []},
    setup,
    interaction: {
      mode: 'one_shot',
      initial_prompt: 'Create the requested file.',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Create the requested file.',
      max_turns: 1,
    },
    evaluation: {success_guidelines: [], checks},
    agent,
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
    limits: {run_timeout_ms: 30 * 60 * 1_000},
  };
}

describe('parseResolvedRunPlan', () => {
  it('rejects previous plan versions and removed source digest fields', () => {
    expect(() => parseResolvedRunPlan({...validPlan(), schema_version: 1})).toThrow(
      BenchmarkModelError,
    );
    for (const source of ['experiment', 'case'] as const) {
      const plan = validPlan();
      expect(() => parseResolvedRunPlan({
        ...plan,
        provenance: {
          ...plan.provenance,
          [source]: {...plan.provenance[source], sha256: DIGEST},
        },
      })).toThrow(BenchmarkModelError);
    }
  });
  it('accepts and projects a complete planner output', () => {
    const input = validPlan();
    const parsed = parseResolvedRunPlan(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.setup)).toBe(true);
    expect(Object.isFrozen(parsed.case)).toBe(true);
    expect('resources' in parsed.runtime && Object.isFrozen(parsed.runtime.resources)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('rejects inconsistent duplicated execution fields', () => {
    const input = validPlan();
    input.interaction.effective_prompt = 'A changed prompt.';

    try {
      parseResolvedRunPlan(input);
      throw new Error('Expected the resolved plan to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(BenchmarkModelError);
      expect((error as BenchmarkModelError).code).toBe('invalid_plan');
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('effective prompt'),
      );
    }
  });

  it('requires materialized defaults and rejects unknown fields', () => {
    const missingDefaults = validPlan() as unknown as Record<string, unknown>;
    missingDefaults.case = {
      schema_version: 1,
      id: 'sample/write',
      initial_prompt: 'Create the requested file.',
    };
    expect(() => parseResolvedRunPlan(missingDefaults)).toThrow(
      BenchmarkModelError,
    );

    expect(() =>
      parseResolvedRunPlan({...validPlan(), private_overlay: true}),
    ).toThrow(BenchmarkModelError);
  });

  it('rejects completion models when their score-affecting behavior is unused', () => {
    const withRolePlayer = validPlan();
    withRolePlayer.role_player = {
      provider: 'anthropic',
      model: 'claude-role-player',
    };
    expect(() => parseResolvedRunPlan(withRolePlayer)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('cannot include a role_player model'),
      }),
    );

    const withJudge = validPlan();
    withJudge.evaluation.judge = {
      provider: 'anthropic',
      model: 'claude-judge',
    };
    expect(() => parseResolvedRunPlan(withJudge)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('cannot include a judge model'),
      }),
    );
  });

  it('classifies structural failures as invalid plans', () => {
    const cyclic = validPlan() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;

    try {
      parseResolvedRunPlan(cyclic);
      throw new Error('Expected the cyclic plan to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(BenchmarkModelError);
      expect((error as BenchmarkModelError).code).toBe('invalid_plan');
    }
  });
});
