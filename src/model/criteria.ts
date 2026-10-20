import { z } from 'zod';
import {
  DEFAULT_REQUIREMENT_LEVEL,
  type JudgingCriterionV1,
  REQUIREMENT_LEVELS,
  type RequirementLevelV1,
} from './types.ts';

export const JudgingCriterionSchema = z.preprocess(
  (criterion) =>
    typeof criterion === 'string' ? { value: criterion } : criterion,
  z
    .object({
      value: z
        .string()
        .trim()
        .min(1)
        .max(64 * 1024)
        .refine((value) => !value.includes('\0')),
      label: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .optional(),
      requirement_level: z
        .enum(REQUIREMENT_LEVELS)
        .default(DEFAULT_REQUIREMENT_LEVEL),
    })
    .strict()
    .superRefine((criterion, context) => {
      const issue = criterionRequirementWordingIssue(
        criterion.value,
        criterion.requirement_level,
      );
      if (issue !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: issue,
        });
      }
    })
    .transform(
      (criterion): JudgingCriterionV1 => ({
        value: criterion.value,
        ...(criterion.label === undefined ? {} : { label: criterion.label }),
        requirement_level: criterion.requirement_level,
      }),
    ),
);

/** A writing guardrail; scoring uses the declared level, never inferred wording. */
export function criterionRequirementWordingIssue(
  text: string,
  requirement: RequirementLevelV1,
): string | undefined {
  if (requirement === 'MUST' && !/\bMUST\b/.test(text)) {
    return 'MUST criteria must use the uppercase RFC keyword MUST (or MUST NOT) in their text';
  }
  return undefined;
}
