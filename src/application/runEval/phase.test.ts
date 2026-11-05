import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { RunPhase } from '../../contracts/observability.ts';
import { ForgeExecutionError } from '../../execution/errors.ts';
import type { RunEventEmitter } from '../../execution/events.ts';

import { createPhaseRunner } from './phase.ts';

const recordingEmitter = (calls: RunPhase[]): RunEventEmitter => ({
  phase: (phase, operation) => {
    calls.push(phase);
    return operation();
  },
});

describe('phase runner', () => {
  it('runs each phase through the emitter and reports the latest phase', async () => {
    const calls: RunPhase[] = [];
    const phases = createPhaseRunner({
      events: recordingEmitter(calls),
      signal: new AbortController().signal,
    });

    assert.equal(phases.current(), 'preflight');
    assert.equal(await phases.run('setup', async () => 7), 7);
    assert.deepEqual(calls, ['setup']);
    assert.equal(phases.current(), 'setup');
  });

  it('rejects an abortable phase with that phase once aborted, without running it', async () => {
    const controller = new AbortController();
    controller.abort();
    const phases = createPhaseRunner({
      events: recordingEmitter([]),
      signal: controller.signal,
    });
    let ran = false;

    await assert.rejects(
      phases.run(
        'interaction',
        async () => {
          ran = true;
        },
        { abortable: true },
      ),
      (error: unknown) =>
        error instanceof ForgeExecutionError &&
        error.code === 'aborted' &&
        error.phase === 'interaction',
    );
    assert.equal(ran, false);
  });

  it('runs a phase that is not abortable even after an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const phases = createPhaseRunner({
      events: recordingEmitter([]),
      signal: controller.signal,
    });

    assert.equal(await phases.run('result_commit', async () => 'done'), 'done');
  });
});
