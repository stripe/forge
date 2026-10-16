import { z } from 'zod';
import {
  CRITERIA_REQUIREMENTS,
  type CriteriaRequirementV1,
  DEFAULT_CRITERIA_REQUIREMENT,
  type JudgingCriterionV1,
  REQUIREMENT_LEVELS,
  type RequirementLevelV1,
} from './types.ts';

export const JudgingCriterionSchema = z
  .object({
    value: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024)
      .refine((value) => !value.includes('\0')),
    requirement_level: z.enum(REQUIREMENT_LEVELS),
    label: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    criteria_requirement: z
      .enum(CRITERIA_REQUIREMENTS)
      .default(DEFAULT_CRITERIA_REQUIREMENT),
  })
  .strict()
  .superRefine((criterion, context) => {
    const wordingIssue = criterionRequirementWordingIssue(
      criterion.value,
      criterion.criteria_requirement,
    );
    if (wordingIssue !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: wordingIssue,
      });
    }
    const issue = criterionRequirementLevelIssue(
      criterion.value,
      criterion.requirement_level,
    );
    if (issue !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirement_level'],
        message: issue,
      });
    }
  })
  .transform(
    (criterion): JudgingCriterionV1 => ({
      value: criterion.value,
      requirement_level: criterion.requirement_level,
      ...(criterion.label === undefined ? {} : { label: criterion.label }),
      criteria_requirement: criterion.criteria_requirement,
    }),
  );

/** Validate uppercase RFC 2119 terms against the criterion's declared level. */
export function criterionRequirementLevelIssue(
  text: string,
  requirementLevel: RequirementLevelV1,
): string | undefined {
  const levels = new Set(
    Array.from(
      text.matchAll(/\b(?:MUST(?:\s+NOT)?|SHOULD(?:\s+NOT)?|MAY)\b/g),
      (match) => match[0].replace(/\s+/g, ' ') as RequirementLevelV1,
    ),
  );
  if (levels.size > 1) {
    return 'a criterion must not contain conflicting uppercase requirement levels; split it into separate criteria';
  }
  const [textLevel] = levels;
  if (textLevel !== undefined && textLevel !== requirementLevel) {
    return `requirement_level must be ${textLevel} to match the uppercase keyword in the criterion`;
  }
  return undefined;
}

/** A writing guardrail; scoring uses only the declared classification. */
export function criterionRequirementWordingIssue(
  text: string,
  requirement: CriteriaRequirementV1,
): string | undefined {
  if (requirement === 'MUST' && !/\bMUST\b/.test(text)) {
    return 'MUST criteria must use the uppercase RFC keyword MUST (or MUST NOT) in their text';
  }
  return undefined;
}
