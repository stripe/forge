import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import type {RunEvent} from '../contracts/observability.js';

import {createRunEventEmitter} from './events.js';

describe('run events', () => {
  it('orders lifecycle events and isolates synchronous and asynchronous observer failures', async () => {
    const observed: RunEvent[] = [];
    const emitter = createRunEventEmitter(
      'run-1',
      [
        {
          observe: (event) => {
            observed.push(event);
          },
        },
        {
          async observe() {
            throw new Error('observer failed');
          },
        },
        {
          observe() {
            throw new Error('synchronous observer failed');
          },
        },
      ],
      () => new Date('2026-09-15T00:00:00Z'),
    );

    await expect(emitter.phase('preflight', async () => 42)).resolves.toBe(42);
    await emitter.warning('runtime_dispose', 'Runtime cleanup failed.');
    const operationFailure = new Error('setup operation failed');
    await assert.rejects(
      emitter.phase('setup', async () => {throw operationFailure;}),
      (error: unknown) => error === operationFailure,
    );

    const common = {runId: 'run-1', timestamp: '2026-09-15T00:00:00.000Z'};
    expect(observed).toEqual([
      {...common, sequence: 0, type: 'phase_started', phase: 'preflight'},
      {...common, sequence: 1, type: 'phase_completed', phase: 'preflight'},
      {
        ...common,
        sequence: 2,
        type: 'warning',
        phase: 'runtime_dispose',
        message: 'Runtime cleanup failed.',
      },
      {...common, sequence: 3, type: 'phase_started', phase: 'setup'},
    ]);
  });
});
