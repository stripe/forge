import type {
  AgentSelectionV1,
  JsonObject,
  ResolvedRunPlanV2,
  SetupStepV1,
} from '../model/types.js';
import type {CommandRunner} from '../contracts/command.js';
import type {CredentialRequirement} from '../contracts/credentials.js';
import type {RunInputProvider} from '../contracts/inputs.js';
import type {AgentPluginInstaller} from '../contracts/plugin.js';
import type {
  MutableWorkspace,
  RuntimeLogicalPaths,
  RuntimeStateDirectoryRequirement,
} from '../contracts/runtime.js';

export type SetupCredentialRequirements = Readonly<
  Record<string, CredentialRequirement>
>;

/** Pure capability declarations contributed by one prepared setup step. */
export interface SetupStepRequirements {
  readonly executables?: readonly string[];
  readonly stateDirectories?: readonly RuntimeStateDirectoryRequirement[];
  /** Explicit non-secret values remain available to every runtime command scope. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Forge, rather than the handler, assigns concrete credential scopes. */
  readonly credentials?: Readonly<{
    readonly setup?: SetupCredentialRequirements;
    readonly agent?: SetupCredentialRequirements;
  }>;
}

/** Ambient-free selection data available during pure setup preflight. */
export interface SetupPreflightContext {
  readonly stepIndex: number;
  readonly selection: AgentSelectionV1;
  readonly runtime: ResolvedRunPlanV2['runtime'];
  /** Selected adapter's narrow native plugin mechanism, when available. */
  readonly pluginInstaller?: AgentPluginInstaller;
}

/** Runtime capabilities shared by all steps in one already-preflighted setup. */
export interface SetupApplyContext {
  readonly runId: string;
  readonly paths: RuntimeLogicalPaths;
  readonly workspace: MutableWorkspace;
  /** All state directories aggregated during pure setup preflight. */
  readonly stateDirectories: ReadonlyMap<string, MutableWorkspace>;
  /** Forge selects the least-privileged projection for each prepared step. */
  readonly commands: Readonly<{
    /** Explicit non-secret variables only. */
    readonly uncredentialed: CommandRunner;
    /** Project exactly the setup credentials selected by the executor. */
    setup(credentialEnvironmentNames: readonly string[]): CommandRunner;
  }>;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

/** Exact per-step context constructed by the engine during ordered application. */
export interface SetupExecutionContext
  extends Omit<SetupApplyContext, 'commands'> {
  readonly stepIndex: number;
  readonly selection: AgentSelectionV1;
  readonly runtime: ResolvedRunPlanV2['runtime'];
  /** Contains only state directories declared by this prepared step. */
  readonly stateDirectories: ReadonlyMap<string, MutableWorkspace>;
  /**
   * Uses the setup projection only when this step declared a setup credential;
   * that projection contains exactly this step's declarations. Otherwise it
   * contains explicit non-secret variables only.
   */
  readonly commands: CommandRunner;
}

/** One validated step bound to the exact operation selected during preflight. */
export interface PreparedSetupStep {
  readonly requirements: SetupStepRequirements;
  /** Optional bounded, non-sensitive resolution retained in the completed run. */
  apply(context: SetupExecutionContext): Promise<JsonObject | void>;
}

export interface AppliedSetupStep {
  readonly index: number;
  readonly uses: string;
  readonly resolution?: JsonObject;
}

/** Immutable audit record returned only after every setup step succeeds. */
export interface AppliedSetup {
  readonly steps: readonly AppliedSetupStep[];
}

export interface SetupStepHandler {
  readonly uses: string;
  /**
   * Pure validation and binding for exactly one named action. It must not
   * resolve credentials, inspect ambient state, allocate, run commands, or
   * mutate a workspace.
   */
  preflight(
    step: SetupStepV1,
    context: SetupPreflightContext,
  ): PreparedSetupStep;
}

/** All setup steps and requirements bound to one agent/runtime selection. */
export interface PreparedSetup {
  readonly requirements: SetupStepRequirements;
  /** Applies the preflighted operations in source order and stops on failure. */
  apply(context: SetupApplyContext): Promise<AppliedSetup>;
}

export interface SetupExecutor {
  /** Pure validation. Call it before resolving credentials or allocating. */
  preflight(
    steps: readonly SetupStepV1[],
    context: Omit<SetupPreflightContext, 'stepIndex'>,
  ): PreparedSetup;
}

export class UnsupportedSetupActionError extends Error {
  readonly code = 'unsupported_setup_action' as const;

  constructor(readonly uses: string, readonly stepIndex: number) {
    super(`No setup handler is registered for ${JSON.stringify(uses)} at index ${stepIndex}.`);
    this.name = 'UnsupportedSetupActionError';
  }
}

export class SetupActionError extends Error {
  readonly code = 'setup_action_failed' as const;

  constructor(
    readonly uses: string,
    readonly stepIndex: number,
    options?: ErrorOptions,
  ) {
    super(`Setup action ${JSON.stringify(uses)} failed at index ${stepIndex}.`, options);
    this.name = 'SetupActionError';
  }
}
