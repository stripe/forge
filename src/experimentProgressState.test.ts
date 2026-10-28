import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  type ExperimentLogGap,
  parseExperimentRunEvent,
} from './experimentEvents.ts';
import { EXPERIMENT_OBSERVATION_LIMITS } from './experimentObservation.ts';
import {
  accumulateExperimentProgressGap,
  acknowledgeExperimentProgressGap,
  prepareExperimentProgressRecord,
} from './experimentProgressState.ts';
import { serializeCanonicalJson } from './serialization.ts';

const gap: ExperimentLogGap = {
  state: 'unavailable',
  reason: 'io_error',
  affected_events: 2,
};
const event = {
  state: 'started',
  location: '/example',
  experiment_run_id: 'example',
  observed_at: '2026-01-02T03:04:05.678Z',
};

describe('pure experiment progress decisions', () => {
  it('keeps first reasons, adds counts, and leaves inputs unchanged', () => {
    const initial = Object.freeze({
      total: Object.freeze(gap),
      pending: Object.freeze({ ...gap, reason: 'buffer_full' as const }),
    });
    assert.equal(
      accumulateExperimentProgressGap(initial, 'io_timeout', 0),
      initial,
    );
    const next = accumulateExperimentProgressGap(initial, 'io_timeout', 3);
    assert.deepEqual(next, {
      total: { ...gap, affected_events: 5 },
      pending: { ...gap, reason: 'buffer_full', affected_events: 5 },
    });
    assert.equal(initial.total.affected_events, 2);
    assert.deepEqual(
      accumulateExperimentProgressGap(
        { total: undefined, pending: undefined },
        'recording_error',
        1,
      ),
      {
        total: { ...gap, reason: 'recording_error', affected_events: 1 },
        pending: { ...gap, reason: 'recording_error', affected_events: 1 },
      },
    );
  });

  it('saturates gap counts at the safe integer bound', () => {
    const limit = { ...gap, affected_events: Number.MAX_SAFE_INTEGER - 1 };
    assert.deepEqual(
      accumulateExperimentProgressGap(
        { total: limit, pending: limit },
        'io_timeout',
        5,
      ),
      {
        total: { ...limit, affected_events: Number.MAX_SAFE_INTEGER },
        pending: { ...limit, affected_events: Number.MAX_SAFE_INTEGER },
      },
    );
  });

  it('acknowledges the written snapshot while retaining gaps added during a write', () => {
    const initial = { total: gap, pending: gap };
    const concurrent = accumulateExperimentProgressGap(
      initial,
      'buffer_full',
      3,
    );
    const next = acknowledgeExperimentProgressGap(concurrent, gap);
    assert.deepEqual(next, {
      total: { ...gap, affected_events: 5 },
      pending: { ...gap, affected_events: 3 },
    });
    assert.deepEqual(acknowledgeExperimentProgressGap(initial, gap), {
      total: gap,
      pending: undefined,
    });
    assert.equal(acknowledgeExperimentProgressGap(initial, undefined), initial);
    assert.equal(acknowledgeExperimentProgressGap(next, undefined), next);
    const empty = { total: undefined, pending: undefined };
    assert.equal(acknowledgeExperimentProgressGap(empty, gap), empty);
    assert.equal(initial.pending.affected_events, 2);
  });

  it('adds a canonical optional gap without changing the source record', () => {
    const body = serializeCanonicalJson(event);
    assert.deepEqual(prepareExperimentProgressRecord(body, undefined), {
      state: 'ready',
      body,
    });
    const result = prepareExperimentProgressRecord(body, gap);
    assert.equal(result.state, 'ready');
    if (result.state !== 'ready') throw new Error('Expected a record');
    assert.equal(
      result.body,
      serializeCanonicalJson({ ...event, recording_gap: gap }),
    );
    assert.deepEqual(
      parseExperimentRunEvent(JSON.parse(result.body)).recording_gap,
      gap,
    );
    assert.equal(JSON.parse(body).recording_gap, undefined);
  });

  it('applies the byte limit after adding gap metadata and counts UTF-8 bytes', () => {
    const base = serializeCanonicalJson(event);
    const exact = serializeCanonicalJson({
      ...event,
      location:
        event.location +
        'x'.repeat(
          EXPERIMENT_OBSERVATION_LIMITS.eventBytes - Buffer.byteLength(base),
        ),
    });
    assert.equal(
      Buffer.byteLength(exact),
      EXPERIMENT_OBSERVATION_LIMITS.eventBytes,
    );
    assert.deepEqual(prepareExperimentProgressRecord(exact, undefined), {
      state: 'ready',
      body: exact,
    });
    assert.deepEqual(prepareExperimentProgressRecord(exact, gap), {
      state: 'unavailable',
      reason: 'buffer_full',
    });
    assert.deepEqual(
      prepareExperimentProgressRecord(
        exact.replace('/example', '/examplé'),
        undefined,
      ),
      { state: 'unavailable', reason: 'buffer_full' },
    );
  });
});
