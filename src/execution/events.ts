import type { AgentTokenUsage } from '../contracts/agent.ts';
import type {
  RunEvent,
  RunObserver,
  RunPhase,
} from '../contracts/observability.ts';

export interface RunEventEmitter {
  phase<T>(phase: RunPhase, operation: () => Promise<T>): Promise<T>;
  agentUsage(turn: number, usage: AgentTokenUsage): Promise<void>;
  warning(phase: RunPhase, message: string): Promise<void>;
}

/** Observer failures are isolated: observation must never change eval semantics. */
export function createRunEventEmitter(
  runId: string,
  observers: readonly RunObserver[] = [],
  now: () => Date = () => new Date(),
): RunEventEmitter {
  // Phase events no longer carry a sequence but still advance it, so the
  // numbering of warning and usage events is unchanged.
  let sequence = 0;

  const deliver = async (event: RunEvent): Promise<void> => {
    await Promise.allSettled(
      observers.map(async (observer) => observer.observe(event)),
    );
  };

  return {
    async agentUsage(turn, usage) {
      const event: RunEvent = Object.freeze({
        runId,
        sequence: sequence++,
        timestamp: now().toISOString(),
        type: 'agent_usage',
        phase: 'interaction',
        turn,
        usage: Object.freeze({ ...usage }),
      });
      await deliver(event);
    },
    async phase(phase, operation) {
      sequence++;
      await deliver({ type: 'phase_started', phase });
      const value = await operation();
      sequence++;
      await deliver({ type: 'phase_completed', phase });
      return value;
    },
    warning: (phase, message) =>
      deliver({
        runId,
        sequence: sequence++,
        timestamp: now().toISOString(),
        type: 'warning',
        phase,
        message,
      }),
  };
}
