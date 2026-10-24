import { z } from 'zod';

import {
  experimentRunDiagnosticSchema,
  experimentRunErrorCodeSchema,
  experimentRunIdSchema,
} from './experimentModel.ts';
import { sha256Digest } from './model/hashes.ts';
import { ModelProfileSchema, parseRunSelection } from './model/parse.ts';
import type { RequirementLevelV1 } from './model/types.ts';
import type { EvaluationResultV1 } from './results/types.ts';
import { serializeCanonicalJson } from './serialization.ts';
import {
  assertCompatibleForgeVersion,
  FORGE_BUILD_IDENTITY,
  parseForgeBuildIdentity,
} from './version.ts';

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const count = z.number().int().nonnegative().safe();
const ratio = z.number().finite().min(0).max(1);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const selectionSchema = z.unknown().transform(parseRunSelection);
const criterionCountsSchema = z
  .object({ passed: count, total: count, errored: count })
  .strict()
  .refine(
    (value) => value.passed + value.errored <= value.total,
    'Passed and error counts exceed totals.',
  );
const criteriaByRequirementSchema = z
  .object({
    MUST: criterionCountsSchema,
    SHOULD: criterionCountsSchema,
    OPTIONAL: criterionCountsSchema,
  })
  .strict();
const criterionScoreSchema = z
  .object({ strict: ratio.nullable(), avg: ratio.nullable() })
  .strict();
const blendedCriterionScoreSchema = z
  .object({ score: ratio.nullable() })
  .strict();
const criterionScoresSchema = z
  .object({
    required: criterionScoreSchema,
    recommended: criterionScoreSchema,
    blend: blendedCriterionScoreSchema,
  })
  .strict();
const criterionScoreStatisticsSchema = criterionScoreSchema.extend({
  evaluations: count,
});
const criterionStatisticsSchema = z
  .object({
    passed: count,
    total: count,
    evaluations: count,
    judged_evaluations: count,
    fully_judged_evaluations: count,
    errored: count,
    strict_pass_rate: ratio.nullable(),
    average_pass_rate: ratio.nullable(),
  })
  .strict();
const evaluationSchema = z
  .object({
    status: z.enum(['passed', 'partial', 'failed', 'judge_error']),
    score: ratio.nullable(),
    judging_criteria_passed: count,
    judging_criteria_total: count,
    criteria_by_requirement: criteriaByRequirementSchema,
    criterion_scores: criterionScoresSchema,
    judging_criteria_errored: count,
    judging_criteria_excluded_errored: count,
    checks_passed: count,
    checks_total: count,
  })
  .strict()
  .superRefine((value, context) => {
    const { MUST, SHOULD, OPTIONAL } = value.criteria_by_requirement;
    if (
      value.judging_criteria_passed !== MUST.passed + SHOULD.passed ||
      value.judging_criteria_total !== MUST.total + SHOULD.total ||
      value.judging_criteria_errored !== MUST.errored + SHOULD.errored ||
      value.judging_criteria_excluded_errored !== OPTIONAL.errored
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Scored counts must match MUST and SHOULD results; excluded errors must match OPTIONAL results.',
      });
    }
    const judged =
      value.judging_criteria_total - value.judging_criteria_errored;
    if (
      judged < 0 ||
      value.judging_criteria_passed > judged ||
      value.checks_passed > value.checks_total
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Passed and error counts exceed totals.',
      });
      return;
    }
    const score =
      value.judging_criteria_total === 0
        ? 0
        : judged === 0
          ? null
          : value.judging_criteria_passed / judged;
    const checksPass = value.checks_passed === value.checks_total;
    const status =
      value.judging_criteria_errored > 0
        ? 'judge_error'
        : value.judging_criteria_total === 0
          ? checksPass
            ? 'passed'
            : 'failed'
          : score === 1 && checksPass
            ? 'passed'
            : value.judging_criteria_passed > 0 ||
                (value.checks_total > 0 && checksPass)
              ? 'partial'
              : 'failed';
    if (value.score !== score || value.status !== status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evaluation score and status disagree with counts.',
      });
    }
  })
  .refine(
    (value) =>
      serializeCanonicalJson(value.criterion_scores) ===
      serializeCanonicalJson(criterionScores(value.criteria_by_requirement)),
    'Criterion scores must match their requirement counts.',
  );
