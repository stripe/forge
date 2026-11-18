import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  CRITERION_DECISION_QUESTIONS,
  CRITERION_DECISION_THRESHOLDS,
  type CriterionDecisionV1,
  criterionDecisionOutcome,
  criterionDecisionSchema,
} from './criterionDecision.ts';
import {
  DECISION_REJECTION_REASONS,
  decisionResponseSchema,
  InvalidDecisionResponseError,
  parseDecisionAnswers,
} from './decision.ts';

const candidate = (label: string, probability: number, text = label) => ({
  reading: `Reads ${text}.`,
  rationale: `Because ${text}.`,
  label,
  probability,
});
const parse = (answer: unknown) =>
  parseDecisionAnswers(
    { answers: { criterion: { type: 'choice', ...(answer as object) } } },
    CRITERION_DECISION_QUESTIONS,
  ).criterion!;
const reason = (answer: unknown) => {
  try {
    parse(answer);
  } catch (error) {
    assert.ok(error instanceof InvalidDecisionResponseError);
    return error.reason;
  }
  assert.fail('expected the answer to be rejected');
};

const archived = JSON.parse(
  readFileSync(
    new URL(
      '../../test/fixtures/judge-sampling/archived-candidates.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  name: string;
  expected: { decision: CriterionDecisionV1 };
}[];

describe('verbalized-sampling decisions', () => {
  it('sums candidate weights per label and normalizes by the total', () => {
    const answer = parse({
      candidates: [
        candidate('not_met', 0.35),
        candidate('met', 0.3),
        candidate('met', 0.2),
        candidate('insufficient_evidence', 0.1),
        candidate('met', 0.05),
      ],
    });
    assert.equal(answer.choice, 'met');
    assert.ok(Math.abs(answer.probabilities.met! - 0.55) < 1e-12);
    assert.ok(Math.abs(answer.probabilities.not_met! - 0.35) < 1e-12);
    assert.ok(Math.abs(answer.confidence - 0.55) < 1e-12);
    assert.equal(answer.candidates.length, 5);
  });

  it('saves the renormalized aggregate with the aggregate maximum as confidence', () => {
    // Floating-point detail, pinned because saved sampling judgments carry it:
    // the weights sum to 1.0000000000000002, so the distribution is divided
    // by that sum again while confidence is the undivided maximum.
    const answer = parse({
      candidates: [
        candidate('not_met', 0.35),
        candidate('met', 0.3),
        candidate('met', 0.2),
        candidate('insufficient_evidence', 0.1),
        candidate('met', 0.05),
      ],
    });
    assert.deepEqual(answer.probabilities, {
      met: 0.55,
      not_met: 0.35,
      insufficient_evidence: 0.09999999999999999,
    });
    assert.equal(answer.confidence, 0.5500000000000002);
  });

  it('normalizes weights whose total is not one and keeps them as stated', () => {
    const answer = parse({
      candidates: [candidate('met', 0.2), candidate('not_met', 0.1)],
    });
    assert.equal(answer.choice, 'met');
    assert.ok(Math.abs(answer.probabilities.met! - 2 / 3) < 1e-12);
    assert.deepEqual(
      answer.candidates.map(({ probability }) => probability),
      [0.2, 0.1],
    );
  });

  it('breaks an aggregate tie only by one unambiguous leading candidate', () => {
    assert.equal(
      parse({
        candidates: [
          candidate('met', 0.4),
          candidate('not_met', 0.2),
          candidate('not_met', 0.2),
          candidate('insufficient_evidence', 0.2),
        ],
      }).choice,
      'met',
    );
    assert.equal(
      reason({
        candidates: [
          candidate('met', 0.25),
          candidate('met', 0.25),
          candidate('not_met', 0.25),
          candidate('not_met', 0.25),
        ],
      }),
      'choice_not_argmax',
    );
    // The most probable candidate must name one of the tied labels.
    assert.equal(
      reason({
        candidates: [
          candidate('insufficient_evidence', 0.3),
          candidate('met', 0.15),
          candidate('met', 0.15),
          candidate('met', 0.05),
          candidate('not_met', 0.1),
          candidate('not_met', 0.1),
          candidate('not_met', 0.15),
        ],
      }),
      'choice_not_argmax',
    );
  });

  it('treats weights within 1e-6 as tied and further apart as decided', () => {
    assert.equal(
      reason({
        candidates: [candidate('met', 0.5), candidate('not_met', 0.4999999)],
      }),
      'choice_not_argmax',
    );
    assert.equal(
      parse({
        candidates: [candidate('met', 0.4999), candidate('not_met', 0.5)],
      }).choice,
      'not_met',
    );
  });

  it('accepts a stated choice only when it is a maximum of the aggregate', () => {
    const candidates = [candidate('met', 0.6), candidate('not_met', 0.4)];
    assert.equal(parse({ choice: 'met', candidates }).choice, 'met');
    assert.equal(
      reason({ choice: 'not_met', candidates }),
      'choice_not_argmax',
    );
    assert.equal(reason({ choice: 'maybe', candidates }), 'unknown_choice');
  });

  it('keeps an independently reported confidence and optional explanation', () => {
    const answer = parse({
      confidence: 0.25,
      explanation: '  Stated.  ',
      candidates: [candidate('met', 1)],
    });
    assert.equal(answer.confidence, 0.25);
    assert.equal(answer.explanation, 'Stated.');
    assert.equal(
      reason({ confidence: 2, candidates: [candidate('met', 1)] }),
      'probability_range',
    );
    assert.equal(
      reason({ explanation: ' ', candidates: [candidate('met', 1)] }),
      'explanation',
    );
  });

  it.each([
    ['no candidates', { candidates: [] }, 'candidates'],
    ['no candidates key', {}, 'invalid_schema'],
    [
      'zero total weight',
      { candidates: [candidate('met', 0)] },
      'probabilities_sum',
    ],
    [
      'a weight above one',
      { candidates: [candidate('met', 1.1)] },
      'probability_range',
    ],
    [
      'a negative weight',
      { candidates: [candidate('met', -0.1), candidate('not_met', 1)] },
      'probability_range',
    ],
    [
      'an unknown label',
      { candidates: [candidate('maybe', 1)] },
      'unknown_choice',
    ],
    [
      'an unknown candidate key',
      { candidates: [{ ...candidate('met', 1), secret: 'x' }] },
      'unknown_key',
    ],
    [
      'an empty rationale',
      { candidates: [{ ...candidate('met', 1), rationale: ' ' }] },
      'candidates',
    ],
    [
      'an oversized reading',
      {
        candidates: [{ ...candidate('met', 1), reading: 'r'.repeat(4097) }],
      },
      'candidates',
    ],
    [
      'eleven candidates',
      {
        candidates: Array.from({ length: 11 }, () => candidate('met', 0.1)),
      },
      'candidates',
    ],
    ['a distribution without candidates', { choice: 'met' }, 'invalid_schema'],
  ])('rejects %s with a fixed reason', (_name, answer, expected) => {
    assert.equal(reason(answer), expected);
    assert.ok(
      (DECISION_REJECTION_REASONS as readonly string[]).includes(expected),
    );
  });

  it('rejects a malformed envelope', () => {
    for (const envelope of [
      null,
      {},
      { answers: {} },
      { answers: { criterion: null } },
      { answers: { criterion: { type: 'choice', candidates: [] } }, extra: 1 },
    ])
      assert.throws(
        () => parseDecisionAnswers(envelope, CRITERION_DECISION_QUESTIONS),
        InvalidDecisionResponseError,
      );
  });

  it('asks for exactly the selected number of candidates in a strict schema', () => {
    const schema = decisionResponseSchema(CRITERION_DECISION_QUESTIONS, {
      mode: 'verbalized-sampling',
      candidates: 3,
    });
    assert.equal(schema.strict, true);
    const answer = (
      schema.schema as {
        properties: { answers: { properties: { criterion: unknown } } };
      }
    ).properties.answers.properties.criterion as {
      required: string[];
      properties: {
        candidates: {
          minItems: number;
          maxItems: number;
          items: {
            required: string[];
            properties: { label: { enum: string[] } };
          };
        };
      };
    };
    assert.deepEqual(answer.required, ['type', 'candidates']);
    assert.equal(answer.properties.candidates.minItems, 3);
    assert.equal(answer.properties.candidates.maxItems, 3);
    assert.deepEqual(answer.properties.candidates.items.required, [
      'reading',
      'rationale',
      'label',
      'probability',
    ]);
    assert.deepEqual(answer.properties.candidates.items.properties.label.enum, [
      'met',
      'not_met',
      'insufficient_evidence',
    ]);
  });

  it.each(archived)(
    'derives the saved $name decision from archived candidates',
    ({ expected: { decision } }) => {
      const answer = parse({ candidates: decision.candidates });
      assert.equal(answer.choice, decision.choice);
      assert.deepEqual(answer.probabilities, decision.probabilities);
      assert.equal(answer.confidence, decision.confidence);
      assert.equal(
        criterionDecisionOutcome(
          answer as never,
          CRITERION_DECISION_THRESHOLDS,
        ),
        decision.thresholded_outcome,
      );
      assert.ok(criterionDecisionSchema.safeParse(decision).success);
    },
  );
});

describe('saved criterion decisions', () => {
  const decision = (): CriterionDecisionV1 => ({
    ...structuredClone(archived[0]!.expected.decision),
  });

  it('annotates a weak choice without changing it', () => {
    const weak = archived.find(({ name }) => name === 'weak_met')!.expected
      .decision;
    assert.equal(weak.choice, 'met');
    assert.equal(weak.thresholded_outcome, 'insufficient_evidence');
  });

  it('rejects saved decisions that disagree with their candidates or thresholds', () => {
    const base = decision();
    for (const edit of [
      (d: Record<string, unknown>) => (d.choice = 'not_met'),
      (d: Record<string, unknown>) => (d.thresholded_outcome = 'not_met'),
      (d: Record<string, unknown>) =>
        (d.probabilities = {
          met: 0.5,
          not_met: 0.5,
          insufficient_evidence: 0,
        }),
      (d: Record<string, unknown>) => delete d.candidates,
      (d: Record<string, unknown>) => (d.extra = true),
    ]) {
      const copy = structuredClone(base) as unknown as Record<string, unknown>;
      edit(copy);
      assert.equal(criterionDecisionSchema.safeParse(copy).success, false);
    }
  });
});
