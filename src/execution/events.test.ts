import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {createRunEventEmitter} from './events.js';

describe('run events', () => {
  it('orders sanitized lifecycle events and isolates observer failures', async () => {
    const observed: string[] = [];
    const emitter = createRunEventEmitter(
      'run-1',
      [
        {
          observe: (event) => {
            observed.push(`${event.sequence}:${event.type}`);
          },
        },
        {
          async observe() {
            throw new Error('observer failed');
          },
        },
      ],
      () => new Date('2026-09-15T00:00:00Z'),
    );

    await expect(emitter.phase('preflight', async () => 42)).resolves.toBe(42);
    expect(observed).toEqual(['0:phase_started', '1:phase_completed']);
  });
});
