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

/** Created without authority; running sends one fixed prompt, never case content. */
export interface ModelProbe {
  /** Exact credential-free HTTP endpoint, available before credential lookup. */
  readonly endpoint: string;
  run(context: {
    readonly credentialResolver: CredentialResolver;
    readonly signal: AbortSignal;
  }): Promise<ModelProbeOutcome>;
}
