import { z } from 'zod';
import { UNKNOWN_EVIDENCE_WARNINGS } from './evaluation/criterionEvidence.ts';

import {
  experimentRunDiagnosticSchema,
  experimentRunErrorCodeSchema,
  experimentRunIdSchema,
} from './experimentModel.ts';
import { sha256Digest } from './model/hashes.ts';
import { ModelProfileSchema, parseRunSelection } from './model/parse.ts';
import type { RequirementLevelV1 } from './model/types.ts';
import { criterionEvidenceWarningsSchema } from './results/parse.ts';
import type { EvaluationResultV1 } from './results/types.ts';
import { serializeCanonicalJson } from './serialization.ts';
import {
  assertCompatibleForgeVersion,
  FORGE_BUILD_IDENTITY,
  parseForgeBuildIdentity,
} from './version.ts';

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_CRITERION_FAILURES = 100;
const MAX_REPORT_CRITERION_FAILURE_BYTES = 64 * 1024;
const count = z.number().int().nonnegative().safe();
const ratio = z.number().finite().min(0).max(1);
const HEADLINE_VIEW = 'must_should_average' as const;
const headlineSchema = z
  .object({
    view: z.literal(HEADLINE_VIEW),
    score: ratio.nullable(),
    evaluations: count,
  })
  .strict()
  .refine(
    (headline) => (headline.score === null) === (headline.evaluations === 0),
    'Headline score is unavailable exactly when no evaluations were counted.',
  );
const decisionMeanSchema = z
  .object({ mean: ratio.nullable(), evaluations: count })
  .strict();
