import type {SetupStepV1} from '../model/types.js';
import type {CommandRunner} from '../contracts/command.js';
import type {EnvironmentSpecification} from '../contracts/credentials.js';
import type {RunInputProvider} from '../contracts/inputs.js';
import type {MutableWorkspace} from '../contracts/runtime.js';

export interface SetupContext {
  readonly runId: string;
  readonly workspace: MutableWorkspace;
  readonly commands: CommandRunner;
  readonly inputs: RunInputProvider;
  readonly signal: AbortSignal;
}

export interface SetupStepHandler {
  readonly uses: string;
  /** Pure declaration; Forge assigns every declared credential setup scope. */
  requirements?(step: SetupStepV1): EnvironmentSpecification;
  /** Domain-specific validation and mutation for exactly one versioned action. */
  execute(step: SetupStepV1, context: SetupContext): Promise<void>;
}

/** @deprecated Use SetupStepHandler. */
export type SetupActionHandler = SetupStepHandler;

export interface SetupExecutor {
  /** Pure validation; call it before resolving credentials or allocating. */
  preflight(steps: readonly SetupStepV1[]): void;
  /** Applies setup actions in source order and stops at the first failure. */
  apply(steps: readonly SetupStepV1[], context: SetupContext): Promise<void>;
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
