import type { AgentTokenUsage } from './agent.ts';
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

interface RunEventBase {
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly phase: RunPhase;
  readonly message?: string;
}

export type RunEvent = RunEventBase &
  (
    | { readonly type: 'phase_started' | 'phase_completed' | 'warning' }
    | {
        readonly type: 'agent_usage';
        readonly turn: number;
        readonly usage: AgentTokenUsage;
      }
  );

/** Observers receive redacted lifecycle events and have no runtime authority. */
export interface RunObserver {
  /** Return values are ignored; observers must not control lifecycle behavior. */
  observe(event: RunEvent): unknown | Promise<unknown>;
}