const runSchema = z
  .object({
    selection_index: count,
    selection: selectionSchema,
    run_id: experimentRunIdSchema.nullable(),
    state: z.enum(['pending', 'completed', 'errored']),
    error_code: experimentRunErrorCodeSchema.nullable(),
    diagnostic: experimentRunDiagnosticSchema.optional(),
    attempt_count: count.max(10_000),
    result_path: z.string().max(160).nullable(),
    evaluation: evaluationSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const pending = run.state === 'pending';
    const completed = run.state === 'completed';
    if (
      pending !== (run.run_id === null) ||
      pending !== (run.attempt_count === 0) ||
      (pending && run.result_path !== null) ||
      completed !== (run.evaluation !== null) ||
      (run.state === 'errored') !== (run.error_code !== null) ||
      (run.state !== 'errored' && run.diagnostic !== undefined) ||
      (completed && run.result_path === null) ||
      (run.result_path !== null &&
        run.result_path !== `runs/${run.run_id}/result.json`)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Run identity, state and result metadata disagree.',
      });
    }
  });
const statisticsSchema = z
  .object({
    selections: count,
    completed: count,
    errored: count,
    pending: count,
    passed: count,
    partial: count,
    failed: count,
    judge_errors: z.object({ evaluations: count, criteria: count }).strict(),
    attempts_total: count,
    retry_attempts: count,
    coverage: ratio.nullable(),
    pass_rate: ratio.nullable(),
    criterion_scores: z
      .object({
        required: criterionScoreStatisticsSchema,
        recommended: criterionScoreStatisticsSchema,
        blend: blendedCriterionScoreSchema.extend({ evaluations: count }),
      })
      .strict(),
    criteria_by_requirement: z
      .object({
        MUST: criterionStatisticsSchema,
        SHOULD: criterionStatisticsSchema,
        OPTIONAL: criterionStatisticsSchema,
      })
      .strict(),
    judging_score: z
      .object({ mean: ratio.nullable(), evaluations: count })
      .strict(),
  })
  .strict();
const coordinates = z
  .object({
    case_id: z.string().min(1).max(4096),
    treatment: z.string().min(1).max(4096),
    agent: z
      .object({
        adapter: z.string().min(1).max(4096),
        provider: z.string().min(1).max(4096),
        model: z.string().min(1).max(4096),
        hook_trust: z.enum(['native', 'automation']).optional(),
        model_profile: ModelProfileSchema.optional(),
      })
      .strict(),
  })
  .strict();
const caseSchema = coordinates.merge(statisticsSchema);
const reportSchema = z
  .object({
    forge: z.unknown().transform(parseForgeBuildIdentity),
    experiment_run_id: experimentRunIdSchema,
    generated_at: z.string().datetime(),
    checkpoint_sha256: digest,
    summary: statisticsSchema,
    cases: z.array(caseSchema).min(1).max(100_000),
    runs: z.array(runSchema).min(1).max(100_000),
  })
  .strict();

export type ExperimentRunReportEvaluationV1 = z.infer<typeof evaluationSchema>;
export type ExperimentRunReportRunV1 = z.infer<typeof runSchema>;
export type ExperimentRunReportStatisticsV1 = z.infer<typeof statisticsSchema>;
export type ExperimentRunReportCaseV1 = z.infer<typeof caseSchema>;
export type ExperimentRunReportV1 = z.infer<typeof reportSchema>;