const expectedScoreStatisticsSchema = decisionMeanSchema.extend({
  experimental: z.literal(true),
});
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
    mean_confidence: ratio.nullable().optional(),
    expected_score: ratio
      .nullable()
      .optional()
      .describe('Experimental mean probability of met over scored decisions.'),
    judging_criteria_passed: count,
    judging_criteria_total: count,
    criteria_by_requirement: criteriaByRequirementSchema,
    criterion_scores: criterionScoresSchema,
    judging_criteria_errored: count,
    judging_criteria_excluded_errored: count,
    judging_criteria_insufficient_evidence: count.optional(),
    judging_criteria_low_confidence: count.optional(),
    evidence_warnings: criterionEvidenceWarningsSchema.optional(),
    criterion_failures_omitted: count.optional(),
    criterion_failures: z
      .array(
        z
          .object({
            criterion: z
              .string()
              .min(1)
              .max(64 * 1024),
            label: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/)
              .optional(),
            requirement_level: z.enum(['MUST', 'SHOULD', 'OPTIONAL']),
            outcome: z.enum(['not_met', 'insufficient_evidence']),
            evidence_warnings_ref: z.literal('evaluation'),
          })
          .strict(),
      )
      .max(100_000)
      .optional(),
    checks_passed: count,
    checks_total: count,
  })
  .strict()
  .superRefine((value, context) => {
    const { MUST, SHOULD, OPTIONAL } = value.criteria_by_requirement;
    if (value.criterion_failures !== undefined) {
      const omitted = value.criterion_failures_omitted ?? 0;
      const failed =
        MUST.total +
        SHOULD.total +
        OPTIONAL.total -
        MUST.passed -
        SHOULD.passed -
        OPTIONAL.passed -
        MUST.errored -
        SHOULD.errored -
        OPTIONAL.errored;
      const insufficient = value.criterion_failures.filter(
        (criterion) => criterion.outcome === 'insufficient_evidence',
      ).length;
      if (
        value.evidence_warnings === undefined ||
        value.criterion_failures.length + omitted !== failed ||
        value.judging_criteria_insufficient_evidence === undefined ||
        insufficient > value.judging_criteria_insufficient_evidence ||
        insufficient + omitted < value.judging_criteria_insufficient_evidence
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Criterion failure details disagree with counts or warning references.',
        });
      }
    }
    if (
      value.judging_criteria_low_confidence !== undefined &&
      value.judging_criteria_low_confidence >
        MUST.total +
          SHOULD.total +
          OPTIONAL.total -
          MUST.errored -
          SHOULD.errored -
          OPTIONAL.errored -
          (value.judging_criteria_insufficient_evidence ?? 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Low-confidence count exceeds firm choices.',
      });
    }
    if (
      value.judging_criteria_insufficient_evidence !== undefined &&
      value.judging_criteria_insufficient_evidence >
        MUST.total +
          SHOULD.total +
          OPTIONAL.total -
          MUST.passed -
          SHOULD.passed -
          OPTIONAL.passed -
          MUST.errored -
          SHOULD.errored -
          OPTIONAL.errored
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Insufficient evidence count exceeds failed criteria.',
      });
    }
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
    if (
      (judged === 0 &&
        (value.mean_confidence != null || value.expected_score != null)) ||
      (value.mean_confidence !== undefined &&
        value.expected_score !== undefined &&
        (value.mean_confidence === null) !== (value.expected_score === null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Decision means require valid scored judgments and matching availability.',
      });
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
    rate_limit_wait_ms: count.optional(),
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
    headline: headlineSchema.optional(),
    mean_confidence: decisionMeanSchema.optional(),
    expected_score: expectedScoreStatisticsSchema.optional(),
    rate_limit_wait_ms: count.optional(),
    selections: count,
    completed: count,
    errored: count,
    pending: count,
    passed: count,
    partial: count,
    failed: count,
    insufficient_evidence: z
      .object({ evaluations: count, criteria: count })
      .strict()
      .optional(),
    low_confidence: z
      .object({ evaluations: count, criteria: count })
      .strict()
      .optional(),
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
    cases: z.array(caseSchema).max(100_000),
    runs: z.array(runSchema).max(100_000),
    details_unavailable: z
      .object({
        reason: z.literal('size_limit'),
        runs: count.positive().max(100_000),
        cases: count.positive().max(100_000),
      })
      .strict()
      .optional(),
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
  const decisions = evaluation.judging_criteria.flatMap((criterion) =>
    criterion.requirement_level !== 'OPTIONAL' &&
    criterion.passed !== null &&
    criterion.decision !== undefined
      ? [criterion.decision]
      : [],
  );
  return {
    mean_confidence: summarizeReportMean(
      decisions.map((decision) => decision.confidence),
    ).mean,
    expected_score: summarizeReportMean(
      decisions.map((decision) => decision.probabilities.met),
    ).mean,
    status: evaluation.status,
    score: evaluation.score,
    judging_criteria_passed: evaluation.judging_criteria_passed,
    judging_criteria_total: evaluation.judging_criteria_total,
    judging_criteria_errored: evaluation.judging_criteria_errored,
    judging_criteria_excluded_errored: criteriaByRequirement.OPTIONAL.errored,
    judging_criteria_insufficient_evidence: evaluation.judging_criteria.filter(
      (criterion) => criterion.decision?.choice === 'insufficient_evidence',
    ).length,
    judging_criteria_low_confidence: evaluation.judging_criteria.filter(
      (criterion) =>
        criterion.decision !== undefined &&
        criterion.decision.choice !== 'insufficient_evidence' &&
        criterion.decision.thresholded_outcome === 'insufficient_evidence',
    ).length,
    evidence_warnings: (
      evaluation.evidence_warnings ?? UNKNOWN_EVIDENCE_WARNINGS
    ).map((warning) => ({ ...warning })),
    ...summarizeCriterionFailures(evaluation),
    criteria_by_requirement: criteriaByRequirement,
    criterion_scores: criterionScores(criteriaByRequirement),
    // OPTIONAL checks are telemetry in result.json and do not gate status.
    checks_passed: scoredChecks.filter((check) => check.passed).length,
    checks_total: scoredChecks.length,
  };
}

function summarizeCriterionFailures(
  evaluation: EvaluationResultV1,
): Pick<
  ExperimentRunReportEvaluationV1,
  'criterion_failures' | 'criterion_failures_omitted'
> {
  const failures: NonNullable<
    ExperimentRunReportEvaluationV1['criterion_failures']
  > = [];
  let omitted = 0;
  let bytes = 2;
  for (const criterion of evaluation.judging_criteria) {
    if (criterion.passed !== false) continue;
    const failure = {
      criterion: criterion.criterion,
      ...(criterion.label === undefined ? {} : { label: criterion.label }),
      requirement_level: criterion.requirement_level,
      outcome:
        criterion.decision?.choice === 'insufficient_evidence'
          ? ('insufficient_evidence' as const)
          : ('not_met' as const),
      evidence_warnings_ref: 'evaluation' as const,
    };
    const size = Buffer.byteLength(JSON.stringify(failure)) + 1;
    if (
      failures.length >= MAX_REPORT_CRITERION_FAILURES ||
      bytes + size > MAX_REPORT_CRITERION_FAILURE_BYTES
    )
      omitted += 1;
    else {
      failures.push(failure);
      bytes += size;
    }
  }
  return { criterion_failures: failures, criterion_failures_omitted: omitted };
}

