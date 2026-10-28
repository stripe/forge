import type { CredentialResolver } from './credentials.ts';

/** Bounded model-test results; no provider response text or secrets. */
export type ModelProbeOutcome =
  | 'ok'
  | 'unknown_model'
  | 'auth'
  | 'missing_structured_output'
  | 'rate_limited'
  | 'timeout'
  | 'other';

export type ModelProbeReason =
  | 'http_error'
  | 'invalid_response'
  | 'invalid_structured_output'
  | 'credential_unavailable'
  | 'transport_error'
  | 'probe_failed'
  | 'deadline_exceeded'
  | 'probe_unavailable'
  | 'invalid_probe_result';

export interface ModelProbeResult {
  readonly outcome: ModelProbeOutcome;
  readonly reason?: ModelProbeReason;
  readonly http_status?: number;
}

/** Created without authority; running sends one fixed prompt, never case content. */
export interface ModelProbe {
  /** Exact credential-free HTTP endpoint, available before credential lookup. */
  readonly endpoint: string;
  /** Optional lower deadline; the caller enforces a maximum of one minute. */
  readonly timeoutMs?: number;
  /** Callers enforce the deadline even if the capability ignores the signal. */
  run(context: {
    readonly credentialResolver: CredentialResolver;
    readonly signal: AbortSignal;
  }): Promise<ModelProbeResult>;
}