/** Reduce verified results to bounded report data without discarding classifications. */
export function summarizeReportEvaluation(
  evaluation: EvaluationResultV1,
): ExperimentRunReportEvaluationV1 {
  const criteriaByRequirement: z.infer<typeof criteriaByRequirementSchema> = {
    MUST: { passed: 0, total: 0, errored: 0 },
    SHOULD: { passed: 0, total: 0, errored: 0 },
    OPTIONAL: { passed: 0, total: 0, errored: 0 },
  };
  for (const criterion of evaluation.judging_criteria) {
    const group = criteriaByRequirement[criterion.requirement_level];
    group.total += 1;
    if (criterion.passed === true) group.passed += 1;
    if (criterion.passed === null) group.errored += 1;
  }
  const scoredChecks = evaluation.checks.filter(
    (check) => check.requirement_level !== 'OPTIONAL',
  );
  return {
    status: evaluation.status,
    score: evaluation.score,
    judging_criteria_passed: evaluation.judging_criteria_passed,
    judging_criteria_total: evaluation.judging_criteria_total,
    judging_criteria_errored: evaluation.judging_criteria_errored,
    judging_criteria_excluded_errored: criteriaByRequirement.OPTIONAL.errored,
    criteria_by_requirement: criteriaByRequirement,
    criterion_scores: criterionScores(criteriaByRequirement),
    // OPTIONAL checks are telemetry in result.json and do not gate status.
    checks_passed: scoredChecks.filter((check) => check.passed).length,
    checks_total: scoredChecks.length,
  };
}

/** Check the producing release, then verify every aggregate against its run rows. */
export function parseExperimentRunReport(
  input: unknown,
): ExperimentRunReportV1 {
  const header = z.object({ forge: z.unknown() }).passthrough().parse(input);
  const forge = parseForgeBuildIdentity(header.forge);
  assertCompatibleForgeVersion(forge.version);
  const report = reportSchema.parse(input);
  if (report.runs.some((run, index) => run.selection_index !== index)) {
    throw new Error(
      'Report selection indices must be contiguous and zero-based.',
    );
  }
  const runIds = report.runs.flatMap((run) =>
    run.run_id === null ? [] : [run.run_id],
  );
  if (new Set(runIds).size !== runIds.length)
    throw new Error('Report contains duplicate run IDs.');
  const aggregate = aggregateRuns(report.runs);
  if (
    serializeCanonicalJson(report.summary) !==
      serializeCanonicalJson(aggregate.summary) ||
    serializeCanonicalJson(report.cases) !==
      serializeCanonicalJson(aggregate.cases)
  ) {
    throw new Error('Report statistics do not match its run rows.');
  }
  assertReportBytes(serializeCanonicalJson(report));
  return report;
}

/** Internal construction from bounded, verified latest-selection metadata. */
export function buildExperimentRunReport(input: {
  experimentRunId: string;
  generatedAt: string;
  checkpointBody: string;
  runs: ExperimentRunReportRunV1[];
}): ExperimentRunReportV1 {
  return parseExperimentRunReport({
    forge: FORGE_BUILD_IDENTITY,
    experiment_run_id: input.experimentRunId,
    generated_at: input.generatedAt,
    checkpoint_sha256: sha256Digest(input.checkpointBody),
    ...aggregateRuns(input.runs),
    runs: input.runs,
  });
}

/** Human-readable JSON with deterministic key and selection order. */
export function serializeExperimentRunReport(
  report: ExperimentRunReportV1,
): string {
  const body = `${JSON.stringify(JSON.parse(serializeCanonicalJson(report)), null, 2)}\n`;
  assertReportBytes(body);
  return body;
}

function assertReportBytes(body: string): void {
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES)
    throw new Error('Experiment run report exceeds its byte limit.');
}

function aggregateRuns(runs: ExperimentRunReportRunV1[]): {
  summary: ExperimentRunReportStatisticsV1;
  cases: ExperimentRunReportCaseV1[];
} {
  const groups = new Map<
    string,
    {
      coordinates: z.infer<typeof coordinates>;
      runs: ExperimentRunReportRunV1[];
    }
  >();
  for (const run of runs) {
    const { case_id, treatment, agent } = run.selection;
    const selected = { case_id, treatment, agent };
    const key = serializeCanonicalJson(selected);
    let group = groups.get(key);
    if (group === undefined) {
      group = { coordinates: selected, runs: [] };
      groups.set(key, group);
    }
    group.runs.push(run);
  }
  return {
    summary: statistics(runs),
    cases: [...groups.values()].map((group) => ({
      ...group.coordinates,
      ...statistics(group.runs),
    })),
  };
}

