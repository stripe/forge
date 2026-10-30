import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { RunEvent } from '../contracts/observability.ts';

import { createRunEventEmitter } from './events.ts';

describe('run events', () => {
  it('orders lifecycle events and isolates synchronous and asynchronous observer failures', async () => {
    const observed: RunEvent[] = [];
    const emitter = createRunEventEmitter([
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
    ]);

    assert.equal(await emitter.phase('preflight', async () => 42), 42);
    const operationFailure = new Error('setup operation failed');
    await assert.rejects(
      emitter.phase('setup', async () => {
        throw operationFailure;
      }),
      (error: unknown) => error === operationFailure,
    );

    assert.deepEqual(observed, [
      { type: 'phase_started', phase: 'preflight' },
      { type: 'phase_completed', phase: 'preflight' },
      { type: 'phase_started', phase: 'setup' },
    ]);
  });
});
