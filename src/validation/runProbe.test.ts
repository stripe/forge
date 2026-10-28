import assert from 'node:assert/strict';
import { afterEach, it, vi } from 'vitest';
import { credentialReference } from '../contracts/credentials.ts';
import type { ModelProbe } from '../contracts/modelProbe.ts';
import { createStaticCredentialResolver } from '../testing/index.ts';
import { createHttpModelProbe } from './httpProbe.ts';
import { MODEL_PROBE_LIMITS } from './limits.ts';
import { normalizeProbeResult, runModelProbe } from './runProbe.ts';

const resolver = createStaticCredentialResolver({ key: 'secret-value' });
const signal = new AbortController().signal;
afterEach(() => vi.useRealTimers());

it('enforces deadlines through stalled credentials, fetch, response reads, and custom probes', async () => {
  vi.useFakeTimers();
  for (const stage of ['credentials', 'fetch', 'body', 'custom'] as const) {
    const hang = () => new Promise<never>(() => undefined);
    const probe: ModelProbe =
      stage === 'custom'
        ? { endpoint: 'https://models.example', run: hang }
        : createHttpModelProbe({
            endpoint: 'https://models.example',
            credential: credentialReference('key'),
            headers: () => ({}),
            body: '{}',
            accepts: () => true,
            fetch:
              stage === 'fetch'
                ? hang
                : async () => new Response(new ReadableStream({ pull: hang })),
          });
    const pending = runModelProbe(
      probe,
      stage === 'credentials' ? { resolve: hang } : resolver,
      signal,
    );
    await vi.advanceTimersByTimeAsync(MODEL_PROBE_LIMITS.timeoutMs);
    assert.deepEqual(
      await pending,
      { outcome: 'timeout', reason: 'deadline_exceeded' },
      stage,
    );
    assert.deepEqual(
      await runModelProbe(
        { endpoint: '', run: async () => ({ outcome: 'ok' }) },
        resolver,
        signal,
      ),
      { outcome: 'ok' },
    );
    assert.equal(vi.getTimerCount(), 0);
  }
});

it('honors a lower configured provider deadline and isolates late rejections', async () => {
  vi.useFakeTimers();
  let fail: (error: Error) => void = () => undefined;
  let probeSignal: AbortSignal | undefined;
  const pending = runModelProbe(
    {
      endpoint: '',
      timeoutMs: 10,
      run: async ({ signal }) => {
        probeSignal = signal;
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      },
    },
    resolver,
    signal,
  );
  await vi.advanceTimersByTimeAsync(10);
  assert.deepEqual(await pending, {
    outcome: 'timeout',
    reason: 'deadline_exceeded',
  });
  assert.equal(probeSignal?.aborted, true);
  fail(new Error('secret-value'));
  await vi.advanceTimersByTimeAsync(0);
});

it('bounds exceptions, strips extra fields and rejects unknown result values', async () => {
  assert.deepEqual(
    await runModelProbe(
      {
        endpoint: '',
        run: async () => {
          throw new Error('secret-value');
        },
      },
      resolver,
      signal,
    ),
    {
      outcome: 'other',
      reason: 'probe_failed',
    },
  );
  for (const result of [
    null,
    'ok',
    {},
    { outcome: 'secret-value' },
    { outcome: 'other', reason: 'secret-value' },
    { outcome: 'other', http_status: 1000 },
  ]) {
    assert.deepEqual(normalizeProbeResult(result), {
      outcome: 'other',
      reason: 'invalid_probe_result',
    });
  }
  assert.deepEqual(
    normalizeProbeResult({
      outcome: 'other',
      reason: 'http_error',
      http_status: 400,
      body: 'secret-value',
      endpoint: 'https://models.example',
    }),
    {
      outcome: 'other',
      reason: 'http_error',
      http_status: 400,
    },
  );
});

it('preserves caller cancellation even when the capability ignores it', async () => {
  const controller = new AbortController();
  const pending = runModelProbe(
    { endpoint: '', run: async () => new Promise(() => undefined) },
    resolver,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

it('does not send a late request after credential lookup exceeds its deadline', async () => {
  vi.useFakeTimers();
  let resolveKey: (key: string) => void = () => undefined;
  let calls = 0;
  const pending = runModelProbe(
    createHttpModelProbe({
      endpoint: 'https://models.example',
      credential: credentialReference('key'),
      body: '{}',
      headers: () => ({}),
      accepts: () => true,
      fetch: async () => {
        calls++;
        return new Response('{}');
      },
    }),
    {
      resolve: async () =>
        new Promise((resolve) => {
          resolveKey = resolve;
        }),
    },
    signal,
  );
  await vi.advanceTimersByTimeAsync(MODEL_PROBE_LIMITS.timeoutMs);
  assert.equal((await pending).outcome, 'timeout');
  resolveKey('secret-value');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(calls, 0);
});

it('does not wait for uncooperative response cleanup', async () => {
  const probe = createHttpModelProbe({
    endpoint: 'https://models.example',
    credential: credentialReference('key'),
    body: '{}',
    headers: () => ({}),
    accepts: () => true,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(MODEL_PROBE_LIMITS.responseBytes + 1),
            );
          },
          cancel: async () => new Promise(() => undefined),
        }),
      ),
  });
  assert.deepEqual(await runModelProbe(probe, resolver, signal), {
    outcome: 'other',
    reason: 'invalid_response',
    http_status: 200,
  });
});
