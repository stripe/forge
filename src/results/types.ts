import type {
  AtifNormalizationCompleteness,
  AtifNormalizationWarning,
} from '../atif/index.ts';
import type {
  AgentAdapterMetadata,
  CompletionProviderMetadata,
} from '../contracts/metadata.ts';
import type {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  JudgeVisibleStepV1,
} from '../evaluation/judgeTranscript.ts';
import type {
  JsonObject,
  JsonValue,
  ModelRefV1,
  RequirementLevelV1,
  RunSelection,
  SetupActionBundleReferenceV1,
  Sha256Digest,
} from '../model/types.ts';
import type { ForgeBuildIdentity } from '../version.ts';

export const MAX_SETUP_ARTIFACT_BYTES = 2 * 1024 * 1024;

/** Producer release for a companion artifact interpreted by this package. */
export interface ForgeArtifactParseContext {
  readonly forgeVersion: string;
}

export type EvalStatus = 'passed' | 'partial' | 'failed' | 'judge_error';

export interface CheckResultV1 {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export type CriterionResultV1 = {
  readonly label?: string;
  /** Always present after parsing; omitted input defaults to SHOULD. */
  readonly requirement_level: RequirementLevelV1;
  readonly criterion: string;
  readonly explanation: string;
} & (
  | { readonly passed: boolean; readonly error?: never }
  | {
      readonly passed: null;
      readonly error: {
        readonly type: 'parse_error' | 'request_error';
        readonly attempts: number;
        /** Bounded diagnostic; request messages redact resolved credentials. */
        readonly message: string;
      };
    }
);

export interface EvaluationResultV1 {
  /** Null when included criteria exist but none received a valid judgment. */
  readonly score: number | null;
  readonly status: EvalStatus;
  readonly judging_criteria_passed: number;
  readonly judging_criteria_total: number;
  readonly judging_criteria_errored: number;
  readonly judging_criteria: readonly CriterionResultV1[];
  readonly checks: readonly CheckResultV1[];
}

export interface WorkspaceEvidenceEntryV1 {
  readonly path: string;
  readonly exists: boolean;
  readonly kind: 'file' | 'directory' | 'other' | 'missing';
  readonly size_bytes?: number;
  /** Exact inspected bytes. Base64 avoids lossy UTF-8 decoding. */
  readonly content_base64?: string;
  readonly issue?: string;
}

export interface WorkspaceEvidenceV1 {
  readonly entries: readonly WorkspaceEvidenceEntryV1[];
  readonly complete: boolean;
  readonly warnings: readonly {
    code: string;
    message: string;
    path?: string;
  }[];
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
  readonly provider_metadata?: CompletionProviderMetadata;
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
  readonly mode: 'multi_turn' | 'one_shot';
  readonly stop_reason: RunStopReasonV1;
  readonly turns: readonly InteractionTurnV1[];
  readonly role_player?: {
    readonly model: ModelRefV1;
    readonly needs: readonly AvaNeedV1[] | null;
    readonly decisions: readonly AvaDecisionV1[];
  };
  readonly failure: RolePlayerErrorV1 | null;
}

export interface SetupArtifactStepV1 {
  readonly index: number;
  readonly uses: string;
  readonly resolution?: JsonObject;
}

/** Ordered audit of the exact setup operations and execution-time resolutions. */
export interface SetupArtifactV1 {
  readonly steps: readonly SetupArtifactStepV1[];
}

export interface JudgeWorkspaceEntryV1 {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

/** Judge audit with the exact reduced transcript supplied to every criterion. */
export interface JudgeEvidenceV1 {
  readonly transcript: {
    readonly source: typeof JUDGE_TRANSCRIPT_SOURCE;
    readonly projection_id: typeof JUDGE_TRANSCRIPT_PROJECTION_ID;
    readonly trajectory_scope: typeof JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE;
    readonly included_step_sources: typeof JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES;
    readonly copied_context: typeof JUDGE_TRANSCRIPT_COPIED_CONTEXT;
    readonly included_fields: typeof JUDGE_TRANSCRIPT_INCLUDED_FIELDS;
    /** Canonical serialization of these steps is the judge's transcript input. */
    readonly steps: readonly JudgeVisibleStepV1[];
    /** Present only when driver evidence exceeds the whole-prompt budget. */
    readonly omitted?: 'judge_budget_exceeded';
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
  /** Present only for artifacts which may contain unredacted sensitive data. */
  readonly sensitivity?: 'restricted';
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
  readonly provenance: AtifEvidenceProvenanceV1;
  readonly completeness: AtifNormalizationCompleteness;
  readonly warnings: readonly AtifNormalizationWarning[];
  readonly redaction_count: number;
}

interface RunResultCommon {
  readonly run_id: string;
  readonly selection: RunSelection;
  readonly forge: ForgeBuildIdentity & {
    readonly action_bundles?: readonly SetupActionBundleReferenceV1[];
  };
  readonly runtime: {
    adapter: string;
    runtime_id: string;
    platform: string;
    metadata: Readonly<Record<string, string>>;
  };
  readonly agent: {
    adapter: string;
    adapter_version: string;
    metadata?: AgentAdapterMetadata;
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
  readonly artifacts: readonly ArtifactDescriptorV1[];
  readonly supplemental_artifacts: readonly ArtifactDescriptorV1[];
  readonly warnings: readonly RunWarningV1[];
}

export interface RunResultV1 extends RunResultCommon {
  readonly evidence: RunEvidenceV1;
}

export type RunResult = RunResultV1;

export interface CompletedRunV1 {
  readonly runId: string;
  readonly location: string;
  readonly result: RunResultV1;
}

export type CompletedRun = CompletedRunV1;
