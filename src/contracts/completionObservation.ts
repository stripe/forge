import { z } from 'zod';

export const MAX_COMPLETION_RETRY_WAIT_MS = 64_000;
export const completionProviderErrorCodeSchema = z.enum([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'overloaded_error',
  'api_error',
  'invalid_api_key',
  'insufficient_quota',
  'rate_limit_exceeded',
  'model_not_found',
  'context_length_exceeded',
  'invalid_value',
  'server_error',
  'request_too_large',
]);
export type CompletionProviderErrorCode = z.infer<
  typeof completionProviderErrorCodeSchema
>;

/**
 * How the shared retry policy treats a recognized provider error code.
 * `permanent` stops at once and `client` uses the short schedule. `by_status`
 * codes name a condition the HTTP status already carries (429, or 503 with
 * `Retry-After`, for rate limits; other statuses for server faults), so the
 * status selects the schedule.
 */
export type CompletionProviderErrorClass = 'permanent' | 'client' | 'by_status';

/** Exhaustive, so a new recognized code fails typecheck until it is classified. */
export const COMPLETION_PROVIDER_ERROR_CLASS: Readonly<
  Record<CompletionProviderErrorCode, CompletionProviderErrorClass>
> = Object.freeze({
  invalid_request_error: 'client',
  authentication_error: 'client',
  permission_error: 'client',
  not_found_error: 'client',
  invalid_api_key: 'client',
  model_not_found: 'client',
  context_length_exceeded: 'client',
  invalid_value: 'client',
  request_too_large: 'client',
  insufficient_quota: 'permanent',
  rate_limit_error: 'by_status',
  rate_limit_exceeded: 'by_status',
  overloaded_error: 'by_status',
  api_error: 'by_status',
  server_error: 'by_status',
});

/**
 * `CompletionInvocationError.code` values for which the shared policy knows
 * the reply or request itself was at fault, so the short schedule applies.
 */
export const CLIENT_COMPLETION_INVOCATION_CODES: readonly string[] =
  Object.freeze(['invalid_request', 'invalid_credentials', 'invalid_output']);

export const completionTransportObservationSchema = z
  .object({
    origin: z.literal('host_transport'),
    http_status: z.number().int().min(100).max(599),
    retry_after_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_COMPLETION_RETRY_WAIT_MS)
      .optional(),
    request_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
      .optional(),
    provider_error_code: completionProviderErrorCodeSchema.optional(),
  })
  .strict();

/** Allowlisted transport facts; never contains response text, URLs, or arbitrary headers. */
export type CompletionTransportObservation = z.infer<
  typeof completionTransportObservationSchema
>;

export class CompletionInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly observation?: CompletionTransportObservation,
  ) {
    super(message);
    this.name = 'CompletionInvocationError';
  }
}

export interface CompletionRetryDecision {
  readonly disposition: 'retry' | 'rate_limit_retry' | 'exhausted';
  readonly wait_ms: number;
}
