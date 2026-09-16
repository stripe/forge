import type {NormalizedTrajectory} from '../atif/index.js';
import type {AgentSelectionV1, ResolvedRunPlanV1} from '../model/types.js';
import type {RunInputProvider} from './inputs.js';
import type {EnvironmentSpecification} from './credentials.js';
import type {
  MutableWorkspace,
  ReadonlyWorkspace,
  RuntimeLogicalPaths,
  RuntimeStateDirectoryRequirement,
} from './runtime.js';
import type {CommandRunner} from './command.js';

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
  readonly plan: ResolvedRunPlanV1;
  readonly selection: AgentSelectionV1;
  readonly runtime: AgentPrepareRuntime;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

export interface AgentSessionContext {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV1;
  readonly selection: AgentSelectionV1;
  readonly runtime: AgentSessionRuntime;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

export interface AgentEvidenceContext {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV1;
  readonly selection: AgentSelectionV1;
  readonly runtime: AgentEvidenceRuntime;
  readonly sessionId: string;
  /** Ordered neutral transcript used only when native evidence is unavailable. */
  readonly fallbackTurns: readonly AgentEvidenceFallbackTurn[];
  readonly signal: AbortSignal;
}

export interface AgentEvidenceFallbackTurn {
  readonly user: string;
  readonly assistant: string;
  readonly toolCalls: readonly AgentToolCall[];
}

/** One coding-agent integration configured by the host composition. */
export interface AgentAdapter {
  readonly id: string;
  readonly version: string;
  /** Pure declaration used before credentials resolve or a runtime allocates. */
  requirements(selection: AgentSelectionV1): AgentRuntimeRequirements;
  /** Initialize adapter-owned state before authored setup executes. */
  prepare(context: AgentPrepareContext): Promise<void>;
  openSession(context: AgentSessionContext): Promise<AgentSession>;
  /** Read exact session evidence only after runtime mutation has stopped. */
  collectEvidence(context: AgentEvidenceContext): Promise<NormalizedTrajectory>;
}
