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
import {
  accumulateExperimentProgressGap,
  acknowledgeExperimentProgressGap,
  type ExperimentProgressGaps,
  prepareExperimentProgressRecord,
} from './experimentProgressState.ts';

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
  let gaps: ExperimentProgressGaps = { total: undefined, pending: undefined };
  let finishing: Promise<ExperimentLogGap | undefined> | undefined;
  const append =
    options.append ??
    ((body, signal) =>
      appendExperimentRunEventBody(options.root, body, signal));

  function gap(reason: ExperimentLogGap['reason'], count: number) {
    gaps = accumulateExperimentProgressGap(gaps, reason, count);
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
      const previousGap = gaps.pending;
      const record = prepareExperimentProgressRecord(next.body, previousGap);
      if (record.state === 'unavailable') {
        active = false;
        gap(record.reason, 1);
        continue;
      }
      try {
        const result = await observeWithin(
          (signal) =>
            append(record.body, AbortSignal.any([signal, lifetime.signal])),
          EXPERIMENT_OBSERVATION_LIMITS.appendMs,
        );
        if (disabled) return;
        if (result.state === 'unavailable') {
          stop('io_timeout');
          return;
        }
        gaps = acknowledgeExperimentProgressGap(gaps, previousGap);
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
      .catch(() => {
        stop('recording_error');
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
        gap(gaps.total?.reason ?? 'io_timeout', 1);
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
        return gaps.total;
      })();
      return finishing;
    },
  };
}
