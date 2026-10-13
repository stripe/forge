import {
  DEFAULT_REQUIREMENT_LEVEL,
  type JudgingCriterionInputV1,
} from '../model/types.ts';

import type {
  CheckResultV1,
  CriterionResultV1,
  EvaluationResultV1,
} from '../results/index.ts';

/** Use a criterion-ratio score and gate a clean pass on invariant checks. */
export function scoreEvaluation(
  criteria: readonly CriterionResultV1[],
  checks: readonly CheckResultV1[],
): EvaluationResultV1 {
  const included = criteria.filter(
    (criterion) => criterion.requirement_level !== 'OPTIONAL',
  );
  const criteriaTotal = included.length;
  const criteriaPassed = included.filter(
    (criterion) => criterion.passed === true,
  ).length;
  const criteriaErrored = included.filter(
    (criterion) => criterion.passed === null,
  ).length;
  const judgedTotal = criteriaTotal - criteriaErrored;
  const score =
    criteriaTotal === 0
      ? 0
      : judgedTotal === 0
        ? null
        : criteriaPassed / judgedTotal;
  const allChecksPass =
    checks.length === 0 || checks.every((check) => check.passed);

  let status: EvaluationResultV1['status'];
  if (criteriaErrored > 0) {
    status = 'judge_error';
  } else if (criteriaTotal === 0) {
    status = allChecksPass ? 'passed' : 'failed';
  } else if (score === 1 && allChecksPass) {
    status = 'passed';
  } else if (criteriaPassed > 0 || (checks.length > 0 && allChecksPass)) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  return {
    score,
    status,
    judging_criteria_passed: criteriaPassed,
    judging_criteria_total: criteriaTotal,
    judging_criteria_errored: criteriaErrored,
    judging_criteria: criteria.map((criterion) =>
      criterion.passed === null
        ? { ...criterion, error: { ...criterion.error } }
        : { ...criterion },
    ),
    checks: checks.map((check) => ({ ...check })),
  };
}

/** Bind recorded text and effective scoring metadata to an authored criterion. */
export function criterionResultMatchesDefinition(
  result: CriterionResultV1,
  definition: JudgingCriterionInputV1,
): boolean {
  const authored =
    typeof definition === 'string' ? { value: definition } : definition;
  return (
    result.criterion === authored.value.trim() &&
    result.label === authored.label &&
    result.requirement_level ===
      (authored.requirement_level ?? DEFAULT_REQUIREMENT_LEVEL)
  );
}
