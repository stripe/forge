import { z } from 'zod';
import {
  experimentRunDiagnosticSchema,
  experimentRunErrorCodeSchema,
  experimentRunIdSchema,
} from '../experimentModel.ts';
import { parseRunSelection } from '../model/parse.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import { resolvedRunPlanSha256 } from '../planning/planner.ts';
import { completionCallSummarySchema } from '../results/parse.ts';
import type {
  CompletionCallSummaryV1,
  CompletionSubattemptRecordV1,
} from '../results/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  assertCompatibleForgeVersion,
  FORGE_BUILD_IDENTITY,
  parseForgeBuildIdentity,
} from '../version.ts';
import { attemptTimingSchema } from './timing.ts';

export const MAX_ATTEMPT_DIAGNOSTICS_BYTES = 512 * 1024;
export const MAX_ATTEMPT_COMPLETION_SUMMARIES = 256;
export const MAX_ATTEMPT_COMPLETION_BYTES = 128 * 1024;
const count = z.number().int().nonnegative().safe();
export const attemptDiagnosticsIdentitySchema = z
  .object({
    run_id: experimentRunIdSchema,
    experiment_run_id: experimentRunIdSchema.optional(),
    selection: z.unknown().transform(parseRunSelection),
    plan_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    forge: z.unknown().transform(parseForgeBuildIdentity),
  })
  .strict();
const completionSchema = completionCallSummarySchema.pick({
  sequence: true,
  provider: true,
  provider_version: true,
  model: true,
  purpose: true,
  status: true,
  http_status: true,
  request_id: true,
  provider_error_code: true,
  retry_ordinal: true,
  retry_wait_ms: true,
  disposition: true,
});
const recordSchema = z
  .object({
    schema_version: z.literal('forge-attempt-v1'),
    identity: attemptDiagnosticsIdentitySchema,
    revision: count.positive(),
    state: z.enum(['reserved', 'running', 'completed', 'errored']),
    timing: attemptTimingSchema,
    location: z
      .object({ phase: experimentRunDiagnosticSchema.shape.phase })
      .strict()
      .optional(),
    primary_failure: experimentRunDiagnosticSchema
      .extend({ error_code: experimentRunErrorCodeSchema })
      .optional(),
    cleanup_failures: z
      .array(z.enum(['rollback_failed', 'runtime_dispose_failed']))
      .max(2),
    capture: z
      .object({
        policy: z.literal('structured-v1'),
        process: z.literal('unsupported'),
        protocol: z.literal('unsupported'),
        restricted: z.literal('disabled'),
      })
      .strict(),
    completion_calls: z
      .array(completionSchema)
      .max(MAX_ATTEMPT_COMPLETION_SUMMARIES),
    completion_call_totals: z
      .object({
        calls: count,
        failed: count,
        omitted: count,
        rate_limit_wait_ms: count,
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    const terminal = record.state === 'completed' || record.state === 'errored';
    if (
      terminal !== (record.timing.finished_at !== undefined) ||
      (record.state === 'running' && record.timing.started_at === undefined) ||
      (record.state === 'reserved' && record.timing.started_at !== undefined) ||
      (record.state === 'completed' &&
        record.timing.started_at === undefined) ||
      (record.state === 'errored' && record.primary_failure === undefined) ||
      (record.state === 'completed' && record.primary_failure !== undefined) ||
      (record.primary_failure !== undefined &&
        record.timing.failure_observed_at === undefined) ||
      record.completion_call_totals.calls !==
        record.completion_calls.length +
          record.completion_call_totals.omitted ||
      record.completion_call_totals.failed >
        record.completion_call_totals.calls ||
      Buffer.byteLength(serializeCanonicalJson(record.completion_calls)) >
        MAX_ATTEMPT_COMPLETION_BYTES ||
      new Set(record.completion_calls.map(({ sequence }) => sequence)).size !==
        record.completion_calls.length ||
      record.completion_calls.some(
        ({ sequence }) => sequence > record.completion_call_totals.calls,
      ) ||
      ['failure_observed', 'cleanup_completed', 'finished'].some((event) => {
        const timing = record.timing as Record<string, unknown>;
        return (
          (timing[`${event}_at`] === undefined &&
            timing[`${event}_elapsed_ms`] !== undefined) ||
          (record.timing.started_at !== undefined &&
            (timing[`${event}_at`] === undefined) !==
              (timing[`${event}_elapsed_ms`] === undefined))
        );
      })
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Attempt state, timing or counts disagree.',
      });
    }
  });
export type AttemptDiagnosticsIdentity = z.infer<
  typeof attemptDiagnosticsIdentitySchema
>;
export type AttemptDiagnosticsRecord = z.infer<typeof recordSchema>;
export type AttemptDiagnosticsSnapshot = Omit<
  AttemptDiagnosticsRecord,
  'revision'
>;
export interface AttemptCompletionSummary
  extends CompletionSubattemptRecordV1,
    Pick<
      CompletionCallSummaryV1,
      | 'sequence'
      | 'purpose'
      | 'status'
      | 'provider'
      | 'provider_version'
      | 'model'
    > {}

export function parseAttemptDiagnostics(
  input: unknown,
): AttemptDiagnosticsRecord {
  const header = z
    .object({ identity: z.object({ forge: z.unknown() }) })
    .passthrough()
    .parse(input);
  assertCompatibleForgeVersion(
    parseForgeBuildIdentity(header.identity.forge).version,
  );
  if (
    Buffer.byteLength(serializeCanonicalJson(input)) >
    MAX_ATTEMPT_DIAGNOSTICS_BYTES
  )
    throw new Error('Attempt diagnostics exceed the byte limit.');
  return recordSchema.parse(input);
}
export function serializeAttemptDiagnostics(
  record: AttemptDiagnosticsRecord,
): string {
  return serializeCanonicalJson(parseAttemptDiagnostics(record));
}
export function attemptDiagnosticsIdentity(
  runId: string,
  plan: ResolvedRunPlanV1,
  experimentRunId?: string,
): AttemptDiagnosticsIdentity {
  return attemptDiagnosticsIdentitySchema.parse({
    run_id: runId,
    ...(experimentRunId === undefined
      ? {}
      : { experiment_run_id: experimentRunId }),
    selection: plan.selection,
    plan_sha256: resolvedRunPlanSha256(plan),
    forge: FORGE_BUILD_IDENTITY,
  });
}
/** A readable diagnostic record belongs to a different attempt. */
export class AttemptDiagnosticsIdentityError extends Error {
  constructor() {
    super(
      'Attempt diagnostic identity does not match the selected run and plan.',
    );
    this.name = 'AttemptDiagnosticsIdentityError';
  }
}

export function assertAttemptDiagnosticsIdentity(
  actual: AttemptDiagnosticsIdentity,
  expected: AttemptDiagnosticsIdentity,
): void {
  if (serializeCanonicalJson(actual) !== serializeCanonicalJson(expected))
    throw new AttemptDiagnosticsIdentityError();
}
export function reservedAttemptDiagnostics(
  identity: AttemptDiagnosticsIdentity,
  reservedAt: string,
): AttemptDiagnosticsSnapshot {
  return {
    schema_version: 'forge-attempt-v1',
    identity,
    state: 'reserved',
    timing: { reserved_at: reservedAt },
    cleanup_failures: [],
    capture: {
      policy: 'structured-v1',
      process: 'unsupported',
      protocol: 'unsupported',
      restricted: 'disabled',
    },
    completion_calls: [],
    completion_call_totals: {
      calls: 0,
      failed: 0,
      omitted: 0,
      rate_limit_wait_ms: 0,
    },
  };
}
