import type {
  AtifNormalizationCompleteness,
  AtifNormalizationWarning,
} from '../atif/index.ts';
import type {
  AgentMcpToolRefusals,
  AgentTokenUsage,
  AgentToolCall,
} from '../contracts/agent.ts';
import type { CompletionProviderErrorCode } from '../contracts/completionObservation.ts';
import type {
  AgentAdapterMetadata,
  CompletionProviderMetadata,
} from '../contracts/metadata.ts';
import type { AgentPluginInstallationReceipt } from '../contracts/plugin.ts';
import type { CriterionDecisionV1 } from '../evaluation/criterionDecision.ts';
import type { DecisionRejectionReason } from '../evaluation/decision.ts';
import type {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  JudgeTranscriptProjectionV1,
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

export interface CriterionEvidenceWarningV1 {
  readonly source: 'trajectory' | 'workspace';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type CriterionResultV1 = {
  readonly label?: string;
  /** Always present after parsing; omitted input defaults to SHOULD. */
  readonly requirement_level: RequirementLevelV1;
  readonly criterion: string;
  readonly explanation: string;
  readonly evidence_warnings_ref?: 'evaluation';
} & (
  | {
      readonly passed: boolean;
      readonly decision?: CriterionDecisionV1 | undefined;
      readonly error?: never;
    }
  | {
      readonly passed: null;
      readonly decision?: never;
      readonly error: {
        readonly type: 'parse_error' | 'request_error';
        readonly reason?: DecisionRejectionReason | undefined;
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
  readonly evidence_warnings?: readonly CriterionEvidenceWarningV1[];
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

export const MAX_COMPLETION_CALL_SUMMARIES = 1024;

export interface CompletionCallTotalsV1 {
  readonly calls: number;
  readonly failed: number;
  readonly omitted: number;
  readonly rate_limit_wait_ms: number;
}

export interface CompletionSubattemptRecordV1 {
  readonly http_status?: number;
  readonly request_id?: string;
  readonly provider_error_code?: CompletionProviderErrorCode;
  readonly retry_ordinal?: number;
  readonly retry_wait_ms?: number;
  readonly disposition?:
    | 'succeeded'
    | 'failed'
    | 'retry'
    | 'rate_limit_retry'
    | 'exhausted';
}

export interface CompletionCallSummaryV1 extends CompletionSubattemptRecordV1 {
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
  readonly result?: NonNullable<AgentToolCall['result']>;
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
  /** Fixed at initialization; absent from older interaction artifacts. */
  readonly acceptance?: string;
}

export interface RolePlayerErrorV1 {
  /** Bounded final rejection reason, with resolved credentials redacted. */
  readonly message?: string;
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
    /** False when any warning or bound leaves evidence incomplete. */
    readonly complete: boolean;
    /**
     * Any collection or rendering bound was hit, including per-file text limits.
     * Omissions or read failures alone set complete false without setting this true.
     * Older artifacts may omit this field; absence does not mean false.
     */
    readonly truncated?: boolean;
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
  /** Content-free count or unavailable state on an MCP refusal warning. */
  readonly mcp_tool_refusals?: AgentMcpToolRefusals;
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

/** Bounded host search totals; null means unavailable, not zero spend.
 * Future price estimation can consume these independently of scoring.
 */
export interface WebSearchUsageV1 {
  readonly tool_calls: number | null;
  readonly search_count: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
}

interface RunResultCommon {
  readonly web_search?: {
    readonly provider: 'forge/web-search';
    readonly native_search: 'disabled';
    readonly usage: WebSearchUsageV1;
  };
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
    usage?: AgentTokenUsage;
  };
  /** Built-in plugin receipts in setup order; absence means not recorded. */
  readonly plugin_installations?: readonly AgentPluginInstallationReceipt[];
  readonly completion_calls: readonly CompletionCallSummaryV1[];
  readonly completion_call_totals?: CompletionCallTotalsV1;
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
