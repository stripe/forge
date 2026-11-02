import type {
  RunEvent,
  RunObserver,
  RunPhase,
} from '../contracts/observability.ts';

export interface RunEventEmitter {
  phase<T>(
    phase: RunPhase,
    operation: (phase: RunPhase) => Promise<T>,
  ): Promise<T>;
  /** The phase failures are attributed to: work between two phases belongs to the one started last. */
  lastStartedPhase(): RunPhase;
}

/** Observer failures are isolated: observation must never change eval semantics. */
export const createRunEventEmitter = (
  observers: RunObserver[] = [],
): RunEventEmitter => {
  const lastStarted: { phase: RunPhase } = { phase: 'preflight' };
  return {
    phase: async (phase, operation) => {
      lastStarted.phase = phase;
      await emit(observers, { type: 'phase_started', phase });
      const value = await operation(phase);
      await emit(observers, { type: 'phase_completed', phase });
      return value;
    },
    lastStartedPhase: () => lastStarted.phase,
  };
};

const emit = (observers: RunObserver[], event: RunEvent) =>
  Promise.allSettled(
    observers.map(async (observer) => observer.observe(event)),
  );
