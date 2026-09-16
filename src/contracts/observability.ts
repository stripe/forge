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

export interface RunEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: 'phase_started' | 'phase_completed' | 'warning';
  readonly phase: RunPhase;
  readonly message?: string;
}

/** Observers receive redacted lifecycle events and have no runtime authority. */
export interface RunObserver {
  /** Return values are ignored; observers must not control lifecycle behavior. */
  observe(event: RunEvent): unknown | Promise<unknown>;
}
