import type {RunPhase} from '../contracts/observability.js';

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

/** Stable, secret-safe failure surfaced by the shared execution lifecycle. */
export class ForgeExecutionError extends Error {
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

export function throwIfAborted(signal: AbortSignal, phase: RunPhase): void {
  if (!signal.aborted) return;
  throw new ForgeExecutionError('aborted', phase, 'The Forge run was aborted.', {
    cause: signal.reason,
  });
}

export function executionError(
  code: ForgeExecutionErrorCode,
  phase: RunPhase,
  message: string,
  cause: unknown,
): ForgeExecutionError {
  return cause instanceof ForgeExecutionError
    ? cause
    : new ForgeExecutionError(code, phase, message, {cause});
}
