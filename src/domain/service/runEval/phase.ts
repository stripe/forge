import type { RunPhase } from '../../../contracts/observability.ts';
import type { RunEventEmitter } from '../../../execution/events.ts';

export interface PhaseRunner {
  /** Run one public phase: emit its events and make it the phase failures report until the next one starts. */
  run<T>(name: RunPhase, body: () => Promise<T>): Promise<T>;
  current(): RunPhase;
}

export interface PhaseRunnerInput {
  readonly events: RunEventEmitter;
}

export const createPhaseRunner = ({
  events,
}: PhaseRunnerInput): PhaseRunner => {
  // Mutable only while executeEval's outer catch reads current() for attribution.
  const state: { current: RunPhase } = { current: 'preflight' };
  return {
    run: (name, body) =>
      events.phase(name, async () => {
        state.current = name;
        return body();
      }),
    current: () => state.current,
  };
};
