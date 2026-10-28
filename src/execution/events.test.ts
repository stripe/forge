import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { RunEvent } from '../contracts/observability.ts';

import { createRunEventEmitter } from './events.ts';

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

    assert.equal(await emitter.phase('preflight', async () => 42), 42);
    await emitter.warning('runtime_dispose', 'Runtime cleanup failed.');
    const operationFailure = new Error('setup operation failed');
    await assert.rejects(
      emitter.phase('setup', async () => {
        throw operationFailure;
      }),
      (error: unknown) => error === operationFailure,
    );

    const common = { runId: 'run-1', timestamp: '2026-09-15T00:00:00.000Z' };
    assert.deepEqual(observed, [
      { ...common, sequence: 0, type: 'phase_started', phase: 'preflight' },
      { ...common, sequence: 1, type: 'phase_completed', phase: 'preflight' },
      {
        ...common,
        sequence: 2,
        type: 'warning',
        phase: 'runtime_dispose',
        message: 'Runtime cleanup failed.',
      },
      { ...common, sequence: 3, type: 'phase_started', phase: 'setup' },
    ]);
  });
});

it('isolates observers of usage and freezes counters before delivery', async () => {
  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_tokens: null,
  };
  const observed: RunEvent[] = [];
  const emitter = createRunEventEmitter(
    'run-1',
    [
      {
        observe(event) {
          if (event.type === 'agent_usage')
            Object.assign(event.usage, { input_tokens: 999 });
        },
      },
      {
        observe(event) {
          observed.push(event);
        },
      },
    ],
    () => new Date('2026-01-01T00:00:00Z'),
  );
  await emitter.agentUsage(2, usage);
  usage.input_tokens = 10;
  assert.deepEqual(observed, [
    {
      runId: 'run-1',
      sequence: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'agent_usage',
      phase: 'interaction',
      turn: 2,
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_tokens: null,
      },
    },
  ]);
});
