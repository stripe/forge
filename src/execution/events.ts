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
  let sequence = 0;

  const emit = async (
    type: 'phase_started' | 'phase_completed' | 'warning',
    phase: RunPhase,
    message?: string,
  ): Promise<void> => {
    const event: RunEvent = {
      runId,
      sequence: sequence++,
      timestamp: now().toISOString(),
      type,
      phase,
      ...(message === undefined ? {} : { message }),
    };
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
      await Promise.allSettled(
        observers.map(async (observer) => observer.observe(event)),
      );
    },
    async phase(phase, operation) {
      await emit('phase_started', phase);
      const value = await operation();
      await emit('phase_completed', phase);
      return value;
    },
    warning: (phase, message) => emit('warning', phase, message),
  };
}
