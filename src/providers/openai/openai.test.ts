import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'vitest';
import type { CompletionRequest } from '../../contracts/completion.ts';
import { FORGE_VERSION } from '../../version.ts';
import {
  createOpenAICompletionProvider,
  OPENAI_MAX_RESPONSE_BYTES,
  OpenAICompletionError,
} from './index.ts';

const request = (
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  runId: 'run-1',
  purpose: 'judge',
  model: { provider: 'openai', model: 'gpt-6.1-sol' },
  messages: [{ role: 'user', content: 'Judge this.' }],
  signal: new AbortController().signal,
  responseSchema: {
    name: 'judgment',
    strict: true,
    schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  ...overrides,
});
const context = { credentials: { apiKey: 'test-secret' } };
const response = (overrides: Record<string, unknown> = {}) => ({
  object: 'response',
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"message":"ok"}' }],
    },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 12,
    input_tokens_details: { cached_tokens: 5 },
  },
  ...overrides,
});
const jsonResponse = (value: unknown) => Response.json(value);

function errorCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof OpenAICompletionError &&
    error.code === code &&
    !error.message.includes('test-secret');
}

describe('OpenAI Responses completion provider', () => {
  it('declares independent host credentials and preflights without I/O', async () => {
    const provider = createOpenAICompletionProvider({
      fetch: async () => {
        throw new Error('unexpected I/O');
      },
    });
    assert.equal(provider.version, FORGE_VERSION);
    assert.deepEqual(provider.metadata, { endpoint_mode: 'default' });
    assert.deepEqual(provider.requirements(request()), {
      credentials: { apiKey: { reference: 'openai.completion-api-key' } },
    });
    await provider.preflight?.({
      ...request(),
      credentials: context.credentials,
    });
    assert.throws(
      () =>
        provider.requirements({
          ...request(),
          model: { provider: 'anthropic', model: 'test' },
        }),
      errorCode('invalid_request'),
    );
    await assert.rejects(
      provider.preflight?.({ ...request(), credentials: {} }) as Promise<void>,
      errorCode('invalid_credentials'),
    );
  });

  it('sends strict Responses JSON, preserves conversation and normalizes cached usage over real HTTP', async () => {
    let captured: unknown;
    const server = createServer(async (req, res) => {
      assert.equal(req.url, '/v1/responses');
      assert.equal(req.headers.authorization, 'Bearer test-secret');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      captured = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const provider = createOpenAICompletionProvider({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`,
      });
      const input = request({
        systemPrompt: 'Use JSON.',
        temperature: 0,
        maxTokens: 400,
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Previous' },
          { role: 'user', content: 'Next' },
        ],
      });
      const result = await provider.complete(input, context);
      assert.deepEqual(captured, {
        model: 'gpt-6.1-sol',
        store: false,
        max_output_tokens: 16000,
        input: input.messages,
        instructions: 'Use JSON.',
        text: {
          format: {
            type: 'json_schema',
            name: 'judgment',
            strict: true,
            schema: input.responseSchema?.schema,
          },
        },
      });
      assert.deepEqual(result, {
        content: '{"message":"ok"}',
        stopReason: 'end_turn',
        usage: { inputTokens: 20, outputTokens: 12, cachedInputTokens: 5 },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('retains temperature and exact budgets for non-reasoning model aliases', async () => {
    const provider = createOpenAICompletionProvider({
      fetch: async (_, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.temperature, 0.3);
        assert.equal(body.max_output_tokens, 400);
        return jsonResponse(response());
      },
    });
    await provider.complete(
      request({
        model: { provider: 'openai', model: 'gpt-4.1' },
        maxTokens: 400,
        temperature: 0.3,
      }),
      context,
    );
  });

  it('projects only schema grammar while preserving property names and the original schema', async () => {
    const schema = {
      type: 'object',
      properties: {
        uniqueItems: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'integer', const: 0 },
        },
      },
      required: ['uniqueItems'],
      additionalProperties: false,
    };
    const provider = createOpenAICompletionProvider({
      fetch: async (_, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.text.format.schema.properties.uniqueItems, {
          type: 'array',
          items: { type: 'integer', const: 0 },
        });
        return jsonResponse(response());
      },
    });
    await provider.complete(
      request({ responseSchema: { name: 'nested', strict: true, schema } }),
      context,
    );
    assert.equal(schema.properties.uniqueItems.uniqueItems, true);
  });

  it.each(['max_output_tokens', 'content_filter', 'unknown'])(
    'normalizes incomplete %s responses without repairing partial JSON',
    async (reason) => {
      const provider = createOpenAICompletionProvider({
        fetch: async () =>
          jsonResponse(
            response({
              status: 'incomplete',
              incomplete_details: { reason },
              output: [],
            }),
          ),
      });
      assert.equal(
        (await provider.complete(request(), context)).stopReason,
        reason === 'max_output_tokens'
          ? 'max_tokens'
          : reason === 'content_filter'
            ? 'refusal'
            : 'other',
      );
    },
  );

  it('normalizes explicit refusals', async () => {
    const provider = createOpenAICompletionProvider({
      fetch: async () =>
        jsonResponse(
          response({
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'refusal', refusal: 'Cannot comply.' }],
              },
            ],
          }),
        ),
    });
    assert.equal(
      (await provider.complete(request(), context)).stopReason,
      'refusal',
    );
  });

  it.each([
    response({ status: 'failed', error: { message: 'test-secret' } }),
    response({ output: [{ type: 'function_call' }] }),
    response({ usage: { input_tokens: 1, output_tokens: -1 } }),
    response({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 2 },
      },
    }),
  ])('rejects malformed or unsuccessful responses safely', async (value) => {
    const provider = createOpenAICompletionProvider({
      fetch: async () => jsonResponse(value),
    });
    await assert.rejects(
      provider.complete(request(), context),
      errorCode('invalid_response'),
    );
  });

  it('distinguishes malformed structured model text from an invalid envelope', async () => {
    const provider = createOpenAICompletionProvider({
      fetch: async () =>
        jsonResponse(
          response({
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '```json\n{}\n```' }],
              },
            ],
          }),
        ),
    });
    await assert.rejects(
      provider.complete(request(), context),
      errorCode('invalid_output'),
    );
  });

  it('bounds bodies, classifies transport errors, and never follows redirects', async () => {
    const oversized = createOpenAICompletionProvider({
      fetch: async () =>
        new Response('x'.repeat(OPENAI_MAX_RESPONSE_BYTES + 1)),
    });
    await assert.rejects(
      oversized.complete(request(), context),
      errorCode('response_too_large'),
    );
    const redirect = createOpenAICompletionProvider({
      fetch: async (_, init) => {
        assert.equal(init?.redirect, 'manual');
        return new Response('test-secret', {
          status: 302,
          headers: { location: 'https://other.example' },
        });
      },
    });
    await assert.rejects(
      redirect.complete(request(), context),
      errorCode('http_error'),
    );
    const broken = createOpenAICompletionProvider({
      fetch: async () => {
        throw new Error('test-secret');
      },
    });
    await assert.rejects(
      broken.complete(request(), context),
      errorCode('transport_error'),
    );
  });

  it('handles cancellation and request timeout', async () => {
    const fetch: typeof globalThis.fetch = async (_, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('test-secret')),
          { once: true },
        ),
      );
    const controller = new AbortController();
    const provider = createOpenAICompletionProvider({ fetch, timeoutMs: 20 });
    const pending = provider.complete(
      request({ signal: controller.signal }),
      context,
    );
    controller.abort();
    await assert.rejects(pending, errorCode('aborted'));
    await assert.rejects(
      provider.complete(request(), context),
      errorCode('timeout'),
    );
  });

  it('bounds response reading even when the response stream stalls', async () => {
    let canceled = false;
    const provider = createOpenAICompletionProvider({
      timeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
        ),
    });
    await assert.rejects(
      provider.complete(request(), context),
      errorCode('timeout'),
    );
    assert.equal(canceled, true);
  });

  it('rejects malformed requests before dispatch and validates endpoint security', async () => {
    const provider = createOpenAICompletionProvider({
      fetch: async () => {
        throw new Error('must not dispatch');
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const overrides of [
      { maxTokens: -1 },
      { temperature: Number.NaN },
      { messages: [] },
      {
        responseSchema: { name: 'bad', strict: true as const, schema: cyclic },
      },
    ]) {
      await assert.rejects(
        provider.complete(request(overrides), context),
        errorCode('invalid_request'),
      );
    }
    for (const baseUrl of [
      'http://remote.example/v1',
      'https://user:secret@example.com',
      'https://example.com/?key=secret',
      'https://example.com/#fragment',
    ]) {
      assert.throws(
        () => createOpenAICompletionProvider({ baseUrl }),
        TypeError,
      );
    }
    assert.throws(
      () => createOpenAICompletionProvider({ timeoutMs: 300001 }),
      TypeError,
    );
  });
});
