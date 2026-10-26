import type { AgentTokenUsage } from '../contracts/agent.ts';
import type {
  RunEvent,
  RunObserver,
  RunPhase,
} from '../contracts/observability.ts';

export interface RunEventEmitter {
  phase<T>(phase: RunPhase, operation: () => Promise<T>): Promise<T>;
  agentUsage(turn: number, usage: AgentTokenUsage): Promise<void>;
}

/** Observer failures are isolated: observation must never change eval semantics. */
export const createRunEventEmitter = (
  observers: RunObserver[] = [],
): RunEventEmitter => ({
  async agentUsage(turn, usage) {
    await emit(
      observers,
      Object.freeze({
        type: 'agent_usage',
        phase: 'interaction',
        turn,
        usage: Object.freeze({ ...usage }),
      }),
    );
  },
  async phase(phase, operation) {
    await emit(observers, { type: 'phase_started', phase });
    const value = await operation();
    await emit(observers, { type: 'phase_completed', phase });
    return value;
  },
});

const emit = (observers: RunObserver[], event: RunEvent) =>
  Promise.allSettled(
    observers.map(async (observer) => observer.observe(event)),
  );