function statistics(
  runs: ExperimentRunReportRunV1[],
): ExperimentRunReportStatisticsV1 {
  let completed = 0;
  let errored = 0;
  let pending = 0;
  let passed = 0;
  let partial = 0;
  let failed = 0;
  let judgeErrorEvaluations = 0;
  let judgeErrorCriteria = 0;
  let incompleteScoringEvaluations = 0;
  let attempts = 0;
  let retries = 0;
  let criterionSum = 0;
  let criterionEvaluations = 0;
  for (const run of runs) {
    attempts += run.attempt_count;
    retries += Math.max(0, run.attempt_count - 1);
    if (run.state === 'pending') pending += 1;
    else if (run.state === 'errored') errored += 1;
    else {
      completed += 1;
      const evaluation = run.evaluation!;
      if (evaluation.status === 'passed') passed += 1;
      else if (evaluation.status === 'partial') partial += 1;
      else if (evaluation.status === 'failed') failed += 1;
      else incompleteScoringEvaluations += 1;
      const criterionErrors =
        evaluation.judging_criteria_errored +
        evaluation.judging_criteria_excluded_errored;
      if (criterionErrors > 0) judgeErrorEvaluations += 1;
      judgeErrorCriteria += criterionErrors;
      if (evaluation.judging_criteria_total > 0 && evaluation.score !== null) {
        criterionSum += evaluation.score;
        criterionEvaluations += 1;
      }
    }
  }
  return {
    selections: runs.length,
    completed,
    errored,
    pending,
    passed,
    partial,
    failed,
    judge_errors: {
      evaluations: judgeErrorEvaluations,
      criteria: judgeErrorCriteria,
    },
    attempts_total: attempts,
    retry_attempts: retries,
    coverage: runs.length === 0 ? null : completed / runs.length,
    pass_rate:
      completed === incompleteScoringEvaluations
        ? null
        : passed / (completed - incompleteScoringEvaluations),
    criterion_scores: {
      required: criterionScoreStatistics(runs, 'required'),
      recommended: criterionScoreStatistics(runs, 'recommended'),
      blend: blendedCriterionScoreStatistics(runs),
    },
    criteria_by_requirement: {
      MUST: criterionStatistics(runs, 'MUST'),
      SHOULD: criterionStatistics(runs, 'SHOULD'),
      OPTIONAL: criterionStatistics(runs, 'OPTIONAL'),
    },
    judging_score: {
      mean:
        criterionEvaluations === 0 ? null : criterionSum / criterionEvaluations,
      evaluations: criterionEvaluations,
    },
  };
}

type CriteriaByRequirement = z.infer<typeof criteriaByRequirementSchema>;
type CriterionCounts = z.infer<typeof criterionCountsSchema>;

/** Required uses MUST; recommended includes both MUST and SHOULD. */
function relevantCriterionCounts(
  groups: CriteriaByRequirement,
  set: 'required' | 'recommended',
): CriterionCounts {
  const { MUST, SHOULD } = groups;
  return set === 'required'
    ? MUST
    : {
        passed: MUST.passed + SHOULD.passed,
        total: MUST.total + SHOULD.total,
        errored: MUST.errored + SHOULD.errored,
      };
}

/** A judged criterion that did not pass; errored criteria are not failures. */
function judgedFailures({ passed, total, errored }: CriterionCounts): number {
  return total - errored - passed;
}

/**
 * Strict is decided only when every criterion was judged, matching
 * `strict_pass_rate`; Avg counts judged criteria only, matching `score`.
 */
function criterionScores(
  groups: CriteriaByRequirement,
): z.infer<typeof criterionScoresSchema> {
  function score(set: 'required' | 'recommended') {
    const { passed, total, errored } = relevantCriterionCounts(groups, set);
    const judged = total - errored;
    return {
      strict: total === 0 || errored > 0 ? null : passed === total ? 1 : 0,
      avg: judged === 0 ? null : passed / judged,
    };
  }
  return {
    required: score('required'),
    recommended: score('recommended'),
    blend: { score: blendedCriterionScore(groups) },
  };
}

