import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import type { ExperimentRunProgressEvent } from './experiment.ts';
import {
  ExperimentEventLogIoError,
  parseExperimentRunEvent,
} from './experimentEvents.ts';
import { EXPERIMENT_OBSERVATION_LIMITS } from './experimentObservation.ts';
import { createExperimentProgress } from './experimentProgress.ts';

afterEach(() => vi.useRealTimers());
const event = { state: 'started', location: '/example' } as const;

describe('experiment controller progress recording', () => {
  it('delivers progress immediately, serializes writes, and records recovered I/O gaps', async () => {
    const callbacks: string[] = [];
    const bodies: string[] = [];
    let release!: () => void;
    let attempts = 0;
    let active = 0;
    let maximum = 0;
    const recorder = createExperimentProgress({
      root: '/example',
      progress: (item) => callbacks.push(item.state),
      append: async (body) => {
        maximum = Math.max(maximum, ++active);
        try {
          if (++attempts === 1) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            throw new ExperimentEventLogIoError();
          }
          bodies.push(body);
        } finally {
          active -= 1;
        }
      },
    });
    recorder.record(event);
    recorder.record({ state: 'resuming', location: '/example' });
    assert.deepEqual(callbacks, ['started', 'resuming']);
    assert.equal(attempts, 1);
    release();
    const gap = await recorder.finish();
    assert.deepEqual(gap, {
      state: 'unavailable',
      reason: 'io_error',
      affected_events: 1,
    });
    assert.equal(maximum, 1);
    assert.equal(bodies.length, 1);
    const saved = parseExperimentRunEvent(JSON.parse(bodies[0]!));
    assert.equal(saved.state, 'resumed');
    assert.deepEqual(saved.recording_gap, gap);
  });

  it('bounds a stalled append, drops queued events, and never blocks progress callbacks', async () => {
    vi.useFakeTimers();
    let callbacks = 0;
    let writes = 0;
    let writeSignal: AbortSignal | undefined;
    const recorder = createExperimentProgress({
      root: '/example',
      progress: () => {
        callbacks += 1;
      },
      append: async (_body, signal) => {
        writes += 1;
        writeSignal = signal;
        await new Promise(() => {});
      },
    });
    recorder.record(event);
    recorder.record(event);
    assert.equal(callbacks, 2);
    await vi.advanceTimersByTimeAsync(EXPERIMENT_OBSERVATION_LIMITS.appendMs);
    assert.equal(writeSignal?.aborted, true);
    recorder.record(event);
    const summary = await recorder.finish();
    assert.deepEqual(summary, {
      state: 'unavailable',
      reason: 'io_timeout',
      affected_events: 3,
    });
    assert.equal(writes, 1);
    assert.equal(callbacks, 3);
    assert.equal(vi.getTimerCount(), 0);
  });

  it('bounds the entire final drain even if each individual append is only slow', async () => {
    vi.useFakeTimers();
    let writes = 0;
    const recorder = createExperimentProgress({
      root: '/example',
      progress: () => undefined,
      append: async () => {
        writes += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    });
    for (let index = 0; index < 10; index += 1) recorder.record(event);
    const done = recorder.finish();
    await vi.advanceTimersByTimeAsync(EXPERIMENT_OBSERVATION_LIMITS.drainMs);
    assert.deepEqual(await done, {
      state: 'unavailable',
      reason: 'io_timeout',
      affected_events: 8,
    });
    assert.equal(writes, 3);
    await vi.advanceTimersByTimeAsync(200);
    assert.equal(writes, 3);
  });

  it('bounds queue memory and persists a dropped-event count after recovery', async () => {
    let release!: () => void;
    const bodies: string[] = [];
    const recorder = createExperimentProgress({
      root: '/example',
      progress: () => undefined,
      append: async (body) => {
        if (bodies.length === 0)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        bodies.push(body);
      },
    });
    const large = { ...event, location: 'x'.repeat(60_000) };
    for (let index = 0; index < 40; index += 1) recorder.record(large);
    release();
    const gap = await recorder.finish();
    assert.equal(gap?.reason, 'buffer_full');
    assert.ok(gap!.affected_events > 0);
    assert.equal(bodies.length + gap!.affected_events, 40);
    assert.deepEqual(JSON.parse(bodies[1]!).recording_gap, gap);
  });

  it('stops attempting a permanently unavailable log while continuing callbacks', async () => {
    let attempts = 0;
    let callbacks = 0;
    const recorder = createExperimentProgress({
      root: '/example',
      progress: () => {
        callbacks += 1;
      },
      append: async () => {
        attempts += 1;
        throw new ExperimentEventLogIoError(false);
      },
    });
    recorder.record(event);
    recorder.record(event);
    recorder.record(event);
    assert.deepEqual(await recorder.finish(), {
      state: 'unavailable',
      reason: 'io_error',
      affected_events: 3,
    });
    assert.equal(attempts, 1);
    assert.equal(callbacks, 3);
  });

  it('surfaces schema drift and unexpected programming errors instead of disguising them as I/O', async () => {
    const recorder = createExperimentProgress({
      root: '/example',
      progress: () => undefined,
      append: async () => {
        throw new TypeError('recorder bug');
      },
    });
    assert.throws(() =>
      recorder.record({
        ...event,
        unrecognized: true,
      } as ExperimentRunProgressEvent),
    );
    recorder.record(event);
    await assert.rejects(recorder.finish(), /recorder bug/);
  });
});