/** Verify complete row aggregates; summary-only reports declare detail loss. */
export function parseExperimentRunReport(
  input: unknown,
): ExperimentRunReportV1 {
  const header = z.object({ forge: z.unknown() }).passthrough().parse(input);
  const forge = parseForgeBuildIdentity(header.forge);
  assertCompatibleForgeVersion(forge.version);
  const report = reportSchema.parse(input);
  for (const statistics of [report.summary, ...report.cases]) {
    for (const mean of [
      statistics.mean_confidence,
      statistics.expected_score,
    ]) {
      if (
        mean !== undefined &&
        ((mean.mean === null) !== (mean.evaluations === 0) ||
          mean.evaluations > statistics.completed ||
          mean.evaluations > statistics.judging_score.evaluations)
      )
        throw new Error(
          'Decision mean availability or evaluation counts disagree.',
        );
    }
  }
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
  if (report.details_unavailable !== undefined) {
    const scored =
      report.summary.passed + report.summary.partial + report.summary.failed;
    if (
      report.runs.length !== 0 ||
      report.cases.length !== 0 ||
      report.details_unavailable.runs !== report.summary.selections ||
      report.details_unavailable.cases > report.details_unavailable.runs ||
      report.summary.completed +
        report.summary.errored +
        report.summary.pending !==
        report.summary.selections ||
      scored > report.summary.completed ||
      report.summary.judge_errors.evaluations > report.summary.completed ||
      (report.summary.headline !== undefined &&
        (report.summary.headline.evaluations > report.summary.completed ||
          report.summary.headline.evaluations <
            report.summary.judging_score.evaluations)) ||
      report.summary.pass_rate !==
        (scored === 0 ? null : report.summary.passed / scored) ||
      report.summary.coverage !==
        report.summary.completed / report.summary.selections
    ) {
      throw new Error(
        'Unavailable report details disagree with retained rows or counts.',
      );
    }
    assertReportBytes(serializeCanonicalJson(report));
    return report;
  }
  if (report.runs.length === 0 || report.cases.length === 0)
    throw new Error(
      'Report details must be present or explicitly unavailable.',
    );
  const aggregate = aggregateRuns(report.runs);
  for (const field of [
    'headline',
    'mean_confidence',
    'expected_score',
  ] as const) {
    if (report.summary[field] === undefined) delete aggregate.summary[field];
    for (const [index, group] of aggregate.cases.entries()) {
      if (report.cases[index]?.[field] === undefined) delete group[field];
    }
  }
  if (
    serializeCanonicalJson(report.summary) !==
      serializeCanonicalJson(aggregate.summary) ||
    serializeCanonicalJson(report.cases) !==
      serializeCanonicalJson(aggregate.cases)
  ) {
    throw new Error('Report statistics do not match its run rows.');
  }
  return boundExperimentReportDetails(report);
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
  return reportBody(boundExperimentReportDetails(report));
}

function reportBody(report: ExperimentRunReportV1): string {
  return `${JSON.stringify(
    JSON.parse(serializeCanonicalJson(report)),
    (_key, value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !Object.hasOwn(value, 'headline')
      )
        return value;
      const { headline, ...rest } = value as Record<string, unknown>;
      return { headline, ...rest };
    },
    2,
  )}\n`;
}

/** Each completed evaluation's saved non-null score has one vote. */
export function summarizeReportHeadline(
  scores: readonly (number | null)[],
): z.infer<typeof headlineSchema> {
  const { mean, evaluations } = summarizeReportMean(scores);
  return { view: HEADLINE_VIEW, score: mean, evaluations };
}

function summarizeReportMean(
  values: readonly (number | null | undefined)[],
): z.infer<typeof decisionMeanSchema> {
  const counted = values.filter((value) => value != null);
  return {
    mean:
      counted.length === 0
        ? null
        : counted.reduce((sum, value) => sum + value, 0) / counted.length,
    evaluations: counted.length,
  };
}

