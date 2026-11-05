import type { RunPhase } from '../../contracts/observability.ts';
import { throwIfAborted } from '../../execution/errors.ts';
import type { RunEventEmitter } from '../../execution/events.ts';

export interface PhaseOptions {
  /** Check for abort before the body runs. */
  readonly abortable?: boolean;
}

export interface PhaseRunner {
  /** Run one public phase: emit its events and make it the phase failures report until the next one starts. */
  run<T>(
    name: RunPhase,
    body: () => Promise<T>,
    options?: PhaseOptions,
  ): Promise<T>;
  current(): RunPhase;
}

export interface PhaseRunnerInput {
  readonly events: RunEventEmitter;
  readonly signal: AbortSignal;
}

export const createPhaseRunner = ({
  events,
  signal,
}: PhaseRunnerInput): PhaseRunner => {
  // Mutable only while executeEval's outer catch reads current() for attribution.
  const state: { current: RunPhase } = { current: 'preflight' };
  return {
    run: (name, body, options = {}) =>
      events.phase(name, async () => {
        state.current = name;
        if (options.abortable) throwIfAborted(signal, name);
        return body();
      }),
    current: () => state.current,
  };
};
