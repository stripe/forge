import type {
  RunEvent,
  RunObserver,
  RunPhase,
} from '../contracts/observability.ts';

export interface RunEventEmitter {
  phase<T>(phase: RunPhase, operation: () => Promise<T>): Promise<T>;
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
    type: RunEvent['type'],
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
    async phase(phase, operation) {
      await emit('phase_started', phase);
      const value = await operation();
      await emit('phase_completed', phase);
      return value;
    },
    warning: (phase, message) => emit('warning', phase, message),
  };
}
