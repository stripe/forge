import {
  EVALUATION_SCHEMA_VERSION,
  type CheckResultV1,
  type EvaluationResultV1,
  type GuidelineResultV1,
} from '../results/index.js';

/** Use a guideline-ratio score and gate a clean pass on invariant checks. */
export function scoreEvaluation(
  guidelines: readonly GuidelineResultV1[],
  checks: readonly CheckResultV1[],
): EvaluationResultV1 {
  const guidelinesTotal = guidelines.length;
  const guidelinesPassed = guidelines.filter((guideline) => guideline.passed).length;
  const score = guidelinesTotal === 0 ? 0 : guidelinesPassed / guidelinesTotal;
  const allChecksPass = checks.length === 0 || checks.every((check) => check.passed);

  let status: EvaluationResultV1['status'];
  if (guidelinesTotal === 0) {
    status = allChecksPass ? 'passed' : 'failed';
  } else if (score === 1 && allChecksPass) {
    status = 'passed';
  } else if (guidelinesPassed > 0 || (checks.length > 0 && allChecksPass)) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  return {
    schema_version: EVALUATION_SCHEMA_VERSION,
    score,
    status,
    guidelines_passed: guidelinesPassed,
    guidelines_total: guidelinesTotal,
    guidelines: guidelines.map((guideline) => ({...guideline})),
    checks: checks.map((check) => ({...check})),
  };
}
