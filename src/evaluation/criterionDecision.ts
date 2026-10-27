import { z } from 'zod';
import type { ChoiceAnswer, ChoiceQuestion } from '../contracts/decision.ts';
import { choiceAnswerSchema, choiceDistributionIsValid } from './decision.ts';

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
  readonly outcome: CriterionDecisionOption;
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

export const criterionDecisionSchema = choiceAnswerSchema(
  CRITERION_DECISION_OPTIONS,
)
  .innerType()
  .omit({ explanation: true })
  .extend({
    choice: z.enum(CRITERION_DECISION_OPTIONS),
    probabilities: z
      .object({
        met: z.number().finite().min(0).max(1),
        not_met: z.number().finite().min(0).max(1),
        insufficient_evidence: z.number().finite().min(0).max(1),
      })
      .strict(),
    outcome: z.enum(CRITERION_DECISION_OPTIONS),
    thresholds: z
      .object({ minimum_probability: z.number().finite().min(0).max(1) })
      .strict(),
  })
  .strict()
  .superRefine((decision, context) => {
    const { outcome, thresholds, ...fields } = decision;
    if (
      !choiceDistributionIsValid(fields) ||
      outcome !== criterionDecisionOutcome(decision, thresholds)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Criterion decision disagrees with its distribution or thresholds.',
      });
    }
  });
