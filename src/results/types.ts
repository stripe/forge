import type {
  AtifNormalizationCompleteness,
  AtifNormalizationWarning,
} from '../atif/index.js';
import type {RunSelection, Sha256Digest} from '../model/types.js';

export const RUN_RESULT_SCHEMA_VERSION = 1 as const;
export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_EVIDENCE_SCHEMA_VERSION = 1 as const;

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
  readonly evaluation: EvaluationResultV1;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly stop_reason: 'completed';
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
