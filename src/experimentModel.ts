import { z } from 'zod';
import { attemptTimestampSchema } from './diagnostics/timing.ts';

import { isSha256Digest } from './model/hashes.ts';
import { parseRunSelection } from './model/parse.ts';
import {
  assertCompatibleForgeVersion,
  parseForgeBuildIdentity,
} from './version.ts';

export const MAX_EXPERIMENT_RUN_BYTES = 16 * 1024 * 1024;
export const MAX_EXPERIMENT_LOCK_OWNER_BYTES = 128;
export const EXPERIMENT_LOCK_OWNER_NAME = /^owner-[0-9a-f-]{36}\.json$/;
export const experimentRunLockOwnerSchema = z
  .object({ pid: z.number().int().positive().max(2_147_483_647) })
  .strict();

export const experimentRunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const experimentRunErrorCodeSchema = z.enum([
  'execution_error',
  'invalid_artifacts',
  'role_player_error',
  'aborted',
  'agent_failed',
  'artifact_failed',
  'credential_failed',
  'evaluation_failed',
  'evidence_failed',
  'invalid_plan',
  'runtime_failed',
  'setup_failed',
  'unsupported_capability',
]);
export const experimentRunDiagnosticSchema = z
  .object({
    phase: z.enum([
      'preflight',
      'runtime_prepare',
      'setup',
      'interaction',
      'quiesce',
      'evidence',
      'evaluation',
      'artifact_stage',
      'runtime_dispose',
      'result_commit',
    ]),
    reason: z.enum(['failure', 'timeout', 'cancelled']),
    message: z.string().min(1).max(4096),
  })
  .strict();

export const attemptObservationFields = {
  reserved_at: attemptTimestampSchema.optional(),
  started_at: attemptTimestampSchema.optional(),
  finished_at: attemptTimestampSchema.optional(),
  diagnostics_status: z.enum(['available', 'unavailable']).optional(),
};

const attemptSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...attemptObservationFields,
      run_id: experimentRunIdSchema,
      state: z.literal('running'),
    })
    .strict(),
  z
    .object({
      ...attemptObservationFields,
      run_id: experimentRunIdSchema,
      state: z.literal('completed'),
    })
    .strict(),
  z
    .object({
      ...attemptObservationFields,
      run_id: experimentRunIdSchema,
      state: z.literal('errored'),
      error_code: experimentRunErrorCodeSchema,
      diagnostic: experimentRunDiagnosticSchema.optional(),
    })
    .strict(),
]);
const experimentRunCheckpointSchema = z
  .object({
    forge: z.unknown().transform(parseForgeBuildIdentity),
    experiment_run_id: experimentRunIdSchema,
    entries: z
      .array(
        z
          .object({
            selection: z.unknown().transform(parseRunSelection),
            plan_sha256: z.string().refine(isSha256Digest),
            attempts: z.array(attemptSchema).max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
  })
  .strict();

/** Check the producing release before interpreting checkpoint contents. */
export function parseExperimentRunCheckpoint(
  input: unknown,
): ExperimentRunCheckpoint {
  const header = z.object({ forge: z.unknown() }).passthrough().parse(input);
  const forge = parseForgeBuildIdentity(header.forge);
  assertCompatibleForgeVersion(forge.version);
  return experimentRunCheckpointSchema.parse(input);
}

export type ExperimentRunCheckpoint = z.infer<
  typeof experimentRunCheckpointSchema
>;
export type ExperimentRunAttempt = z.infer<typeof attemptSchema>;
export type SettledExperimentRunAttempt = Exclude<
  ExperimentRunAttempt,
  { state: 'running' }
>;
