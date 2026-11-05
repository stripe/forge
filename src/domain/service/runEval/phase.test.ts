import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { RunPhase } from '../../../contracts/observability.ts';
import type { RunEventEmitter } from '../../../execution/events.ts';

import { createPhaseRunner } from './phase.ts';

const recordingEmitter = (calls: RunPhase[]): RunEventEmitter => ({
  phase: (phase, operation) => {
    calls.push(phase);
    return operation();
  },
});

describe('phase runner', () => {
  it('starts in preflight', () => {
    const phases = createPhaseRunner({ events: recordingEmitter([]) });

    assert.equal(phases.current(), 'preflight');
  });

  it('runs each phase through the emitter and reports the latest phase', async () => {
    const calls: RunPhase[] = [];
    const phases = createPhaseRunner({ events: recordingEmitter(calls) });

    assert.equal(await phases.run('setup', async () => 7), 7);
    assert.deepEqual(calls, ['setup']);
    assert.equal(phases.current(), 'setup');
  });

  it('keeps reporting a phase whose body failed', async () => {
    const phases = createPhaseRunner({ events: recordingEmitter([]) });

    await assert.rejects(
      phases.run('evidence', async () => {
        throw new Error('boom');
      }),
    );
    assert.equal(phases.current(), 'evidence');
  });
});
