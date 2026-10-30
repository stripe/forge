export type RunPhase =
  | 'preflight'
  | 'runtime_prepare'
  | 'setup'
  | 'interaction'
  | 'quiesce'
  | 'evidence'
  | 'evaluation'
  | 'artifact_stage'
  | 'runtime_dispose'
  | 'result_commit';

export type RunEventType = 'phase_started' | 'phase_completed';

export interface RunPhaseDetails {
  readonly phase: RunPhase;
  readonly sessionId?: string | null;
}

export interface RunEvent extends RunPhaseDetails {
  readonly type: RunEventType;
}

/** Observers receive redacted lifecycle events and have no runtime authority. */
export interface RunObserver {
  /** Return values are ignored; observers must not control lifecycle behavior. */
  observe(event: RunEvent): unknown | Promise<unknown>;
}
