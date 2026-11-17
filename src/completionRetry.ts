import {
  CompletionInvocationError,
  type CompletionRetryDecision,
  completionTransportObservationSchema,
  MAX_COMPLETION_RETRY_WAIT_MS,
} from './contracts/completionObservation.ts';

export const SHORT_COMPLETION_RETRY_DELAYS_MS = Object.freeze([
  1000, 5000,
] as const);

const RATE_LIMIT_RETRY_DELAYS_MS = Object.freeze([
  2000, 4000, 8000, 16000, 32000, 64000,
] as const);
const LONG_COMPLETION_RETRY_DELAYS_MS = Object.freeze([
  4000, 16000, 64000,
] as const);
export const MAX_COMPLETION_ATTEMPTS =
  1 +
  RATE_LIMIT_RETRY_DELAYS_MS.length +
  SHORT_COMPLETION_RETRY_DELAYS_MS.length +
  LONG_COMPLETION_RETRY_DELAYS_MS.length;

export interface CompletionRetryState {
  readonly ordinal: number;
  readonly rateLimitRetries: number;
  readonly shortRetries: number;
  readonly longRetries: number;
}
export const INITIAL_COMPLETION_RETRY_STATE: CompletionRetryState =
  Object.freeze({
    ordinal: 0,
    rateLimitRetries: 0,
    shortRetries: 0,
    longRetries: 0,
  });

/**
 * One attempt of a logical completion request. The driver states the ordinal;
 * the completion runtime reports the sequence of the call the attempt made, so
 * a retry decision attaches to that call even when the reply parsed.
 */
export interface CompletionAttemptContext {
  /** Zero for the first attempt of a request. */
  readonly retryOrdinal: number;
  sequence?: number;
}

export interface CompletionRetryOptions {
  readonly now?: () => number;
  /**
   * Time on the `now` clock at which the run stops. A retry whose wait would
   * reach it is not started, so the request fails now instead of the run
   * losing its committed result to the deadline.
   */
  readonly deadline?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /**
   * @deprecated Use `sleep`. Overrides each retry wait with a caller-chosen
   * delay and never receives the policy's `wait_ms`; an explicit `sleep` wins.
   */
  readonly waitBeforeRetry?: (
    failedAttempt: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly onRetryDecision?: (
    sequence: number,
    decision: CompletionRetryDecision,
  ) => void;
}

/** Pure policy: budgets belong to a single logical request, independent of peers. */
export function completionRetryDecision(
  state: CompletionRetryState,
  error: unknown,
  parseFailure: boolean,
  random: number,
  remainingMs?: number,
): {
  readonly state: CompletionRetryState;
  readonly decision: CompletionRetryDecision;
} {
  const parsed = completionTransportObservationSchema.safeParse(
    error instanceof CompletionInvocationError ? error.observation : undefined,
  );
  const observation = parsed.success ? parsed.data : undefined;
  if (observation?.provider_error_code === 'insufficient_quota') {
    return { state, decision: { disposition: 'exhausted', wait_ms: 0 } };
  }
  const status = observation?.http_status;
  const rateLimited =
    status === 429 ||
    (status === 503 && observation?.retry_after_ms !== undefined);
  const short =
    parseFailure ||
    [
      'invalid_request_error',
      'authentication_error',
      'invalid_api_key',
      'permission_error',
      'not_found_error',
      'model_not_found',
      'context_length_exceeded',
      'invalid_value',
      'request_too_large',
    ].includes(observation?.provider_error_code ?? '') ||
    [400, 401, 403, 404].includes(status ?? 0) ||
    (error instanceof CompletionInvocationError &&
      ['invalid_request', 'invalid_credentials', 'invalid_output'].includes(
        error.code,
      ));
  const category = rateLimited
    ? 'rateLimitRetries'
    : short
      ? 'shortRetries'
      : 'longRetries';
  const delays = rateLimited
    ? RATE_LIMIT_RETRY_DELAYS_MS
    : short
      ? SHORT_COMPLETION_RETRY_DELAYS_MS
      : LONG_COMPLETION_RETRY_DELAYS_MS;
  const base = delays[state[category]];
  if (base === undefined)
    return { state, decision: { disposition: 'exhausted', wait_ms: 0 } };
  const sample = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 1;
  const scheduledDelay =
    category === 'shortRetries'
      ? base
      : Math.round(base * (0.75 + sample * 0.25));
  const delay = rateLimited
    ? Math.max(scheduledDelay, observation?.retry_after_ms ?? 0)
    : scheduledDelay;
  if (remainingMs !== undefined && Math.min(MAX_COMPLETION_RETRY_WAIT_MS, delay) >= remainingMs)
    return { state, decision: { disposition: 'exhausted', wait_ms: 0 } };
  return {
    state: {
      ...state,
      ordinal: state.ordinal + 1,
      [category]: state[category] + 1,
    },
    decision: {
      disposition: rateLimited ? 'rate_limit_retry' : 'retry',
      wait_ms: Math.min(MAX_COMPLETION_RETRY_WAIT_MS, delay),
    },
  };
}

/** The provider reported that the model's structured output was malformed. */
export function isInvalidOutputFailure(error: unknown): boolean {
  return (
    error instanceof CompletionInvocationError && error.code === 'invalid_output'
  );
}

export type CompletionAttemptOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: unknown;
      /** The reply arrived but was unusable, so the short schedule applies. */
      readonly parseFailure: boolean;
    };

