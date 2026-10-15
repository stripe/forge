/**
 * ATIF-v1.8 wire types.
 *
 * Field names intentionally match the upstream JSON format. Runtime callers
 * must still use parseAtifTrajectory(): TypeScript types alone do not enforce
 * the cross-field and recursive invariants in the ATIF specification. Nullable
 * optional fields preserve explicit JSON null rather than treating it as an
 * unknown value.
 */

export const ATIF_SCHEMA_VERSION = 'ATIF-v1.8' as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type AtifImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export type AtifAudioMediaType =
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/mp4'
  | 'audio/aac'
  | 'audio/ogg'
  | 'audio/flac'
  | 'audio/webm'
  | 'audio/aiff';

export interface AtifImageSource {
  media_type: AtifImageMediaType;
  path: string;
}

export interface AtifAudioSource {
  media_type: AtifAudioMediaType;
  path: string;
  duration_sec?: number | null;
}

export interface AtifTextContentPart {
  type: 'text';
  text: string;
  source?: never;
}

export interface AtifImageContentPart {
  type: 'image';
  source: AtifImageSource;
  text?: never;
}

export interface AtifAudioContentPart {
  type: 'audio';
  source: AtifAudioSource;
  text?: never;
}

export type AtifContentPart =
  | AtifTextContentPart
  | AtifImageContentPart
  | AtifAudioContentPart;

export type AtifContent = string | AtifContentPart[];

export interface AtifAgent {
  name: string;
  version: string;
  model_name?: string | null;
  tool_definitions?: JsonObject[] | null;
  extra?: JsonObject | null;
}

export interface AtifMetrics {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
  prompt_token_ids?: number[] | null;
  completion_token_ids?: number[] | null;
  logprobs?: number[] | null;
  extra?: JsonObject | null;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number | null;
  total_completion_tokens?: number | null;
  total_cached_tokens?: number | null;
  total_cost_usd?: number | null;
  total_steps?: number | null;
  extra?: JsonObject | null;
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: JsonObject;
  extra?: JsonObject | null;
}

interface AtifSubagentTrajectoryRefCommon {
  /** Run-scoped metadata only; never use this value to resolve the reference. */
  session_id?: string | null;
  extra?: JsonObject | null;
}

/** A subagent reference must have at least one real resolution mechanism. */
export type AtifSubagentTrajectoryRef = AtifSubagentTrajectoryRefCommon &
  (
    | { trajectory_id: string; trajectory_path?: string | null }
    | { trajectory_id?: string | null; trajectory_path: string }
  );

export interface AtifObservationResult {
  source_call_id?: string | null;
  content?: AtifContent | null;
  subagent_trajectory_ref?: AtifSubagentTrajectoryRef[] | null;
  extra?: JsonObject | null;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

interface AtifStepCommon {
  step_id: number;
  timestamp?: string | null;
  message: AtifContent;
  is_copied_context?: boolean | null;
  llm_call_count?: number | null;
  extra?: JsonObject | null;
}

export interface AtifSystemStep extends AtifStepCommon {
  source: 'system';
  observation?: AtifObservation | null;
  model_name?: null;
  reasoning_effort?: null;
  reasoning_content?: null;
  tool_calls?: null;
  metrics?: null;
}

export interface AtifUserStep extends AtifStepCommon {
  source: 'user';
  observation?: null;
  model_name?: null;
  reasoning_effort?: null;
  reasoning_content?: null;
  tool_calls?: null;
  metrics?: null;
}

export interface AtifAgentStep extends AtifStepCommon {
  source: 'agent';
  model_name?: string | null;
  reasoning_effort?: string | number | null;
  reasoning_content?: string | null;
  tool_calls?: AtifToolCall[] | null;
  observation?: AtifObservation | null;
  metrics?: AtifMetrics | null;
}

export type AtifStep = AtifSystemStep | AtifUserStep | AtifAgentStep;

export interface AtifTrajectoryV1_8 {
  schema_version: typeof ATIF_SCHEMA_VERSION;
  /** Run-scoped identity. Multiple trajectory documents may share it. */
  session_id?: string | null;
  /** Per-document identity. Required for an embedded subagent trajectory. */
  trajectory_id?: string | null;
  agent: AtifAgent;
  steps: AtifStep[];
  notes?: string | null;
  final_metrics?: AtifFinalMetrics | null;
  continued_trajectory_ref?: string | null;
  extra?: JsonObject | null;
  subagent_trajectories?: AtifEmbeddedTrajectoryV1_8[] | null;
}

export interface AtifEmbeddedTrajectoryV1_8 extends AtifTrajectoryV1_8 {
  trajectory_id: string;
}

/** Alias for Forge's one canonical ATIF wire version. */
export type AtifTrajectory = AtifTrajectoryV1_8;
