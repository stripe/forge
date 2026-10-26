import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { observeCompletionFailure } from './transportObservation.ts';

const signal = new AbortController().signal;
describe('host transport observations', () => {
  it('normalizes seconds and dates and clamps waits', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    for (const [header, expected] of [
      ['1.5', 1500],
      ['999999', 64000],
      ['Thu, 01 Jan 2026 00:00:30 GMT', 30000],
      ['Wed, 31 Dec 2025 00:00:00 GMT', 0],
      ['nonsense', undefined],
      ['-1', undefined],
      ['2026-01-01', undefined],
    ] as const) {
      const observed = await observeCompletionFailure(
        new Response('{}', {
          status: 429,
          headers: { 'retry-after': header },
        }),
        'openai',
        signal,
        now,
      );
      assert.equal(observed.retry_after_ms, expected);
    }
  });

  it('only accepts the provider request-ID header and a safe bounded value', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      const header = provider === 'openai' ? 'x-request-id' : 'request-id';
      for (const id of [
        'request_123-abc',
        'secret with spaces',
        'https://example.com',
        'x'.repeat(129),
        'a,b',
      ]) {
        const observed = await observeCompletionFailure(
          new Response('{}', {
            status: 400,
            headers: { [header]: id, 'request-trace': 'arbitrary' },
          }),
          provider,
          signal,
        );
        assert.equal(
          observed.request_id,
          id === 'request_123-abc' ? id : undefined,
        );
        assert.deepEqual(
          Object.keys(observed).sort(),
          id === 'request_123-abc'
            ? ['http_status', 'origin', 'request_id']
            : ['http_status', 'origin'],
        );
      }
    }
  });

  it('discards messages, unknown codes, malformed and oversized bodies', async () => {
    for (const [body, expected] of [
      [
        JSON.stringify({
          error: {
            code: 'rate_limit_exceeded',
            type: 'rate_limit_error',
            message: 'private body',
          },
        }),
        'rate_limit_exceeded',
      ],
      [
        JSON.stringify({
          error: { code: 'private_code', type: 'authentication_error' },
        }),
        'authentication_error',
      ],
      [
        JSON.stringify({
          error: { code: 'private_code', type: 'private_type' },
        }),
        undefined,
      ],
      ['{broken', undefined],
      [
        JSON.stringify({
          padding: 'x'.repeat(17000),
          error: { type: 'rate_limit_error' },
        }),
        undefined,
      ],
    ] as const) {
      const observed = await observeCompletionFailure(
        new Response(body, { status: 429 }),
        'openai',
        signal,
      );
      assert.equal(observed.provider_error_code, expected);
      assert.doesNotMatch(JSON.stringify(observed), /private|padding|message/);
    }
  });

  it('cancels a stalled failure body on abort while preserving status', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const pending = observeCompletionFailure(
      new Response(body, { status: 503 }),
      'openai',
      controller.signal,
    );
    controller.abort();
    assert.equal((await pending).http_status, 503);
    assert.equal(cancelled, true);
  });
});

describe('built-in provider failure observations', () => {
  it('carries only allowlisted failure facts through both provider error classes', async () => {
    const { createOpenAICompletionProvider } = await import(
      './openai/index.ts'
    );
    const { createAnthropicCompletionProvider } = await import(
      './anthropic/index.ts'
    );
    for (const provider of [
      createOpenAICompletionProvider({
        fetch: async () =>
          new Response(
            '{"error":{"code":"rate_limit_exceeded","message":"private response"}}',
            {
              status: 429,
              headers: {
                'retry-after': '20',
                'x-request-id': 'req_openai',
                authorization: 'private-header',
              },
            },
          ),
      }),
      createAnthropicCompletionProvider({
        fetch: async () =>
          new Response(
            '{"error":{"type":"rate_limit_error","message":"private response"}}',
            {
              status: 429,
              headers: {
                'retry-after': '20',
                'request-id': 'req_anthropic',
                authorization: 'private-header',
              },
            },
          ),
      }),
    ]) {
      await assert.rejects(
        provider.complete(
          {
            runId: 'test',
            purpose: 'judge',
            model: {
              provider: provider.id,
              model:
                provider.id === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6',
            },
            messages: [{ role: 'user', content: 'Synthetic prompt' }],
            signal,
          },
          { credentials: { apiKey: 'synthetic-key' } },
        ),
        (error) => {
          assert.ok(error instanceof Error && 'observation' in error);
          assert.deepEqual(error.observation, {
            origin: 'host_transport',
            http_status: 429,
            retry_after_ms: 20000,
            request_id: `req_${provider.id}`,
            provider_error_code:
              provider.id === 'openai'
                ? 'rate_limit_exceeded'
                : 'rate_limit_error',
          });
          assert.doesNotMatch(
            JSON.stringify(error),
            /private|Synthetic prompt|synthetic-key/,
          );
          return true;
        },
      );
    }
  });
});
