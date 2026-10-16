import { z } from 'zod';

import {
  experimentRunErrorCodeSchema,
  experimentRunIdSchema,
} from './experimentModel.ts';
import { sha256Digest } from './model/hashes.ts';
import { parseRunSelection } from './model/parse.ts';
import type { CriteriaRequirementV1 } from './model/types.ts';
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
  .object({ passed: count, total: count })
  .strict()
  .refine(
    (value) => value.passed <= value.total,
    'Passed counts exceed totals.',
  );
const criteriaByRequirementSchema = z
  .object({
    MUST: criterionCountsSchema,
    SHOULD: criterionCountsSchema,
    OPTIONAL: criterionCountsSchema,
  })
  .strict();
const criterionStatisticsSchema = z
  .object({
    passed: count,
    total: count,
    evaluations: count,
    strict_pass_rate: ratio.nullable(),
    average_pass_rate: ratio.nullable(),
  })
  .strict();
const evaluationSchema = z
  .object({
    status: z.enum(['passed', 'partial', 'failed']),
    score: ratio,
    judging_criteria_passed: count,
    judging_criteria_total: count,
    criteria_by_requirement: criteriaByRequirementSchema,
    checks_passed: count,
    checks_total: count,
  })
  .strict()
  .refine(
    (value) =>
      value.judging_criteria_passed <= value.judging_criteria_total &&
      value.checks_passed <= value.checks_total,
    'Passed counts exceed totals.',
  )
  .refine((value) => {
    const { MUST, SHOULD } = value.criteria_by_requirement;
    return (
      value.judging_criteria_passed === MUST.passed + SHOULD.passed &&
      value.judging_criteria_total === MUST.total + SHOULD.total &&
      value.score ===
        (value.judging_criteria_total === 0
          ? 0
          : value.judging_criteria_passed / value.judging_criteria_total)
    );
  }, 'Scored counts and score must match MUST and SHOULD results.');
const runSchema = z
  .object({
    selection_index: count,
    selection: selectionSchema,
    run_id: experimentRunIdSchema.nullable(),
    state: z.enum(['pending', 'completed', 'errored']),
    error_code: experimentRunErrorCodeSchema.nullable(),
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
    attempts_total: count,
    retry_attempts: count,
    coverage: ratio.nullable(),
    pass_rate: ratio.nullable(),
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
    MUST: { passed: 0, total: 0 },
    SHOULD: { passed: 0, total: 0 },
    OPTIONAL: { passed: 0, total: 0 },
  };
  for (const criterion of evaluation.judging_criteria) {
    const group = criteriaByRequirement[criterion.criteria_requirement];
    group.total += 1;
    if (criterion.passed) group.passed += 1;
  }
  return {
    status: evaluation.status,
    score: evaluation.score,
    judging_criteria_passed: evaluation.judging_criteria_passed,
    judging_criteria_total: evaluation.judging_criteria_total,
    criteria_by_requirement: criteriaByRequirement,
    checks_passed: evaluation.checks.filter((check) => check.passed).length,
    checks_total: evaluation.checks.length,
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
      else failed += 1;
      if (evaluation.judging_criteria_total > 0) {
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
    attempts_total: attempts,
    retry_attempts: retries,
    coverage: runs.length === 0 ? null : completed / runs.length,
    pass_rate: completed === 0 ? null : passed / completed,
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

/** Average per-evaluation fractions; empty groups do not imply a pass or failure. */
function criterionStatistics(
  runs: readonly ExperimentRunReportRunV1[],
  requirement: CriteriaRequirementV1,
): z.infer<typeof criterionStatisticsSchema> {
  let passed = 0;
  let total = 0;
  let evaluations = 0;
  let strictPasses = 0;
  let fractionSum = 0;
  for (const run of runs) {
    if (run.state !== 'completed') continue;
    const group = run.evaluation!.criteria_by_requirement[requirement];
    if (group.total === 0) continue;
    passed += group.passed;
    total += group.total;
    evaluations += 1;
    if (group.passed === group.total) strictPasses += 1;
    fractionSum += group.passed / group.total;
  }
  return {
    passed,
    total,
    evaluations,
    strict_pass_rate: evaluations === 0 ? null : strictPasses / evaluations,
    average_pass_rate: evaluations === 0 ? null : fractionSum / evaluations,
  };
}
