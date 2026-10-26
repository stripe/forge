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
