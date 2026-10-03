import {z} from 'zod';

import {campaignErrorCodeSchema, campaignRunIdSchema} from './campaignModel.js';
import {sha256Digest} from './model/hashes.js';
import {parseRunSelection} from './model/parse.js';
import {serializeCanonicalJson} from './serialization.js';

export const CAMPAIGN_REPORT_SCHEMA_VERSION = 1 as const;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const count = z.number().int().nonnegative().safe();
const ratio = z.number().finite().min(0).max(1);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const selectionSchema = z.unknown().transform(parseRunSelection);
const evaluationSchema = z.object({
  status: z.enum(['passed', 'partial', 'failed']),
  score: ratio,
  guidelines_passed: count,
  guidelines_total: count,
  checks_passed: count,
  checks_total: count,
}).strict().refine((value) => value.guidelines_passed <= value.guidelines_total &&
  value.checks_passed <= value.checks_total, 'Passed counts exceed totals.');
const runSchema = z.object({
  selection_index: count,
  selection: selectionSchema,
  run_id: campaignRunIdSchema.nullable(),
  state: z.enum(['pending', 'completed', 'errored']),
  error_code: campaignErrorCodeSchema.nullable(),
  attempt_count: count.max(10_000),
  result_path: z.string().max(160).nullable(),
  evaluation: evaluationSchema.nullable(),
}).strict().superRefine((run, context) => {
  const pending = run.state === 'pending';
  const completed = run.state === 'completed';
  if ((pending !== (run.run_id === null)) || (pending !== (run.attempt_count === 0)) ||
      (pending && run.result_path !== null) ||
      (completed !== (run.evaluation !== null)) ||
      ((run.state === 'errored') !== (run.error_code !== null)) ||
      (completed && run.result_path === null) ||
      (run.result_path !== null && run.result_path !== `runs/${run.run_id}/result.json`)) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Run identity, state and result metadata disagree.'});
  }
});
const statisticsSchema = z.object({
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
  guideline_score: z.object({mean: ratio.nullable(), evaluations: count}).strict(),
}).strict();
const coordinates = z.object({
  case_id: z.string().min(1).max(4096),
  treatment: z.string().min(1).max(4096),
  agent: z.object({
    adapter: z.string().min(1).max(4096),
    provider: z.string().min(1).max(4096),
    model: z.string().min(1).max(4096),
    hook_trust: z.enum(['native', 'automation']).optional(),
  }).strict(),
}).strict();
const caseSchema = coordinates.merge(statisticsSchema);
const reportSchema = z.object({
  schema_version: z.literal(CAMPAIGN_REPORT_SCHEMA_VERSION),
  experiment_run_id: campaignRunIdSchema,
  generated_at: z.string().datetime(),
  checkpoint_sha256: digest,
  summary: statisticsSchema,
  cases: z.array(caseSchema).min(1).max(100_000),
  runs: z.array(runSchema).min(1).max(100_000),
}).strict();

export type CampaignReportEvaluationV1 = z.infer<typeof evaluationSchema>;
export type CampaignReportRunV1 = z.infer<typeof runSchema>;
export type CampaignReportStatisticsV1 = z.infer<typeof statisticsSchema>;
export type CampaignReportCaseV1 = z.infer<typeof caseSchema>;
export type CampaignReportV1 = z.infer<typeof reportSchema>;

/** Parse the versioned scorecard and verify every aggregate against its run rows. */
export function parseCampaignReport(input: unknown): CampaignReportV1 {
  const report = reportSchema.parse(input);
  if (report.runs.some((run, index) => run.selection_index !== index)) {
    throw new Error('Report selection indices must be contiguous and zero-based.');
  }
  const runIds = report.runs.flatMap((run) => run.run_id === null ? [] : [run.run_id]);
  if (new Set(runIds).size !== runIds.length) throw new Error('Report contains duplicate run IDs.');
  const aggregate = aggregateRuns(report.runs);
  if (serializeCanonicalJson(report.summary) !== serializeCanonicalJson(aggregate.summary) ||
      serializeCanonicalJson(report.cases) !== serializeCanonicalJson(aggregate.cases)) {
    throw new Error('Report statistics do not match its run rows.');
  }
  assertReportBytes(serializeCanonicalJson(report));
  return report;
}

/** Internal construction from bounded, verified latest-selection metadata. */
export function buildCampaignReport(input: {
  experimentRunId: string;
  generatedAt: string;
  checkpointBody: string;
  runs: CampaignReportRunV1[];
}): CampaignReportV1 {
  return parseCampaignReport({
    schema_version: CAMPAIGN_REPORT_SCHEMA_VERSION,
    experiment_run_id: input.experimentRunId,
    generated_at: input.generatedAt,
    checkpoint_sha256: sha256Digest(input.checkpointBody),
    ...aggregateRuns(input.runs),
    runs: input.runs,
  });
}

/** Human-readable JSON with deterministic key and selection order. */
export function serializeCampaignReport(report: CampaignReportV1): string {
  const body = `${JSON.stringify(JSON.parse(serializeCanonicalJson(report)), null, 2)}\n`;
  assertReportBytes(body);
  return body;
}

function assertReportBytes(body: string): void {
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw new Error('Campaign report exceeds its byte limit.');
}

function aggregateRuns(runs: CampaignReportRunV1[]): {
  summary: CampaignReportStatisticsV1;
  cases: CampaignReportCaseV1[];
} {
  const groups = new Map<string, {coordinates: z.infer<typeof coordinates>; runs: CampaignReportRunV1[]}>();
  for (const run of runs) {
    const {case_id, treatment, agent} = run.selection;
    const selected = {case_id, treatment, agent};
    const key = serializeCanonicalJson(selected);
    let group = groups.get(key);
    if (group === undefined) {
      group = {coordinates: selected, runs: []};
      groups.set(key, group);
    }
    group.runs.push(run);
  }
  return {
    summary: statistics(runs),
    cases: [...groups.values()].map((group) => ({...group.coordinates, ...statistics(group.runs)})),
  };
}

function statistics(runs: CampaignReportRunV1[]): CampaignReportStatisticsV1 {
  let completed = 0;
  let errored = 0;
  let pending = 0;
  let passed = 0;
  let partial = 0;
  let failed = 0;
  let attempts = 0;
  let retries = 0;
  let guidelineSum = 0;
  let guidelineEvaluations = 0;
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
      if (evaluation.guidelines_total > 0) {
        guidelineSum += evaluation.score;
        guidelineEvaluations += 1;
      }
    }
  }
  return {
    selections: runs.length, completed, errored, pending, passed, partial, failed,
    attempts_total: attempts, retry_attempts: retries,
    coverage: runs.length === 0 ? null : completed / runs.length,
    pass_rate: completed === 0 ? null : passed / completed,
    guideline_score: {mean: guidelineEvaluations === 0 ? null : guidelineSum / guidelineEvaluations,
      evaluations: guidelineEvaluations},
  };
}
