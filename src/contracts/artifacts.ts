export interface RunArtifact {
  readonly path: string;
  readonly body: Uint8Array;
  readonly mediaType: string;
  /** Restricted artifacts may contain unredacted credentials or private data. */
  readonly sensitivity?: 'restricted';
}

export interface RunArtifactContributionContext {
  readonly runId: string;
  /** Neutral, serializable result record produced by Forge. */
  readonly result: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

/** Adds artifacts before the atomic store transaction is committed. */
export interface RunArtifactContributor {
  readonly id: string;
  contribute(
    context: RunArtifactContributionContext,
  ): Promise<readonly RunArtifact[]>;
}

export interface RunArtifactTransaction {
  write(artifact: RunArtifact): Promise<void>;
  /** Makes all staged bytes visible as one completed run. */
  commit(result: Readonly<Record<string, unknown>>): Promise<CommittedRun>;
  /** Idempotent best-effort removal of uncommitted bytes. */
  rollback(): Promise<void>;
}

export interface CommittedRun {
  readonly runId: string;
  readonly location: string;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RunArtifactStore {
  begin(runId: string): Promise<RunArtifactTransaction>;
}

/** Publication is intentionally downstream of a successful local commit. */
export interface CommittedRunPublisher {
  publish(run: CommittedRun, options: {signal: AbortSignal}): Promise<void>;
}