export type CompletionRetryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly parseFailure: boolean;
      readonly attempts: number;
    };

/**
 * Shared driver for one logical completion request: run `attempt`, ask the
 * policy about each failure, wait, and stop when the policy is exhausted.
 * `attempt` throws only to abort the request.
 */
export async function retryCompletion<T>(
  signal: AbortSignal,
  options: CompletionRetryOptions,
  attempt: (
    attemptNumber: number,
    context: CompletionAttemptContext,
  ) => Promise<CompletionAttemptOutcome<T>>,
): Promise<CompletionRetryResult<T>> {
  let state = INITIAL_COMPLETION_RETRY_STATE;
  for (let attempts = 1; ; attempts += 1) {
    const context: CompletionAttemptContext = { retryOrdinal: attempts - 1 };
    const outcome = await attempt(attempts, context);
    if (outcome.ok) return outcome;
    const next = completionRetryDecision(
      state,
      outcome.error,
      outcome.parseFailure,
      (options.random ?? Math.random)(),
      remainingMilliseconds(options),
    );
    state = next.state;
    const waitBeforeRetry = options.waitBeforeRetry;
    await waitForCompletionRetry(context.sequence, next.decision, signal, {
      ...options,
      ...(options.sleep !== undefined || waitBeforeRetry === undefined
        ? {}
        : {
            sleep: (_milliseconds: number, retrySignal: AbortSignal) =>
              waitBeforeRetry(attempts, retrySignal),
          }),
    });
    if (next.decision.disposition === 'exhausted') return { ...outcome, attempts };
  }
}

function remainingMilliseconds(
  options: CompletionRetryOptions,
): number | undefined {
  if (options.deadline === undefined) return undefined;
  try {
    return options.deadline - (options.now ?? Date.now)();
  } catch {
    // An unavailable clock cannot bound the wait.
    return undefined;
  }
}

export async function waitForCompletionRetry(
  sequence: number | undefined,
  decision: CompletionRetryDecision,
  signal: AbortSignal,
  options: CompletionRetryOptions,
): Promise<void> {
  if (decision.disposition === 'exhausted') {
    notifyRetryDecision(sequence, decision, options);
    return;
  }
  const now = options.now ?? Date.now;
  let start: number | undefined;
  try {
    start = now();
  } catch {
    // A failed observation clock leaves the measured wait unknown.
  }
  try {
    await (options.sleep ?? sleep)(decision.wait_ms, signal);
    signal.throwIfAborted();
  } finally {
    try {
      const elapsed = start === undefined ? Number.NaN : now() - start;
      if (Number.isFinite(elapsed) && elapsed >= 0) {
        notifyRetryDecision(
          sequence,
          {
            ...decision,
            wait_ms: Math.min(decision.wait_ms, Math.round(elapsed)),
          },
          options,
        );
      }
    } catch {
      // A failed observation clock leaves the measured wait unknown.
    }
  }
}

function notifyRetryDecision(
  sequence: number | undefined,
  decision: CompletionRetryDecision,
  options: CompletionRetryOptions,
): void {
  if (sequence === undefined) return;
  try {
    void Promise.resolve(options.onRetryDecision?.(sequence, decision)).catch(
      () => undefined,
    );
  } catch {
    // An unavailable observer must not change completion or cancellation semantics.
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason ??
          new DOMException('The operation was aborted.', 'AbortError'),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
