import type {
  AgentSelectionV1,
  ResolvedRunPlanV1,
  SetupStepV1,
} from '../model/types.js';
import type {CommandRunner} from '../contracts/command.js';
import type {CredentialRequirement} from '../contracts/credentials.js';
import type {RunInputProvider} from '../contracts/inputs.js';
import type {
  MutableWorkspace,
  RuntimeLogicalPaths,
} from '../contracts/runtime.js';

export type SetupCredentialRequirements = Readonly<
  Record<string, CredentialRequirement>
>;

/** Pure capability declarations contributed by one prepared setup step. */
export interface SetupStepRequirements {
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
  readonly runtime: ResolvedRunPlanV1['runtime'];
}

/** Runtime capabilities shared by all steps in one already-preflighted setup. */
export interface SetupApplyContext {
  readonly runId: string;
  readonly paths: RuntimeLogicalPaths;
  readonly workspace: MutableWorkspace;
  /** Forge selects the least-privileged projection for each prepared step. */
  readonly commands: Readonly<{
    /** Explicit non-secret variables only. */
    readonly uncredentialed: CommandRunner;
    /** Explicit variables plus all setup-scoped credentials. */
    readonly setup: CommandRunner;
  }>;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

/** Exact per-step context constructed by the engine during ordered application. */
export interface SetupExecutionContext
  extends Omit<SetupApplyContext, 'commands'> {
  readonly stepIndex: number;
  readonly selection: AgentSelectionV1;
  readonly runtime: ResolvedRunPlanV1['runtime'];
  /**
   * Uses the setup projection only when this step declared a setup credential;
   * otherwise it contains explicit non-secret variables only.
   */
  readonly commands: CommandRunner;
}

/** One validated step bound to the exact operation selected during preflight. */
export interface PreparedSetupStep {
  readonly requirements: SetupStepRequirements;
  apply(context: SetupExecutionContext): Promise<void>;
}

export interface SetupStepHandler {
  readonly uses: string;
  /**
   * Pure validation and binding for exactly one versioned action. It must not
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
  apply(context: SetupApplyContext): Promise<void>;
}

export interface SetupExecutor {
  /** Pure validation. Call it before resolving credentials or allocating. */
  preflight(
    steps: readonly SetupStepV1[],
    context: Omit<SetupPreflightContext, 'stepIndex'>,
  ): PreparedSetup;
}

/** @deprecated Use SetupExecutionContext. */
export type SetupContext = SetupExecutionContext;

/** @deprecated Use SetupStepHandler. */
export type SetupActionHandler = SetupStepHandler;

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
