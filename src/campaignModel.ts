import {z} from 'zod';

import {isSha256Digest} from './model/hashes.js';
import {parseRunSelection} from './model/parse.js';

export const campaignRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const campaignErrorCodeSchema = z.enum([
  'execution_error', 'invalid_artifacts', 'role_player_error',
  'aborted', 'agent_failed', 'artifact_failed', 'credential_failed',
  'evaluation_failed', 'evidence_failed', 'invalid_plan', 'runtime_failed',
  'setup_failed', 'unsupported_capability',
]);
const attemptSchema = z.discriminatedUnion('state', [
  z.object({run_id: campaignRunIdSchema, state: z.literal('running')}).strict(),
  z.object({run_id: campaignRunIdSchema, state: z.literal('completed')}).strict(),
  z.object({
    run_id: campaignRunIdSchema,
    state: z.literal('errored'),
    error_code: campaignErrorCodeSchema,
  }).strict(),
]);
export const campaignSchema = z.object({
  schema_version: z.literal(1),
  experiment_run_id: campaignRunIdSchema,
  entries: z.array(z.object({
    selection: z.unknown().transform(parseRunSelection),
    plan_sha256: z.string().refine(isSha256Digest),
    attempts: z.array(attemptSchema).max(10_000),
  }).strict()).min(1).max(100_000),
}).strict();

export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignAttempt = z.infer<typeof attemptSchema>;
export type SettledCampaignAttempt = Exclude<CampaignAttempt, {state: 'running'}>;
