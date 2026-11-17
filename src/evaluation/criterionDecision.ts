import { z } from 'zod';
import { MAX_VERBALIZED_SAMPLING_CANDIDATES } from '../model/judgeMethod.ts';
import {
  type ChoiceAnswer,
  type ChoiceQuestion,
  choiceDistributionIsValid,
  DECISION_PROBABILITY_TOLERANCE,
  MAX_ASSESSMENT_ARGUMENT_CHARACTERS,
} from './decision.ts';

export const CRITERION_DECISION_OPTIONS = [
  'met',
  'not_met',
  'insufficient_evidence',
] as const;
export type CriterionDecisionOption =
  (typeof CRITERION_DECISION_OPTIONS)[number];
export const CRITERION_DECISION_CRITERIA = Object.freeze({
  met: 'The supplied evidence establishes that the criterion was met.',
  not_met: 'The supplied evidence establishes that the criterion was not met.',
  insufficient_evidence:
    'The supplied evidence cannot establish either outcome, for example because relevant code or tool output was not captured.',
});
/** Annotates a saved decision; it never changes whether the criterion passed. */
export const CRITERION_DECISION_THRESHOLDS = Object.freeze({
  minimum_probability: 0.8,
});
export interface CriterionDecisionThresholdsV1 {
  readonly minimum_probability: number;
}
export type CriterionDecisionV1 = Omit<
  ChoiceAnswer<CriterionDecisionOption>,
  'explanation'
> & {
  readonly thresholded_outcome: CriterionDecisionOption;
  readonly thresholds: CriterionDecisionThresholdsV1;
};

export function criterionDecisionOutcome(
  answer: Pick<
    ChoiceAnswer<CriterionDecisionOption>,
    'choice' | 'probabilities'
  >,
  thresholds: CriterionDecisionThresholdsV1,
): CriterionDecisionOption {
  return answer.choice !== 'insufficient_evidence' &&
    answer.probabilities[answer.choice] >= thresholds.minimum_probability
    ? answer.choice
    : 'insufficient_evidence';
}

export const CRITERION_DECISION_QUESTION: ChoiceQuestion<CriterionDecisionOption> =
  Object.freeze({
    type: 'choice',
    instructions:
      'Decide whether the success criterion is met using only the supplied evidence. Missing evidence is distinct from observed failure. Give a concise explanation.',
    criteria: CRITERION_DECISION_CRITERIA,
  });
export const CRITERION_DECISION_QUESTIONS = Object.freeze({
  criterion: CRITERION_DECISION_QUESTION,
});

export const criterionDecisionSchema = z
  .object({
    type: z.literal('choice'),
    confidence: z.number().finite().min(0).max(1),
    choice: z.enum(CRITERION_DECISION_OPTIONS),
    probabilities: z
      .object({
        met: z.number().finite().min(0).max(1),
        not_met: z.number().finite().min(0).max(1),
        insufficient_evidence: z.number().finite().min(0).max(1),
      })
      .strict(),
    thresholded_outcome: z.enum(CRITERION_DECISION_OPTIONS),
    thresholds: z
      .object({ minimum_probability: z.number().finite().min(0).max(1) })
      .strict(),
    candidates: z
      .array(
        z
          .object({
            reading: z.string().min(1).max(MAX_ASSESSMENT_ARGUMENT_CHARACTERS),
            rationale: z
              .string()
              .min(1)
              .max(MAX_ASSESSMENT_ARGUMENT_CHARACTERS),
            label: z.enum(CRITERION_DECISION_OPTIONS),
            probability: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_VERBALIZED_SAMPLING_CANDIDATES),
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      !choiceDistributionIsValid(decision) ||
      !candidatesMatchDistribution(decision) ||
      decision.thresholded_outcome !==
        criterionDecisionOutcome(decision, decision.thresholds)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Criterion decision disagrees with its distribution or thresholds.',
      });
    }
  });

/** Saved candidates must sum, per option and normalized, to the saved distribution. */
function candidatesMatchDistribution(decision: {
  readonly probabilities: Readonly<Record<CriterionDecisionOption, number>>;
  readonly candidates: readonly {
    readonly label: CriterionDecisionOption;
    readonly probability: number;
  }[];
}): boolean {
  const candidates = decision.candidates;
  const sum = candidates.reduce((total, c) => total + c.probability, 0);
  return (
    sum > 0 &&
    CRITERION_DECISION_OPTIONS.every(
      (option) =>
        Math.abs(
          candidates
            .filter((c) => c.label === option)
            .reduce((total, c) => total + c.probability, 0) /
            sum -
            decision.probabilities[option],
        ) <= DECISION_PROBABILITY_TOLERANCE,
    )
  );
}