/**
 * Fail on any judged MUST failure, otherwise report the judged SHOULD pass
 * fraction. MUST errors without a judged failure leave the gate undecided.
 */
function blendedCriterionScore({
  MUST,
  SHOULD,
}: CriteriaByRequirement): number | null {
  if (MUST.total + SHOULD.total === 0) return null;
  if (judgedFailures(MUST) > 0) return 0;
  if (MUST.errored > 0) return null;
  if (SHOULD.total === 0) return 1;
  const judgedShould = SHOULD.total - SHOULD.errored;
  return judgedShould === 0 ? null : SHOULD.passed / judgedShould;
}

/** Gate each evaluation before averaging, so another run cannot hide a failed MUST. */
function blendedCriterionScoreStatistics(
  runs: readonly ExperimentRunReportRunV1[],
): { score: number | null; evaluations: number } {
  let sum = 0;
  let evaluations = 0;
  for (const run of runs) {
    if (run.state !== 'completed') continue;
    const score = blendedCriterionScore(
      run.evaluation!.criteria_by_requirement,
    );
    if (score === null) continue;
    sum += score;
    evaluations += 1;
  }
  return { score: evaluations === 0 ? null : sum / evaluations, evaluations };
}

/**
 * Pool judged criterion results for Avg; give each fully judged evaluation one
 * Strict vote. `evaluations` counts completed evaluations containing the set.
 */
function criterionScoreStatistics(
  runs: readonly ExperimentRunReportRunV1[],
  set: 'required' | 'recommended',
): z.infer<typeof criterionScoreStatisticsSchema> {
  let passed = 0;
  let judged = 0;
  let evaluations = 0;
  let fullyJudgedEvaluations = 0;
  let strictPasses = 0;
  for (const run of runs) {
    if (run.state !== 'completed') continue;
    const group = relevantCriterionCounts(
      run.evaluation!.criteria_by_requirement,
      set,
    );
    if (group.total === 0) continue;
    passed += group.passed;
    judged += group.total - group.errored;
    evaluations += 1;
    if (group.errored === 0) {
      fullyJudgedEvaluations += 1;
      if (group.passed === group.total) strictPasses += 1;
    }
  }
  return {
    strict:
      fullyJudgedEvaluations === 0
        ? null
        : strictPasses / fullyJudgedEvaluations,
    avg: judged === 0 ? null : passed / judged,
    evaluations,
  };
}

/** Average per-evaluation fractions; empty groups do not imply a pass or failure. */
function criterionStatistics(
  runs: readonly ExperimentRunReportRunV1[],
  requirement: RequirementLevelV1,
): z.infer<typeof criterionStatisticsSchema> {
  let passed = 0;
  let total = 0;
  let evaluations = 0;
  let errored = 0;
  let judgedEvaluations = 0;
  let fullyJudgedEvaluations = 0;
  let strictPasses = 0;
  let fractionSum = 0;
  for (const run of runs) {
    if (run.state !== 'completed') continue;
    const group = run.evaluation!.criteria_by_requirement[requirement];
    if (group.total === 0) continue;
    passed += group.passed;
    total += group.total;
    evaluations += 1;
    errored += group.errored;
    if (group.errored === 0) {
      fullyJudgedEvaluations += 1;
      if (group.passed === group.total) strictPasses += 1;
    }
    const judged = group.total - group.errored;
    if (judged > 0) {
      judgedEvaluations += 1;
      fractionSum += group.passed / judged;
    }
  }
  return {
    passed,
    total,
    evaluations,
    errored,
    judged_evaluations: judgedEvaluations,
    fully_judged_evaluations: fullyJudgedEvaluations,
    strict_pass_rate:
      fullyJudgedEvaluations === 0
        ? null
        : strictPasses / fullyJudgedEvaluations,
    average_pass_rate:
      judgedEvaluations === 0 ? null : fractionSum / judgedEvaluations,
  };
}
