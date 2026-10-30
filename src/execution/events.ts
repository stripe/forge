import type {
  RunEvent,
  RunObserver,
  RunPhaseDetails,
} from '../contracts/observability.ts';

export interface RunEventEmitter {
  phase<T>(details: RunPhaseDetails, operation: () => Promise<T>): Promise<T>;
}

/** Observer failures are isolated: observation must never change eval semantics. */
export const createRunEventEmitter = (
  observers: RunObserver[] = [],
): RunEventEmitter => ({
  async phase(details, operation) {
    await emit(observers, { ...details, type: 'phase_started' });
    const value = await operation();
    await emit(observers, { ...details, type: 'phase_completed' });
    return value;
  },
});

const emit = (observers: RunObserver[], event: RunEvent) =>
  Promise.allSettled(
    observers.map(async (observer) => observer.observe(event)),
  );
