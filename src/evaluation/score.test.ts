import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { REQUIREMENT_LEVELS } from '../model/types.ts';
import type { CriterionResultV1 } from '../results/types.ts';
import { criterionResultMatchesDefinition, scoreEvaluation } from './score.ts';

describe('scoreEvaluation', () => {
  it('scores MUST and SHOULD while retaining OPTIONAL as telemetry', () => {
    for (const requirement_level of REQUIREMENT_LEVELS) {
      const result = scoreEvaluation(
        [
          {
            criterion: 'The implementation MUST create one subscription.',
            requirement_level,
            passed: false,
            explanation: 'Missing.',
          },
        ],
        [],
      );
      assert.equal(
        result.judging_criteria_total,
        requirement_level === 'OPTIONAL' ? 0 : 1,
      );
      assert.equal(
        result.status,
        requirement_level === 'OPTIONAL' ? 'passed' : 'failed',
      );
      assert.equal(
        result.judging_criteria[0]?.requirement_level,
        requirement_level,
      );
    }
  });
  it('binds required vs recommended scoring classifications', () => {
    const definition = {
      requirement_level: 'SHOULD' as const,
      value: 'MUST create one subscription.',
    };
    const result = {
      requirement_level: 'SHOULD' as const,
      criterion: definition.value,
      passed: false,
      explanation: 'Missing.',
    };
    assert.equal(scoreEvaluation([result], []).status, 'failed');
    assert.equal(scoreEvaluation([result], []).judging_criteria_total, 1);
    assert.equal(
      criterionResultMatchesDefinition(
        { ...result, requirement_level: 'SHOULD' },
        definition,
      ),
      true,
    );
    assert.equal(
      criterionResultMatchesDefinition(
        { ...result, requirement_level: 'MUST' },
        definition,
      ),
      false,
    );
    assert.equal(
      criterionResultMatchesDefinition(result, {
        ...definition,
        requirement_level: 'OPTIONAL',
      }),
      false,
    );
  });
  it('retains excluded judgments without counting them or allowing them to mask an incorrect answer', () => {
    for (const passed of [true, false]) {
      const criteria = [
        {
          requirement_level: 'SHOULD' as const,
          criterion: 'Correct answer',
          label: 'correctness',
          passed,
          explanation: '',
        },
        {
          criterion: 'Read docs',
          label: 'source',
          requirement_level: 'OPTIONAL' as const,
          passed: !passed,
          explanation: '',
        },
      ];
      for (const checks of [[], [{ name: 'file', passed: false }]]) {
        const result = scoreEvaluation(criteria, checks);
        assert.equal(result.score, passed ? 1 : 0);
        assert.equal(
          result.status,
          passed ? (checks.length ? 'partial' : 'passed') : 'failed',
        );
        assert.equal(result.judging_criteria_total, 1);
        assert.equal(result.judging_criteria_passed, passed ? 1 : 0);
        assert.deepEqual(result.judging_criteria, criteria);
      }
    }
  });

  it('excludes judge errors while retaining valid agent failures and error details', () => {
    const error: CriterionResultV1 = {
      requirement_level: 'SHOULD' as const,
      criterion: 'unavailable',
      passed: null,
      error: { type: 'request_error', attempts: 3 },
      explanation: 'Request failed.',
    };
    const scored = scoreEvaluation(
      [
        {
          requirement_level: 'SHOULD' as const,
          criterion: 'one',
          passed: true,
          explanation: 'yes',
        },
        {
          requirement_level: 'SHOULD' as const,
          criterion: 'two',
          passed: false,
          explanation: 'no',
        },
        error,
      ],
      [{ name: 'file', passed: true }],
    );
    assert.equal(scored.score, 0.5);
    assert.equal(scored.status, 'judge_error');
    assert.equal(scored.judging_criteria_total, 3);
    assert.equal(scored.judging_criteria_passed, 1);
    assert.equal(scored.judging_criteria_errored, 1);
    assert.deepEqual(scored.judging_criteria[2], error);
    assert.notEqual(scored.judging_criteria[2]!.error, error.error);
  });

  it('does not fabricate a score or an agent pass/fail when all judgments error', () => {
    const error: CriterionResultV1 = {
      requirement_level: 'SHOULD' as const,
      criterion: 'unavailable',
      passed: null,
      error: { type: 'parse_error', attempts: 3 },
      explanation: 'Malformed response.',
    };
    for (const checks of [
      [],
      [{ name: 'file', passed: true }],
      [{ name: 'file', passed: false }],
    ]) {
      const scored = scoreEvaluation([error], checks);
      assert.equal(scored.score, null);
      assert.equal(scored.status, 'judge_error');
      assert.equal(scored.judging_criteria_errored, 1);
      assert.deepEqual(scored.checks, checks);
    }
  });

  it('preserves the checks-only score-zero behavior', () => {
    {
      const actual = scoreEvaluation([], [{ name: 'file', passed: true }]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'passed');
      assert.equal(Object.hasOwn(actual, 'schema_version'), false);
    }
  });

  it('gates a clean pass on checks without reducing a full criterion score', () => {
    {
      const actual = scoreEvaluation(
        [
          {
            requirement_level: 'SHOULD' as const,
            criterion: 'one',
            passed: true,
            explanation: 'yes',
          },
          {
            requirement_level: 'SHOULD' as const,
            criterion: 'two',
            passed: true,
            explanation: 'yes',
          },
        ],
        [{ name: 'file', passed: false }],
      );
      assert.ok(actual);
      assert.equal(actual.score, 1);
      assert.equal(actual.status, 'partial');
      assert.equal(actual.judging_criteria_passed, 2);
      assert.equal(actual.judging_criteria_total, 2);
    }
  });

  it('does not include deterministic checks in the criterion denominator', () => {
    const criteria = [
      {
        requirement_level: 'SHOULD' as const,
        criterion: 'one',
        passed: true,
        explanation: 'yes',
      },
      {
        requirement_level: 'SHOULD' as const,
        criterion: 'two',
        passed: false,
        explanation: 'no',
      },
    ];
    for (const checks of [
      [],
      [{ name: 'file', passed: true }],
      [{ name: 'file', passed: false }],
    ]) {
      {
        const actual = scoreEvaluation(criteria, checks);
        assert.ok(actual);
        assert.equal(actual.score, 0.5);
        assert.equal(actual.status, 'partial');
        assert.equal(actual.judging_criteria_passed, 1);
        assert.equal(actual.judging_criteria_total, 2);
      }
    }
  });

  it('requires actual successful checks to establish partial success when no criterion passes', () => {
    const criteria = [
      {
        requirement_level: 'SHOULD' as const,
        criterion: 'one',
        passed: false,
        explanation: 'no',
      },
    ];
    {
      const actual = scoreEvaluation(criteria, []);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'failed');
    }
    {
      const actual = scoreEvaluation(criteria, [
        { name: 'file', passed: true },
      ]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'partial');
    }
    {
      const actual = scoreEvaluation([], [{ name: 'file', passed: false }]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'failed');
      assert.equal(actual.judging_criteria_passed, 0);
      assert.equal(actual.judging_criteria_total, 0);
    }
  });
});
