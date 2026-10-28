import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { criterionJudgment } from '../../test/fixtures/criterionJudgment.ts';
import type { DecisionModel } from '../contracts/decision.ts';
import { parseEvaluationResult } from '../results/parse.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { criterionDecisionOutcome } from './criterionDecision.ts';
import { boundCriterionEvidenceWarnings } from './criterionEvidence.ts';
import {
  buildCriterionJudgePrompt,
  judgeCriteria,
  parseCriterionJudgment,
} from './criterionJudge.ts';
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
        explanation: 'Judged from the supplied evidence.',
      },
    },
  };
}
const warning = {
  source: 'trajectory' as const,
  code: 'trajectory_incomplete',
  message: 'PRIVATE_WARNING_TEXT',
  path: 'PRIVATE_PATH',
};

describe('criterion decisions', () => {
  it('keeps a 0.75 met choice passed while recording a separate thresholded outcome', () => {
    const result = parseCriterionJudgment(
      JSON.stringify(
        judgment('met', {
          met: 0.75,
          not_met: 0.2,
          insufficient_evidence: 0.05,
        }),
      ),
      'Creates a file.',
    );
    assert.equal(result.passed, true);
    assert.equal(result.decision?.thresholded_outcome, 'insufficient_evidence');
    assert.equal(scoreEvaluation([result], []).score, 1);
    for (const [probability, outcome] of [
      [0.8, 'met'],
      [0.799, 'insufficient_evidence'],
    ] as const) {
      const parsed = parseCriterionJudgment(
        JSON.stringify(
          judgment('met', {
            met: probability,
            not_met: 1 - probability,
            insufficient_evidence: 0,
          }),
        ),
        'Creates a file.',
      );
      assert.equal(parsed.passed, true);
      assert.equal(parsed.decision?.thresholded_outcome, outcome);
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

  it('normalizes rounded replies and derives confidence without excluding them from scoring', () => {
    for (const probabilities of [
      { met: 0.85, not_met: 0.1, insufficient_evidence: 0.04 },
      { met: 0.85, not_met: 0.1, insufficient_evidence: 0.06 },
      { met: 0.85, not_met: 0.1, insufficient_evidence: 0.03 },
      { met: 0.85, not_met: 0.1, insufficient_evidence: 0.07 },
    ]) {
      const result = parseCriterionJudgment(
        JSON.stringify(judgment('met', probabilities)),
        'Creates a file.',
      );
      assert.equal(result.passed, true);
      assert.equal(result.error, undefined);
      const sum = Object.values(probabilities).reduce(
        (total, p) => total + p,
        0,
      );
      assert.ok(
        Math.abs(result.decision!.probabilities.met - 0.85 / sum) < 1e-12,
      );
      assert.equal(
        result.decision!.confidence,
        result.decision!.probabilities.met,
      );
      assert.deepEqual(
        parseEvaluationResult(scoreEvaluation([result], [])),
        scoreEvaluation([result], []),
      );
    }
  });

  it.each([
    ['not_met', { met: 0.5, not_met: 0.5, insufficient_evidence: 0 }],
    ['not_met', { met: 0.4, not_met: 0.4, insufficient_evidence: 0.2 }],
    ['met', { met: 0.5, not_met: 0.5, insufficient_evidence: 0 }],
    ['met', { met: 0.4, not_met: 0.4, insufficient_evidence: 0.2 }],
    [
      'insufficient_evidence',
      { met: 0.5, not_met: 0, insufficient_evidence: 0.5 },
    ],
    [
      'not_met',
      { met: 0.5000001, not_met: 0.4999999, insufficient_evidence: 0 },
    ],
    ['met', { met: 0.4999999, not_met: 0.5000001, insufficient_evidence: 0 }],
    [
      'insufficient_evidence',
      { met: 0.5000001, not_met: 0, insufficient_evidence: 0.4999999 },
    ],
    [
      'not_met',
      { met: 0.49, not_met: 0.4899995, insufficient_evidence: 0.0000005 },
    ],
    [
      'not_met',
      { met: 0.51, not_met: 0.509999, insufficient_evidence: 0.000001 },
    ],
  ] as const)(
    'keeps the reported %s choice at a tie or near tie: %j',
    (choice, probabilities) => {
      const result = parseCriterionJudgment(
        JSON.stringify(judgment(choice, probabilities)),
        'Answers.',
      );
      assert.equal(result.decision?.choice, choice);
      assert.equal(result.passed, choice === 'met');
      const evaluation = scoreEvaluation([result], []);
      assert.equal(evaluation.score, choice === 'met' ? 1 : 0);
      assert.deepEqual(
        parseEvaluationResult(JSON.parse(serializeCanonicalJson(evaluation))),
        evaluation,
      );
    },
  );

  it.each([
    ['not_met', { met: 0.8, not_met: 0.2, insufficient_evidence: 0 }],
    ['met', { met: 0.2, not_met: 0.8, insufficient_evidence: 0 }],
    [
      'insufficient_evidence',
      { met: 0.8, not_met: 0, insufficient_evidence: 0.2 },
    ],
    ['not_met', { met: 0.500001, not_met: 0.499999, insufficient_evidence: 0 }],
    [
      'not_met',
      { met: 0.49, not_met: 0.489999, insufficient_evidence: 0.000001 },
    ],
  ] as const)(
    'rejects a clearly non-maximum %s choice without replacing it: %j',
    (choice, probabilities) => {
      const result = parseCriterionJudgment(
        JSON.stringify(judgment(choice, probabilities)),
        'Answers.',
      );
      assert.equal(result.passed, null);
      assert.equal(result.decision, undefined);
      assert.equal(result.error?.reason, 'choice_not_argmax');
      const valid = parseCriterionJudgment(
        JSON.stringify(criterionJudgment(false)),
        'Answers.',
      );
      assert.ok(valid.passed !== null);
      assert.ok(valid.decision);
      const sum = Object.values(probabilities).reduce<number>(
        (total, p) => total + p,
        0,
      );
      const normalized = {
        met: probabilities.met / sum,
        not_met: probabilities.not_met / sum,
        insufficient_evidence: probabilities.insufficient_evidence / sum,
      };
      const forged = {
        ...valid,
        passed: choice === 'met',
        decision: {
          ...valid.decision,
          choice,
          probabilities: normalized,
          confidence: Math.max(...Object.values(normalized)),
          thresholded_outcome: 'insufficient_evidence' as const,
        },
      };
      assert.throws(() => parseEvaluationResult(scoreEvaluation([forged], [])));
    },
  );

  it('stores fixed rejection reasons without caller data', () => {
    const answer = criterionJudgment().answers.criterion;
    const invalids = [
      [{ answers: {} }, 'missing_answer'],
      [
        {
          answers: { criterion: { ...answer, PRIVATE_FIELD: 'PRIVATE_VALUE' } },
        },
        'unknown_key',
      ],
      [
        {
          answers: {
            criterion: { ...answer, probabilities: { met: 1, not_met: 0 } },
          },
        },
        'missing_option',
      ],
      [
        {
          answers: {
            criterion: {
              ...answer,
              probabilities: {
                met: 1.1,
                not_met: -0.1,
                insufficient_evidence: 0,
              },
            },
          },
        },
        'probability_range',
      ],
      [
        judgment('met', { met: 0.6, not_met: 0.2, insufficient_evidence: 0.1 }),
        'probabilities_sum',
      ],
      [
        { answers: { criterion: { ...answer, choice: 'PRIVATE_CHOICE' } } },
        'unknown_choice',
      ],
      [
        { answers: { criterion: { ...answer, explanation: ' ' } } },
        'explanation',
      ],
      [{ answers: { PRIVATE_ID: answer } }, 'unknown_key'],
    ] as const;
    for (const [raw, reason] of invalids) {
      const result = parseCriterionJudgment(JSON.stringify(raw), 'Answers.');
      assert.equal(result.passed, null);
      assert.equal(result.error?.reason, reason);
      assert.match(result.error!.message, new RegExp(reason));
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
    assert.equal(
      parseCriterionJudgment('bad json', 'Answers.').error?.reason,
      'invalid_json',
    );
    const invalid = parseCriterionJudgment('{}', 'Answers.');
    const evaluation = scoreEvaluation([invalid], []);
    assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    assert.throws(() =>
      parseEvaluationResult({
        ...evaluation,
        judging_criteria: [
          { ...invalid, error: { ...invalid.error, type: 'request_error' } },
        ],
      }),
    );
  });

  it('uses an answer-only decision envelope and stores warning references instead of copies', async () => {
    let calls = 0;
    const model: DecisionModel = {
      async decide() {
        calls += 1;
        return {
          answers: {
            criterion: {
              ...criterionJudgment().answers.criterion,
              confidence: 0,
              probabilities: {
                met: calls === 1 ? 0.4 : 1,
                not_met: 0,
                insufficient_evidence: 0,
              },
            },
          },
        };
      },
    };
    const warnings = [warning];
    const results = await judgeCriteria(
      {
        transcript,
        criteria: ['Answers.', 'Checks.'],
        evidenceWarnings: warnings,
      },
      model,
      { waitBeforeRetry: async () => {} },
    );
    assert.equal(calls, 3);
    assert.ok(
      results.every(
        (result) => result.passed === true && result.decision?.confidence === 1,
      ),
    );
    assert.ok(
      results.every((result) => result.evidence_warnings_ref === 'evaluation'),
    );
    assert.doesNotMatch(JSON.stringify(results), /PRIVATE_WARNING_TEXT/);
    const evaluation = scoreEvaluation(results, [], warnings);
    assert.equal(
      JSON.stringify(evaluation).split('PRIVATE_WARNING_TEXT').length - 1,
      1,
    );
    assert.notEqual(evaluation.evidence_warnings, warnings);
    assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    const { evidence_warnings: _warnings, ...dangling } = evaluation;
    assert.throws(() => parseEvaluationResult(dangling));
    assert.equal(
      scoreEvaluation(results, []).evidence_warnings?.[0]?.code,
      'evidence_completeness_unknown',
    );
  });

  it('shows fixed trajectory capture status without warning text or paths', () => {
    const partial = buildCriterionJudgePrompt(
      { transcript, evidenceWarnings: [warning] },
      'Answers.',
    );
    assert.match(partial, /Trajectory capture status: partial or fallback/);
    assert.doesNotMatch(partial, /PRIVATE/);
    assert.match(
      buildCriterionJudgePrompt(
        {
          transcript,
          evidenceWarnings: [{ ...warning, code: 'source_unavailable' }],
        },
        'Answers.',
      ),
      /native evidence unavailable/,
    );
    assert.match(
      buildCriterionJudgePrompt(
        { transcript, evidenceWarnings: [] },
        'Answers.',
      ),
      /Trajectory capture status: complete/,
    );
    assert.match(
      buildCriterionJudgePrompt({ transcript }, 'Answers.'),
      /Trajectory capture status: unknown/,
    );
  });

  it('bounds evaluation warnings with a stable explicit marker', () => {
    const warnings = Array.from({ length: 100 }, () => warning);
    const bounded = boundCriterionEvidenceWarnings(warnings);
    assert.equal(bounded.length, 64);
    assert.equal(bounded.at(-1)?.code, 'evidence_warnings_truncated');
    assert.deepEqual(boundCriterionEvidenceWarnings(bounded), bounded);
    const oversized = boundCriterionEvidenceWarnings([
      { ...warning, message: 'x'.repeat(64 * 1024) },
    ]);
    assert.equal(oversized[0]?.code, 'evidence_warnings_truncated');
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 16 * 1024);
  });

  it('keeps insufficient evidence in the denominator and preserves old result shapes', () => {
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
    const current = parseCriterionJudgment(
      JSON.stringify(
        judgment('met', {
          met: 0.75,
          not_met: 0.2,
          insufficient_evidence: 0.05,
        }),
      ),
      'Answers.',
    );
    for (const changed of [
      { ...current, passed: false },
      {
        ...current,
        decision: { ...current.decision, thresholded_outcome: 'met' },
      },
      {
        ...current,
        decision: {
          ...current.decision,
          thresholds: { minimum_probability: -1 },
        },
      },
      {
        ...current,
        decision: { ...current.decision, probabilities: { met: 1 } },
      },
    ])
      assert.throws(() =>
        parseEvaluationResult({
          ...scoreEvaluation([current], []),
          judging_criteria: [changed],
        }),
      );
  });
});
