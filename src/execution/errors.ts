import type { RunPhase } from '../contracts/observability.ts';

export type ForgeExecutionErrorCode =
  | 'aborted'
  | 'agent_failed'
  | 'artifact_failed'
  | 'credential_failed'
  | 'evaluation_failed'
  | 'evidence_failed'
  | 'invalid_plan'
  | 'runtime_failed'
  | 'setup_failed'
  | 'unsupported_capability';

interface ExecutionDiagnostic {
  readonly reason: 'failure' | 'timeout' | 'cancelled';
  readonly message: string;
}

const executionDiagnostics = new WeakMap<
  ForgeExecutionError,
  ExecutionDiagnostic
>();

/** Stable, secret-safe failure surfaced by the shared execution lifecycle. */
export class ForgeExecutionError extends Error {
  /** Bounded, credential-redacted detail produced at the execution boundary. */
  get diagnostic(): ExecutionDiagnostic | undefined {
    return executionDiagnostics.get(this);
  }

  constructor(
    readonly code: ForgeExecutionErrorCode,
    readonly phase: RunPhase,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ForgeExecutionError';
  }
}

/** @internal Mint diagnostics only at the engine's execution boundary. */
export function createExecutionErrorWithDiagnostic(
  code: ForgeExecutionErrorCode,
  phase: RunPhase,
  message: string,
  options: ErrorOptions & { diagnostic: ExecutionDiagnostic },
): ForgeExecutionError {
  const error = new ForgeExecutionError(code, phase, message, options);
  executionDiagnostics.set(error, Object.freeze({ ...options.diagnostic }));
  return error;
}

/** @internal Ignore host-added properties and getters on an error. */
export function executionDiagnostic(
  error: ForgeExecutionError,
): ExecutionDiagnostic | undefined {
  return executionDiagnostics.get(error);
}

export function throwIfAborted(signal: AbortSignal, phase: RunPhase): void {
  if (!signal.aborted) return;
  throw new ForgeExecutionError(
    'aborted',
    phase,
    'The Forge run was aborted.',
    {
      cause: signal.reason,
    },
  );
}

export function executionError(
  code: ForgeExecutionErrorCode,
  phase: RunPhase,
  message: string,
  cause: unknown,
): ForgeExecutionError {
  return cause instanceof ForgeExecutionError
    ? cause
    : new ForgeExecutionError(code, phase, message, { cause });
}
