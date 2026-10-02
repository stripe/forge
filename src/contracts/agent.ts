import type {AgentSelectionV1, ResolvedRunPlanV2} from '../model/types.js';
import type {RunInputProvider} from './inputs.js';
import type {EnvironmentSpecification} from './credentials.js';
import type {
  MutableWorkspace,
  ReadonlyWorkspace,
  RuntimeLogicalPaths,
  RuntimeStateDirectoryRequirement,
} from './runtime.js';
import type {CommandRunner} from './command.js';
import type {AgentPluginInstaller} from './plugin.js';

export interface AgentToolCall {
  readonly id?: string;
  readonly name: string;
  readonly input?: unknown;
}

export interface AgentTurn {
  readonly text: string;
  readonly sessionId: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly costUsd?: number;
}

/** Coding-agent identity recorded in ATIF independently of adapter provenance. */
export interface AgentEvidenceIdentity {
  readonly name: string;
  readonly version: string;
}

/** Exact agent-native source bytes retained independently from normalization. */
export interface AgentNativeArtifact {
  /** Agent-native format identifier, such as `claude-code-jsonl`. */
  readonly format: string;
  /** Must identify the exact root session requested by AgentEvidenceContext. */
  readonly sessionId: string;
  readonly mediaType: string;
  /** Safe extension without a leading dot, such as `jsonl`. */
  readonly extension: string;
  /**
   * Unmodified source bytes. These may contain credentials or other sensitive
   * agent-visible data and are never score-bearing or supplied to a judge.
   */
  readonly body: Uint8Array;
}

export type AgentNativeEvidenceSource =
  | {
      readonly kind: 'native_log';
      readonly format: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: 'atif';
      readonly format: 'atif';
      readonly schemaVersion: string;
      readonly sessionId: string;
    };

export interface AgentNativeEvidenceAvailable {
  readonly kind: 'available';
  /**
   * JSON-shaped ATIF normalized by the adapter. Forge performs the
   * authoritative parse; malformed `available` data is a contract violation.
   */
  readonly trajectory: unknown;
  readonly source: AgentNativeEvidenceSource;
  /** Loss of optional native detail; completed-turn coverage is checked separately. */
  readonly warnings: readonly AgentNativeEvidenceWarning[];
}

export interface AgentNativeEvidenceWarning {
  /**
   * Omission of known optional detail only. An unknown event which could carry
   * conversation evidence must make the source unavailable as `source_incomplete`.
   */
  readonly code: 'unsupported_native_event' | 'value_omitted';
  readonly message: string;
  readonly path?: string;
}

export interface AgentNativeEvidenceUnavailable {
  readonly kind: 'unavailable';
  readonly reason: {
    readonly code:
      | 'source_unavailable'
      | 'source_invalid'
      | 'source_incomplete';
    readonly message: string;
  };
}

/** Native evidence candidate. The engine, never the adapter, selects fallback. */
export type AgentNativeEvidenceResult =
  | AgentNativeEvidenceAvailable
  | AgentNativeEvidenceUnavailable;

export interface AgentSession {
  send(message: string, options: {signal: AbortSignal}): Promise<AgentTurn>;
  sessionId(): string | undefined;
}

export interface AgentRuntimeRequirements {
  /** Executables which must already exist in the Forge-owned runtime image. */
  readonly executables: readonly string[];
  /** Plain values and opaque references; Forge assigns every credential agent scope. */
  readonly environment: EnvironmentSpecification;
  /** Logical state Forge must mount and expose after evidence sealing. */
  readonly stateDirectories: readonly RuntimeStateDirectoryRequirement[];
}

interface AgentMutableRuntimeBase {
  readonly runtimeId: string;
  readonly workspace: MutableWorkspace;
  readonly paths: RuntimeLogicalPaths;
  readonly stateDirectories: ReadonlyMap<string, MutableWorkspace>;
}

/** Narrow capabilities available while an adapter initializes before setup. */
export interface AgentPrepareRuntime extends AgentMutableRuntimeBase {
  readonly commands: Readonly<{
    /** Runs with explicit plain variables but no resolved credential values. */
    uncredentialed: CommandRunner;
  }>;
}

/** Narrow capabilities available while the selected agent interacts. */
export interface AgentSessionRuntime extends AgentMutableRuntimeBase {
  readonly commands: Readonly<{
    /** Runs with agent-scoped credentials, never setup-scoped credentials. */
    agent: CommandRunner;
  }>;
}

/** Sealed, read-only capabilities available to native evidence collection. */
export interface AgentEvidenceRuntime {
  readonly runtimeId: string;
  readonly workspace: ReadonlyWorkspace;
  readonly paths: RuntimeLogicalPaths;
  readonly stateDirectories: ReadonlyMap<string, ReadonlyWorkspace>;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AgentPrepareContext {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV2;
  readonly selection: AgentSelectionV1;
  readonly runtime: AgentPrepareRuntime;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

export interface AgentSessionContext {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV2;
  readonly selection: AgentSelectionV1;
  readonly runtime: AgentSessionRuntime;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

export interface AgentEvidenceContext {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV2;
  readonly selection: AgentSelectionV1;
  readonly runtime: AgentEvidenceRuntime;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

/** One coding-agent integration configured by the host composition. */
export interface AgentAdapter {
  readonly id: string;
  readonly version: string;
  /** Native realization for the public `forge/plugin` action, when supported. */
  readonly pluginInstaller?: AgentPluginInstaller;
  /** Pure declaration used before credentials resolve or a runtime allocates. */
  requirements(selection: AgentSelectionV1): AgentRuntimeRequirements;
  /** Pure coding-agent identity used when Forge must construct fallback ATIF. */
  evidenceIdentity(selection: AgentSelectionV1): AgentEvidenceIdentity;
  /** Initialize adapter-owned state before authored setup executes. */
  prepare(context: AgentPrepareContext): Promise<void>;
  openSession(context: AgentSessionContext): Promise<AgentSession>;
  /**
   * Read exact session evidence only after runtime mutation has stopped.
   * Completed-run provenance must identify `context.sessionId`.
   */
  collectEvidence(context: AgentEvidenceContext): Promise<AgentNativeEvidenceResult>;
  /**
   * Optionally retain the exact root-session source independently from its
   * normalized evidence. Forge assigns the final artifact path and treats the
   * returned bytes as restricted and unredacted.
   */
  collectNativeArtifact?(
    context: AgentEvidenceContext,
  ): Promise<AgentNativeArtifact | undefined>;
}