/** Count pretty JSON bytes before allocating a complete serialized report. */
function reportFitsBudget(
  report: ExperimentRunReportV1,
  budget: number,
): boolean {
  let remaining = budget - 1; // trailing newline
  function spend(bytes: number): boolean {
    remaining -= bytes;
    return remaining >= 0;
  }
  function visit(value: unknown, depth: number): boolean {
    if (typeof value !== 'object' || value === null)
      return spend(Buffer.byteLength(JSON.stringify(value)));
    const entries = Array.isArray(value) ? value : Object.entries(value);
    if (!spend(2)) return false;
    if (entries.length === 0) return true;
    if (!spend(1 + depth * 2)) return false;
    for (let index = 0; index < entries.length; index += 1) {
      if (!spend((depth + 1) * 2 + 1 + (index > 0 ? 1 : 0))) return false;
      if (Array.isArray(value)) {
        if (!visit(entries[index], depth + 1)) return false;
      } else {
        const [key, child] = entries[index] as [string, unknown];
        if (
          !spend(Buffer.byteLength(JSON.stringify(key)) + 2) ||
          !visit(child, depth + 1)
        )
          return false;
      }
    }
    return true;
  }
  return visit(report, 0);
}

/** Preserve scores and counts; optional detail loss is explicit and deterministic. */
export function boundExperimentReportDetails(
  report: ExperimentRunReportV1,
  maxBytes = MAX_REPORT_BYTES,
): ExperimentRunReportV1 {
  if (reportFitsBudget(report, maxBytes)) return report;
  const withoutDetails: ExperimentRunReportV1 = {
    ...report,
    runs: report.runs.map((run) => ({
      ...run,
      evaluation:
        run.evaluation === null
          ? null
          : {
              ...run.evaluation,
              ...(run.evaluation.criterion_failures === undefined
                ? {}
                : {
                    criterion_failures: [],
                    criterion_failures_omitted:
                      (run.evaluation.criterion_failures_omitted ?? 0) +
                      run.evaluation.criterion_failures.length,
                  }),
              ...(run.evaluation.evidence_warnings === undefined ||
              run.evaluation.evidence_warnings.length === 0
                ? {}
                : {
                    evidence_warnings: [
                      {
                        source: 'trajectory' as const,
                        code: 'report_evidence_warnings_omitted',
                        message:
                          'Evidence warning details were omitted to bound the report; see the saved evaluation.',
                      },
                    ],
                  }),
            },
    })),
  };
  if (reportFitsBudget(withoutDetails, maxBytes)) return withoutDetails;
  const unavailable: ExperimentRunReportV1 = {
    ...report,
    runs: [],
    cases: [],
    details_unavailable: report.details_unavailable ?? {
      reason: 'size_limit',
      runs: report.runs.length,
      cases: report.cases.length,
    },
  };
  if (!reportFitsBudget(unavailable, maxBytes))
    throw new RangeError('Report byte budget cannot hold its summary.');
  return unavailable;
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
    headline: summarizeReportHeadline(
      runs.flatMap((run) =>
        run.state === 'completed' ? [run.evaluation!.score] : [],
      ),
    ),
    mean_confidence: summarizeReportMean(
      runs.map((run) => run.evaluation?.mean_confidence),
    ),
    expected_score: {
      experimental: true,
      ...summarizeReportMean(runs.map((run) => run.evaluation?.expected_score)),
    },
    ...(runs.some((run) => run.rate_limit_wait_ms !== undefined)
      ? {
          rate_limit_wait_ms: runs.reduce(
            (total, run) => total + (run.rate_limit_wait_ms ?? 0),
            0,
          ),
        }
      : {}),
    selections: runs.length,
    completed,
    errored,
    pending,
    passed,
    partial,
    failed,
    ...(runs.some(
      (run) =>
        run.evaluation?.judging_criteria_insufficient_evidence !== undefined,
    )
      ? {
          insufficient_evidence: {
            evaluations: runs.filter(
              (run) =>
                (run.evaluation?.judging_criteria_insufficient_evidence ?? 0) >
                0,
            ).length,
            criteria: runs.reduce(
              (total, run) =>
                total +
                (run.evaluation?.judging_criteria_insufficient_evidence ?? 0),
              0,
            ),
          },
        }
      : {}),
    ...(runs.some(
      (run) => run.evaluation?.judging_criteria_low_confidence !== undefined,
    )
      ? {
          low_confidence: {
            evaluations: runs.filter(
              (run) =>
                (run.evaluation?.judging_criteria_low_confidence ?? 0) > 0,
            ).length,
            criteria: runs.reduce(
              (total, run) =>
                total + (run.evaluation?.judging_criteria_low_confidence ?? 0),
              0,
            ),
          },
        }
      : {}),
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
