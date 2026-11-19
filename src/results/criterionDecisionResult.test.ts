import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { scoreEvaluation } from '../evaluation/score.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { parseEvaluationResult } from './parse.ts';
import type { CriterionEvidenceWarningV1, CriterionResultV1 } from './types.ts';

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../test/fixtures/judge-sampling/archived-candidates.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { name: string; expected: CriterionResultV1 }[];
const roundTrip = (value: unknown) =>
  parseEvaluationResult(JSON.parse(serializeCanonicalJson(value)));
const sampled = (name: string): CriterionResultV1 => ({
  ...fixtures.find((fixture) => fixture.name === name)!.expected,
  evidence_warnings_ref: 'evaluation',
});

describe('saved sampling decisions', () => {
  it('round-trips decisions and the capture status they were judged with', () => {
    const warnings: CriterionEvidenceWarningV1[] = [
      { source: 'trajectory', code: 'value_omitted', message: 'm' },
    ];
    const evaluation = scoreEvaluation(
      fixtures.map(({ name }) => sampled(name)),
      [],
      warnings,
    );
    assert.deepEqual(evaluation.evidence_warnings, warnings);
    assert.deepEqual(roundTrip(evaluation), evaluation);
  });

  it('scores the choice, so a weak met passes and insufficient evidence fails', () => {
    const evaluation = scoreEvaluation(
      ['weak_met', 'weak_not_met', 'missing', 'unanimous'].map(sampled),
      [],
      [],
    );
    assert.deepEqual(
      evaluation.judging_criteria.map(({ passed }) => passed),
      [true, false, false, true],
    );
    assert.equal(evaluation.score, 2 / 4);
  });

  it('keeps errored and optional criteria out of the denominator', () => {
    const errored: CriterionResultV1 = {
      criterion: 'Errored.',
      requirement_level: 'SHOULD',
      passed: null,
      explanation:
        'Judge response rejected: candidates. (unavailable after 3 attempts)',
      error: {
        type: 'parse_error',
        reason: 'candidates',
        attempts: 3,
        message: 'Judge response rejected: candidates.',
      },
    };
    const evaluation = scoreEvaluation(
      [
        sampled('unanimous'),
        { ...sampled('missing'), requirement_level: 'OPTIONAL' },
        errored,
      ],
      [],
      [],
    );
    assert.equal(evaluation.score, 1);
    assert.equal(evaluation.judging_criteria_total, 2);
    assert.equal(evaluation.judging_criteria_errored, 1);
    assert.equal(evaluation.status, 'judge_error');
    assert.deepEqual(roundTrip(evaluation), evaluation);
  });

  it('records no capture status for criteria judged without a method', () => {
    const plain: CriterionResultV1 = {
      criterion: 'Plain.',
      requirement_level: 'SHOULD',
      passed: true,
      explanation: 'Ok.',
    };
    const evaluation = scoreEvaluation([plain], []);
    assert.equal(Object.hasOwn(evaluation, 'evidence_warnings'), false);
    assert.deepEqual(roundTrip(evaluation), evaluation);
  });

  it('marks an unreported capture status as unknown', () => {
    const evaluation = scoreEvaluation([sampled('unanimous')], []);
    assert.equal(
      evaluation.evidence_warnings?.[0]?.code,
      'evidence_completeness_unknown',
    );
  });

  it('rejects results that contradict their decision or references', () => {
    const good = scoreEvaluation([sampled('unanimous')], [], []);
    type EditableCriterion = {
      passed: boolean;
      decision: Record<string, unknown>;
    };
    type Editable = {
      judging_criteria: [EditableCriterion, ...EditableCriterion[]];
      judging_criteria_passed: number;
      score: number;
      status: string;
      evidence_warnings?: unknown;
    };
    const edit = (change: (value: Editable) => void) => {
      const copy = structuredClone(good) as unknown as Editable;
      change(copy);
      return () => parseEvaluationResult(copy);
    };
    assert.throws(
      edit((v) => {
        v.judging_criteria[0].passed = false;
        v.judging_criteria_passed = 0;
        v.score = 0;
        v.status = 'failed';
      }),
    );
    assert.throws(edit((v) => delete v.evidence_warnings));
    assert.throws(edit((v) => (v.judging_criteria[0].decision.extra = 1)));
    const requestError = scoreEvaluation(
      [
        {
          criterion: 'E.',
          requirement_level: 'SHOULD',
          passed: null,
          explanation: 'Judge request failed after 3 attempts.',
          error: {
            type: 'request_error',
            reason: 'invalid_json',
            attempts: 3,
            message: 'failed',
          },
        },
      ],
      [],
    );
    assert.throws(() => parseEvaluationResult(structuredClone(requestError)));
  });

  it('accepts warning paths that run evidence accepts', () => {
    const evaluation = scoreEvaluation(
      [sampled('unanimous')],
      [],
      [
        {
          source: 'trajectory',
          code: 'x',
          message: 'm',
          path: 'logs/a\tb.jsonl',
        },
      ],
    );
    assert.deepEqual(roundTrip(evaluation), evaluation);
  });
});
