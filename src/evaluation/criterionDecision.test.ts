import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { criterionJudgment } from '../../test/fixtures/criterionJudgment.ts';
import type { DecisionModel } from '../contracts/decision.ts';
import { parseEvaluationResult } from '../results/parse.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { criterionDecisionOutcome } from './criterionDecision.ts';
import { boundCriterionEvidenceWarnings } from './criterionEvidence.ts';
import { judgeCriteria, parseCriterionJudgment } from './criterionJudge.ts';
import { createJudgeTranscriptProjection } from './judgeTranscript.ts';
import { scoreEvaluation } from './score.ts';

const transcript = createJudgeTranscriptProjection({
  schema_version: 'ATIF-v1.8',
  agent: { name: 'synthetic', version: '1' },
  steps: [{ step_id: 1, source: 'agent', message: 'Work completed.' }],
});

function judgment(
  choice: 'met' | 'not_met' | 'insufficient_evidence',
  probabilities: {
    met: number;
    not_met: number;
    insufficient_evidence: number;
  },
) {
  return {
    answers: {
      criterion: {
        type: 'choice',
        choice,
        probabilities,
        confidence: Math.max(...Object.values(probabilities)),
        explanation: 'The relevant code was not captured.',
      },
    },
  };
}

describe('criterion decisions', () => {
  it('bounds warning copies with an explicit marker and keeps the projection stable', () => {
    const warnings = Array.from({ length: 100 }, () => ({
      source: 'workspace' as const,
      code: 'workspace_file_truncated',
      message: 'File text was truncated.',
    }));
    const bounded = boundCriterionEvidenceWarnings(warnings);
    assert.equal(bounded.length, 64);
    assert.equal(bounded.at(-1)!.code, 'evidence_warnings_truncated');
    assert.deepEqual(boundCriterionEvidenceWarnings(bounded), bounded);
    const oversized = boundCriterionEvidenceWarnings([
      { ...warnings[0]!, message: 'x'.repeat(64 * 1024) },
    ]);
    assert.equal(oversized.length, 1);
    assert.equal(oversized[0]!.code, 'evidence_warnings_truncated');
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 16 * 1024);
    assert.deepEqual(boundCriterionEvidenceWarnings([]), []);
  });

  it('applies the probability band in code, including the exact threshold', () => {
    for (const [choice, probabilities, outcome, passed] of [
      [
        'met',
        { met: 0.8, not_met: 0.15, insufficient_evidence: 0.05 },
        'met',
        true,
      ],
      [
        'met',
        { met: 0.799, not_met: 0.15, insufficient_evidence: 0.051 },
        'insufficient_evidence',
        false,
      ],
      [
        'not_met',
        { met: 0.1, not_met: 0.8, insufficient_evidence: 0.1 },
        'not_met',
        false,
      ],
      [
        'not_met',
        { met: 0.3, not_met: 0.6, insufficient_evidence: 0.1 },
        'insufficient_evidence',
        false,
      ],
      [
        'insufficient_evidence',
        { met: 0.05, not_met: 0.05, insufficient_evidence: 0.9 },
        'insufficient_evidence',
        false,
      ],
      [
        'met',
        { met: 0.5, not_met: 0.5, insufficient_evidence: 0 },
        'insufficient_evidence',
        false,
      ],
    ] as const) {
      const result = parseCriterionJudgment(
        JSON.stringify(judgment(choice, probabilities)),
        'Creates a file.',
      );
      assert.equal(result.passed, passed);
      assert.equal(result.decision?.outcome, outcome);
      assert.deepEqual(result.decision?.thresholds, {
        minimum_probability: 0.8,
      });
      assert.equal(result.decision?.choice, choice);
      assert.deepEqual(result.decision?.probabilities, probabilities);
      assert.equal(
        result.decision?.confidence,
        Math.max(...Object.values(probabilities)),
      );
      assert.deepEqual(
        parseEvaluationResult(scoreEvaluation([result], [])),
        scoreEvaluation([result], []),
      );
    }
    assert.equal(
      criterionDecisionOutcome(
        {
          choice: 'met',
          probabilities: { met: 0.7, not_met: 0.2, insufficient_evidence: 0.1 },
        },
        { minimum_probability: 0.6 },
      ),
      'met',
    );
  });

  it('rejects incomplete, out-of-range, unnormalized, inconsistent, and non-maximum answers', () => {
    const answer = criterionJudgment().answers.criterion;
    for (const invalid of [
      { ...answer, probabilities: { met: 1, not_met: 0 } },
      { ...answer, probabilities: { ...answer.probabilities, other: 0 } },
      {
        ...answer,
        probabilities: { met: 1.1, not_met: -0.1, insufficient_evidence: 0 },
      },
      {
        ...answer,
        probabilities: { met: 0.6, not_met: 0.2, insufficient_evidence: 0.1 },
      },
      {
        ...answer,
        probabilities: { met: 0.6, not_met: 0.4, insufficient_evidence: 0.1 },
      },
      { ...answer, choice: 'not_met' },
      { ...answer, choice: 'unknown' },
      { ...answer, confidence: 0.5 },
      { ...answer, confidence: 2 },
      { ...answer, confidence: null },
    ]) {
      const result = parseCriterionJudgment(
        JSON.stringify({ answers: { criterion: invalid } }),
        'Creates a file.',
      );
      assert.equal(result.passed, null);
      assert.equal(result.error?.type, 'parse_error');
      assert.equal(result.decision, undefined);
    }
    const rounded = judgment('met', {
      met: 0.8,
      not_met: 0.1,
      insufficient_evidence: 0.1000001,
    });
    assert.equal(
      parseCriterionJudgment(JSON.stringify(rounded), 'Creates a file.').passed,
      true,
    );
  });

  it('accepts a typed decision model and retries an invalid distribution without losing peer results', async () => {
    let calls = 0;
    const model: DecisionModel = {
      async decide(request) {
        calls += 1;
        assert.equal(request.state.includes('Creates a file.'), true);
        assert.deepEqual(Object.keys(request.questions), ['criterion']);
        assert.deepEqual(Object.keys(request.questions.criterion!.criteria), [
          'met',
          'not_met',
          'insufficient_evidence',
        ]);
        const answer = criterionJudgment().answers.criterion;
        return {
          model: { provider: 'synthetic', model: 'decision' },
          usage: null,
          answers: {
            criterion: {
              ...answer,
              probabilities: {
                ...answer.probabilities,
                met: calls === 1 ? 0.4 : 1,
              },
            },
          },
        };
      },
    };
    const warnings = [
      {
        source: 'workspace' as const,
        code: 'workspace_file_truncated',
        message: 'File text was truncated.',
        path: 'app.ts',
      },
    ];
    const results = await judgeCriteria(
      { transcript, criteria: ['Creates a file.'], evidenceWarnings: warnings },
      model,
      { waitBeforeRetry: async () => {} },
    );
    assert.equal(calls, 2);
    assert.equal(results[0]?.passed, true);
    assert.deepEqual(results[0]?.evidence_warnings, warnings);
    warnings[0]!.message = 'changed';
    assert.equal(
      results[0]!.evidence_warnings![0]!.message,
      'File text was truncated.',
    );
  });

  it('keeps insufficient evidence in the score denominator and distinguishes judge errors', () => {
    const missing = parseCriterionJudgment(
      JSON.stringify(
        judgment('insufficient_evidence', {
          met: 0,
          not_met: 0,
          insufficient_evidence: 1,
        }),
      ),
      'Creates a file.',
    );
    const evaluation = scoreEvaluation(
      [
        parseCriterionJudgment(JSON.stringify(criterionJudgment()), 'Answers.'),
        missing,
        parseCriterionJudgment('{}', 'Checks.'),
      ],
      [],
    );
    assert.equal(evaluation.score, 0.5);
    assert.equal(evaluation.judging_criteria_errored, 1);
    assert.equal(evaluation.judging_criteria_total, 3);
    assert.equal(missing.passed, false);
  });

  it('reads old results unchanged and rejects a forged decision or passed flag on new results', () => {
    const legacy = scoreEvaluation(
      [
        {
          criterion: 'Answers.',
          requirement_level: 'SHOULD',
          passed: false,
          explanation: 'Not met.',
        },
      ],
      [],
    );
    assert.equal(
      serializeCanonicalJson(parseEvaluationResult(legacy)),
      serializeCanonicalJson(legacy),
    );
    const result = parseCriterionJudgment(
      JSON.stringify(
        judgment('met', { met: 0.7, not_met: 0.2, insufficient_evidence: 0.1 }),
      ),
      'Answers.',
    );
    const current = scoreEvaluation([result], []);
    for (const changed of [
      { ...result, passed: true },
      { ...result, decision: { ...result.decision, outcome: 'met' } },
      {
        ...result,
        decision: {
          ...result.decision,
          thresholds: { minimum_probability: -1 },
        },
      },
      { ...result, decision: { ...result.decision, other: 'unknown' } },
      {
        ...result,
        decision: { ...result.decision, probabilities: { met: 1 } },
      },
    ])
      assert.throws(() =>
        parseEvaluationResult({ ...current, judging_criteria: [changed] }),
      );
    const error = parseCriterionJudgment('{}', 'Answers.');
    assert.throws(() =>
      parseEvaluationResult({
        ...scoreEvaluation([error], []),
        judging_criteria: [{ ...error, decision: result.decision }],
      }),
    );
    assert.deepEqual(
      parseEvaluationResult(JSON.parse(serializeCanonicalJson(current))),
      current,
    );
    const parsed = parseEvaluationResult(current);
    const parsedCriterion = parsed.judging_criteria[0]!;
    assert.equal(parsedCriterion.passed, false);
    assert.equal(
      'decision' in parsedCriterion
        ? parsedCriterion.decision?.outcome
        : undefined,
      'insufficient_evidence',
    );
  });
});
