import type {
  AtifNormalizationCompleteness,
  AtifNormalizationWarning,
} from '../atif/index.js';
import type {
  JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_SOURCE,
} from '../evaluation/judgeTranscript.js';
import type {
  ModelRefV1,
  JsonValue,
  RunSelection,
  Sha256Digest,
} from '../model/types.js';

export const RUN_RESULT_SCHEMA_VERSION = 1 as const;
export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const INTERACTION_SCHEMA_VERSION = 1 as const;
export const JUDGE_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type EvalStatus = 'passed' | 'partial' | 'failed';

export interface CheckResultV1 {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface GuidelineResultV1 {
  readonly guideline: string;
  readonly passed: boolean;
  readonly explanation: string;
}

export interface EvaluationResultV1 {
  readonly schema_version: typeof EVALUATION_SCHEMA_VERSION;
  readonly score: number;
  readonly status: EvalStatus;
  readonly guidelines_passed: number;
  readonly guidelines_total: number;
  readonly guidelines: readonly GuidelineResultV1[];
  readonly checks: readonly CheckResultV1[];
}

export interface WorkspaceEvidenceEntryV1 {
  readonly path: string;
  readonly exists: boolean;
  readonly kind: 'file' | 'directory' | 'other' | 'missing';
  readonly size_bytes?: number;
  readonly sha256?: Sha256Digest;
  /** Exact inspected bytes. Base64 avoids lossy UTF-8 decoding. */
  readonly content_base64?: string;
  readonly issue?: string;
}

export interface WorkspaceEvidenceV1 {
  readonly schema_version: typeof WORKSPACE_EVIDENCE_SCHEMA_VERSION;
  readonly entries: readonly WorkspaceEvidenceEntryV1[];
  readonly complete: boolean;
  readonly warnings: readonly {code: string; message: string; path?: string}[];
}

export type CompletionPurposeV1 = 'role_player' | 'judge';
export type CompletionStopReasonV1 =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded'
  | 'other';

export interface CompletionCallSummaryV1 {
  readonly sequence: number;
  readonly purpose: CompletionPurposeV1;
  readonly provider: string;
  readonly provider_version: string;
  readonly model: string;
  readonly status: 'succeeded' | 'failed';
  readonly stop_reason: CompletionStopReasonV1 | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly cost_usd: number | null;
  readonly error_code: string | null;
}

export interface InteractionToolCallV1 {
  readonly id?: string;
  readonly name: string;
  readonly input?: JsonValue;
}

export interface InteractionTurnV1 {
  readonly turn: number;
  readonly user: string;
  readonly assistant: string;
  readonly tool_calls: readonly InteractionToolCallV1[];
}

export interface AvaNeedV1 {
  readonly id: string;
  readonly description: string;
}

export interface RolePlayerErrorV1 {
  readonly status: 'role_player_error';
  readonly error_type: 'parse_error' | 'request_error';
  readonly attempts: number;
  readonly explanation: string;
}

export interface AvaDecisionV1 {
  readonly sequence: number;
  readonly after_agent_turn: number | null;
  readonly message: string;
  readonly stop: boolean;
  readonly remaining_need_ids: readonly string[] | null;
  readonly focus_need_id: string | null;
  readonly coding_agent_invoked: boolean;
  readonly source: 'configured_initial_prompt' | 'generated';
  readonly error?: RolePlayerErrorV1;
}

export interface InteractionArtifactV1 {
  readonly schema_version: typeof INTERACTION_SCHEMA_VERSION;
  readonly mode: 'multi_turn' | 'one_shot';
  readonly stop_reason: RunStopReasonV1;
  readonly turns: readonly InteractionTurnV1[];
  readonly role_player?: {
    readonly model: ModelRefV1;
    readonly prompt_version: string;
    readonly needs: readonly AvaNeedV1[] | null;
    readonly decisions: readonly AvaDecisionV1[];
  };
  readonly failure: RolePlayerErrorV1 | null;
}

export interface JudgeWorkspaceEntryV1 {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface JudgeEvidenceV1 {
  readonly schema_version: typeof JUDGE_EVIDENCE_SCHEMA_VERSION;
  readonly prompt_version: string;
  readonly trajectory_sha256: Sha256Digest;
  readonly transcript: {
    readonly source: typeof JUDGE_TRANSCRIPT_SOURCE;
    readonly projection_id: typeof JUDGE_TRANSCRIPT_PROJECTION_ID;
    readonly projection_version: typeof JUDGE_TRANSCRIPT_PROJECTION_VERSION;
    readonly excluded_fields: typeof JUDGE_TRANSCRIPT_EXCLUDED_FIELDS;
    readonly sha256: Sha256Digest;
  };
  readonly workspace: {
    readonly entries: readonly JudgeWorkspaceEntryV1[];
    readonly complete: boolean;
    readonly warnings: readonly {
      readonly code: string;
      readonly message: string;
      readonly path?: string;
    }[];
  };
}

export interface ArtifactDescriptorV1 {
  readonly path: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly sha256: Sha256Digest;
}

export interface RunWarningV1 {
  readonly code: string;
  readonly message: string;
}

export type RunStopReasonV1 =
  | 'task_complete'
  | 'max_turns'
  | 'role_player_error';

export type AtifEvidenceSourceV1 =
  | {
      readonly kind: 'native_log';
      readonly format: string;
      readonly session_id?: string;
    }
  | {
      readonly kind: 'atif';
      readonly format: 'atif';
      readonly schema_version: string;
      readonly session_id?: string;
    }
  | {
      readonly kind: 'driver_fallback';
      readonly format: 'forge-driver-turns';
      readonly session_id?: string;
    }
  | {
      readonly kind: 'role_player_error';
      readonly format: 'forge-system-event';
    };

export interface AtifEvidenceProvenanceV1 {
  readonly source: AtifEvidenceSourceV1;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
  };
}

export interface RunEvidenceV1 {
  readonly format: 'atif';
  readonly schema_version: 'ATIF-v1.8';
  readonly normalization_version: 1;
  readonly provenance: AtifEvidenceProvenanceV1;
  readonly completeness: AtifNormalizationCompleteness;
  readonly warnings: readonly AtifNormalizationWarning[];
  readonly redaction_count: number;
}

interface RunResultCommon {
  readonly run_id: string;
  readonly selection: RunSelection;
  readonly plan_sha256: Sha256Digest;
  readonly forge: {version: string};
  readonly runtime: {
    adapter: string;
    runtime_id: string;
    platform: string;
    metadata: Readonly<Record<string, string>>;
  };
  readonly agent: {
    adapter: string;
    adapter_version: string;
    provider: string;
    model: string;
    session_id: string | null;
    cost_usd: number | null;
  };
  readonly completion_calls: readonly CompletionCallSummaryV1[];
  readonly interaction: {
    readonly mode: 'multi_turn' | 'one_shot';
    readonly turn_count: number;
  };
  readonly failure: RolePlayerErrorV1 | null;
  readonly evaluation: EvaluationResultV1;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly stop_reason: RunStopReasonV1;
  readonly artifact_set_sha256: Sha256Digest;
  readonly artifacts: readonly ArtifactDescriptorV1[];
  readonly supplemental_artifacts: readonly ArtifactDescriptorV1[];
  readonly warnings: readonly RunWarningV1[];
}

export interface RunResultV1 extends RunResultCommon {
  readonly schema_version: typeof RUN_RESULT_SCHEMA_VERSION;
  readonly evidence: RunEvidenceV1;
}

export type RunResult = RunResultV1;

export interface CompletedRunV1 {
  readonly runId: string;
  readonly location: string;
  readonly result: RunResultV1;
}

export type CompletedRun = CompletedRunV1;
