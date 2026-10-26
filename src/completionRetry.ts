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

export interface CompletionRetryOptions {
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onRetryDecision?: (
    error: unknown,
    decision: CompletionRetryDecision,
  ) => void;
}

/** Pure policy: budgets belong to a single logical request, independent of peers. */
export function completionRetryDecision(
  state: CompletionRetryState,
  error: unknown,
  parseFailure: boolean,
  random: number,
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

export async function waitForCompletionRetry(
  error: unknown,
  decision: CompletionRetryDecision,
  signal: AbortSignal,
  options: CompletionRetryOptions,
): Promise<void> {
  if (decision.disposition === 'exhausted') {
    notifyRetryDecision(error, decision, options);
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
          error,
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
  error: unknown,
  decision: CompletionRetryDecision,
  options: CompletionRetryOptions,
): void {
  try {
    void Promise.resolve(options.onRetryDecision?.(error, decision)).catch(
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
