import type { ExperimentRunProgressEvent } from './experiment.ts';
import {
  appendExperimentRunEventBody,
  ExperimentEventLogIoError,
  type ExperimentLogGap,
  serializeExperimentRunEvent,
} from './experimentEvents.ts';
import {
  EXPERIMENT_OBSERVATION_LIMITS,
  observeWithin,
} from './experimentObservation.ts';
import { serializeCanonicalJson } from './serialization.ts';

/** The experiment controller owns queue admission, append deadlines and shutdown. */
export function createExperimentProgress(options: {
  readonly root: string;
  readonly progress: (event: ExperimentRunProgressEvent) => void;
  readonly now?: () => Date;
  readonly append?: (body: string, signal: AbortSignal) => Promise<void>;
}) {
  const queue: { body: string; bytes: number }[] = [];
  const lifetime = new AbortController();
  let pendingBytes = 0;
  let active = false;
  let disabled = false;
  let closed = false;
  let draining: Promise<void> | undefined;
  let bug: unknown;
  let hasBug = false;
  let totalGap: ExperimentLogGap | undefined;
  let pendingGap: ExperimentLogGap | undefined;
  let finishing: Promise<ExperimentLogGap | undefined> | undefined;
  const append =
    options.append ??
    ((body, signal) =>
      appendExperimentRunEventBody(options.root, body, signal));

  function gap(reason: ExperimentLogGap['reason'], count: number) {
    if (count === 0) return;
    const add = (previous: ExperimentLogGap | undefined): ExperimentLogGap => ({
      state: 'unavailable',
      reason: previous?.reason ?? reason,
      affected_events: Math.min(
        Number.MAX_SAFE_INTEGER,
        (previous?.affected_events ?? 0) + count,
      ),
    });
    totalGap = add(totalGap);
    pendingGap = add(pendingGap);
  }
  function stop(reason: ExperimentLogGap['reason']) {
    disabled = true;
    gap(reason, queue.length + (active ? 1 : 0));
    queue.length = 0;
    pendingBytes = 0;
    active = false;
    lifetime.abort();
  }
  async function drain() {
    while (!disabled) {
      const next = queue.shift();
      if (next === undefined) return;
      pendingBytes -= next.bytes;
      active = true;
      const previousGap = pendingGap;
      const body =
        previousGap === undefined
          ? next.body
          : serializeCanonicalJson({
              ...JSON.parse(next.body),
              recording_gap: previousGap,
            });
      if (Buffer.byteLength(body) > EXPERIMENT_OBSERVATION_LIMITS.eventBytes) {
        active = false;
        gap('buffer_full', 1);
        continue;
      }
      try {
        const result = await observeWithin(
          (signal) => append(body, AbortSignal.any([signal, lifetime.signal])),
          EXPERIMENT_OBSERVATION_LIMITS.appendMs,
        );
        if (disabled) return;
        if (result.state === 'unavailable') {
          stop('io_timeout');
          return;
        }
        if (previousGap !== undefined && pendingGap !== undefined) {
          const remaining =
            pendingGap.affected_events - previousGap.affected_events;
          pendingGap =
            remaining === 0
              ? undefined
              : { ...pendingGap, affected_events: remaining };
        }
      } catch (error) {
        if (disabled) return;
        if (!(error instanceof ExperimentEventLogIoError)) throw error;
        if (!error.retryable) {
          stop('io_error');
          return;
        }
        gap('io_error', 1);
      }
      active = false;
    }
  }
  function start() {
    if (draining !== undefined || disabled) return;
    draining = drain()
      .catch((error: unknown) => {
        hasBug = true;
        bug = error;
        stop('io_error');
      })
      .finally(() => {
        draining = undefined;
        if (queue.length > 0 && !disabled) start();
      });
  }
  return {
    record(event: ExperimentRunProgressEvent): void {
      if (closed) throw new Error('Experiment progress is closed.');
      // Schema drift is a programmer error, not a filesystem availability issue.
      const body = serializeExperimentRunEvent(
        options.root,
        event,
        options.now,
      );
      options.progress(event);
      if (disabled) {
        gap('io_timeout', 1);
        return;
      }
      const bytes = Buffer.byteLength(body);
      if (pendingBytes + bytes > EXPERIMENT_OBSERVATION_LIMITS.pendingBytes) {
        gap('buffer_full', 1);
        return;
      }
      queue.push({ body, bytes });
      pendingBytes += bytes;
      start();
    },
    finish(): Promise<ExperimentLogGap | undefined> {
      finishing ??= (async () => {
        closed = true;
        const result = await observeWithin(async () => {
          while (draining !== undefined) await draining;
        }, EXPERIMENT_OBSERVATION_LIMITS.drainMs);
        if (result.state === 'unavailable') stop('io_timeout');
        if (hasBug) throw bug;
        return totalGap;
      })();
      return finishing;
    },
  };
}
