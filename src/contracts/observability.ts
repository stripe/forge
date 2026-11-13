/** @internal Shared values for the RunPhase contract and persisted schemas. */
export const RUN_PHASES = [
  'preflight',
  'runtime_prepare',
  'setup',
  'interaction',
  'quiesce',
  'evidence',
  'evaluation',
  'artifact_stage',
  'runtime_dispose',
  'result_commit',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export type RunEventType = 'phase_started' | 'phase_completed';

export interface RunEvent {
  readonly type: RunEventType;
  readonly phase: RunPhase;
}

/** Observers receive redacted lifecycle events and have no runtime authority. */
export interface RunObserver {
  /** Return values are ignored; observers must not control lifecycle behavior. */
  observe(event: RunEvent): unknown | Promise<unknown>;
}
