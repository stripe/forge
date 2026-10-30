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

export type RunEvent =
  | {
      readonly type: 'phase_started' | 'phase_completed';
      readonly phase: RunPhase;
    }
  | {
      readonly type: 'warning';
      readonly runId: string;
      readonly sequence: number;
      readonly timestamp: string;
      readonly phase: RunPhase;
      readonly message: string;
    }
  | {
      readonly type: 'agent_usage';
      readonly runId: string;
      readonly sequence: number;
      readonly timestamp: string;
      readonly phase: RunPhase;
      readonly turn: number;
      readonly usage: AgentTokenUsage;
    };

/** Observers receive redacted lifecycle events and have no runtime authority. */
export interface RunObserver {
  /** Return values are ignored; observers must not control lifecycle behavior. */
  observe(event: RunEvent): unknown | Promise<unknown>;
}
