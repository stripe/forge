import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { scoreEvaluation } from '../evaluation/score.ts';
import type { RequirementLevelV1 } from '../model/types.ts';
import type { CriterionResultV1 } from '../results/types.ts';
import { FORGE_BUILD_IDENTITY } from '../version.ts';
import { compareRegradeResults, type RegradeDiffSourceRun } from './diff.ts';
import { REGRADE_RESULT_FORMAT, type RegradeResultV1 } from './run.ts';

function criterion(
  index: number,
  passed: boolean | null,
  level: RequirementLevelV1 = 'SHOULD',
): CriterionResultV1 {
  const base = {
    criterion: `The answer MUST satisfy criterion ${index}.`,
    requirement_level: level,
    explanation: 'Synthetic judgment.',
  };
  return passed === null
    ? {
        ...base,
        passed,
        error: {
          type: 'request_error',
          attempts: 3,
          message: 'Judge unavailable.',
        },
      }
    : { ...base, passed };
}

function pair(
  id: string,
  before: readonly CriterionResultV1[],
  after: readonly CriterionResultV1[],
) {
  const source: RegradeDiffSourceRun = {
    run_id: id,
    result_sha256: 'a'.repeat(64),
    evaluation: scoreEvaluation(before, []),
  };
  const regrade: RegradeResultV1 = {
    format: REGRADE_RESULT_FORMAT,
    run_id: id,
    judge: { provider: 'example', model: 'judge' },
    source: {
      result_sha256: source.result_sha256,
      judge_evidence_sha256: 'b'.repeat(64),
      original_judge: null,
      original_evaluation: {
        status: source.evaluation.status,
        score: source.evaluation.score,
      },
    },
    evaluation: scoreEvaluation(after, []),
    completion_calls: [],
    regraded_at: '2026-01-01T00:00:00.000Z',
    forge: FORGE_BUILD_IDENTITY,
  };
  return { source, regrade };
}

function compare(pairs: ReturnType<typeof pair>[]) {
  return compareRegradeResults({
    sourceRuns: pairs.map((value) => value.source),
    regrades: pairs.map((value) => value.regrade),
  });
}

describe('compareRegradeResults', () => {
  it('counts 27 of 32 paired verdicts and keeps OPTIONAL flips out of scores', () => {
    const before = Array.from({ length: 32 }, (_, index) =>
      criterion(
        index,
        true,
        index < 10 ? 'MUST' : index < 20 ? 'SHOULD' : 'OPTIONAL',
      ),
    );
    const after = before.map((value, index) =>
      criterion(index, index % 7 !== 0, value.requirement_level),
    );
    const input = pair('run', before, after);
    const snapshot = JSON.stringify(input);
    const diff = compare([input]);
    assert.deepEqual(diff.agreement, { matched: 27, total: 32, rate: 27 / 32 });
    assert.deepEqual(diff.agreement_by_requirement, {
      MUST: { matched: 8, total: 10, rate: 0.8 },
      SHOULD: { matched: 9, total: 10, rate: 0.9 },
      OPTIONAL: { matched: 10, total: 12, rate: 10 / 12 },
    });
    assert.deepEqual(
      diff.flipped_criteria.map((value) => value.criterion_index),
      [0, 7, 14, 21, 28],
    );
    assert.deepEqual(diff.runs, [
      {
        run_id: 'run',
        source_score: 1,
        regrade_score: 17 / 20,
        score_change: 17 / 20 - 1,
      },
    ]);
    assert.equal(diff.mean_score_change, 17 / 20 - 1);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('reports errors on both sides, excludes them from agreement, and averages paired score changes', () => {
    const diff = compare([
      pair(
        'first',
        [
          criterion(0, null, 'MUST'),
          criterion(1, true),
          criterion(2, null, 'OPTIONAL'),
        ],
        [
          criterion(0, false, 'MUST'),
          criterion(1, null),
          criterion(2, null, 'OPTIONAL'),
        ],
      ),
      pair('second', [criterion(0, true)], [criterion(0, false)]),
      pair('third', [criterion(0, null)], [criterion(0, true)]),
      pair('fourth', [criterion(0, false)], [criterion(0, true)]),
    ]);
    assert.deepEqual(diff.agreement, { matched: 0, total: 2, rate: 0 });
    assert.deepEqual(diff.agreement_by_requirement.MUST, {
      matched: 0,
      total: 0,
      rate: null,
    });
    assert.deepEqual(
      diff.judge_errors.map((value) => [
        value.run_id,
        value.side,
        value.criterion_index,
      ]),
      [
        ['first', 'source', 0],
        ['first', 'source', 2],
        ['first', 'regrade', 1],
        ['first', 'regrade', 2],
        ['third', 'source', 0],
      ],
    );
    assert.equal(diff.judge_errors[0]!.error.message, 'Judge unavailable.');
    assert.deepEqual(
      diff.runs.map((run) => run.score_change),
      [-1, -1, null, 1],
    );
    assert.equal(diff.mean_score_change, -1 / 3);
    assert.equal(diff.flipped_criteria.length, 2);
  });

  it('distinguishes missing regrades and checks-only runs from agreement', () => {
    const missing = pair('missing', [criterion(0, null)], [criterion(0, true)]);
    const checks = pair('checks', [], []);
    const diff = compareRegradeResults({
      sourceRuns: [missing.source, checks.source],
      regrades: [],
    });
    assert.deepEqual(diff.missing_regrades, ['missing']);
    assert.deepEqual(diff.not_judged, ['checks']);
    assert.deepEqual(diff.agreement, { matched: 0, total: 0, rate: null });
    assert.equal(diff.mean_score_change, null);
    assert.equal(diff.judge_errors.length, 1);
    assert.deepEqual(diff.runs, []);
    assert.equal(compare([]).agreement.rate, null);
  });

  it('rejects unrelated, duplicate, stale, and mismatched judgments', () => {
    const value = pair('run', [criterion(0, true)], [criterion(0, false)]);
    assert.throws(() => compare([value, value]), /Duplicate source/);
    assert.throws(
      () =>
        compareRegradeResults({
          sourceRuns: [value.source],
          regrades: [value.regrade, value.regrade],
        }),
      /Duplicate regrade/,
    );
    assert.throws(
      () =>
        compareRegradeResults({ sourceRuns: [], regrades: [value.regrade] }),
      /no completed source/,
    );
    assert.throws(
      () =>
        compare([
          {
            ...value,
            source: { ...value.source, result_sha256: 'c'.repeat(64) },
          },
        ]),
      /digest does not match/,
    );
    for (const changed of [
      [],
      [criterion(1, false)],
      [criterion(0, false, 'OPTIONAL')],
      [{ ...criterion(0, false), label: 'different' }],
    ]) {
      assert.throws(
        () =>
          compare([
            {
              ...value,
              regrade: {
                ...value.regrade,
                evaluation: scoreEvaluation(changed, []),
              },
            },
          ]),
        /criteri.*do.*not match/,
      );
    }
    const other = pair('other', [criterion(0, true)], [criterion(0, true)]);
    assert.throws(
      () =>
        compare([
          value,
          {
            ...other,
            regrade: {
              ...other.regrade,
              judge: { provider: 'example', model: 'other' },
            },
          },
        ]),
      /different judges/,
    );
  });
});
