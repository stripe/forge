import type { ResolvedRunPlanV1 } from '../model/types.ts';
import type { RunArtifact } from './artifacts.ts';

/** Context for `afterTask`: the agent's captured native session, before evaluation. */
export interface RunAfterTaskContext {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV1;
  readonly sessionId: string;
  /** Exact, unredacted bytes Forge will store; may be `sensitivity: 'restricted'`. */
  readonly nativeArtifact: RunArtifact;
}

/**
 * Trusted host code, like the runtime adapter, with access to unredacted sessions.
 * Methods name user-facing run stages and are optional. Forge does not wait for
 * them; return values and failures are ignored.
 */
export interface RunLifecycleListener {
  readonly id: string;
  /** The agent finished and its session is captured; evaluation hasn't started. */
  afterTask?(context: RunAfterTaskContext): unknown | Promise<unknown>;
}
