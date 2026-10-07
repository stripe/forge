import type {
  CheckResultV1,
  EvaluationResultV1,
  CriterionResultV1,
} from '../results/index.js';

/** Use a criterion-ratio score and gate a clean pass on invariant checks. */
export function scoreEvaluation(
  criteria: readonly CriterionResultV1[],
  checks: readonly CheckResultV1[],
): EvaluationResultV1 {
  const criteriaTotal = criteria.length;
  const criteriaPassed = criteria.filter((criterion) => criterion.passed).length;
  const score = criteriaTotal === 0 ? 0 : criteriaPassed / criteriaTotal;
  const allChecksPass = checks.length === 0 || checks.every((check) => check.passed);

  let status: EvaluationResultV1['status'];
  if (criteriaTotal === 0) {
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
    judging_criteria: criteria.map((criterion) => ({...criterion})),
    checks: checks.map((check) => ({...check})),
  };
}
