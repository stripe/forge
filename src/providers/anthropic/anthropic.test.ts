import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'vitest';
import type {
  CompletionRequest,
  StrictCompletionResponseSchema,
} from '../../contracts/completion.ts';
import { FORGE_VERSION } from '../../version.ts';
import {
  ANTHROPIC_API_KEY_CREDENTIAL,
  ANTHROPIC_AUTH_TOKEN_CREDENTIAL,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_MAX_MESSAGE_BYTES,
  ANTHROPIC_MAX_REQUEST_BYTES,
  ANTHROPIC_MAX_RESPONSE_BYTES,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_MESSAGES_API_VERSION,
  ANTHROPIC_STRUCTURED_OUTPUT_FORMAT,
  AnthropicCompletionError,
  createAnthropicCompletionProvider,
  supportsAnthropicStructuredOutputModel,
} from './index.ts';

const schema: StrictCompletionResponseSchema = {
  name: 'ava_turn',
  description: 'One structured Ava turn.',
  strict: true,
  schema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};

describe('Anthropic completion provider', () => {
  it('purely declares direct API credentials and validates preflight inputs', async () => {
    let fetchCalls = 0;
    const provider = createAnthropicCompletionProvider({
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('must not fetch');
      },
    });

    assert.equal(provider.id, 'anthropic');
    assert.equal(provider.version, FORGE_VERSION);
    assert.deepEqual(provider.metadata, { endpoint_mode: 'default' });
    assert.deepEqual(
      provider.requirements({
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        purpose: 'judge',
      }),
      {
        credentials: {
          [ANTHROPIC_API_KEY_CREDENTIAL]: { reference: 'anthropic.api-key' },
        },
      },
    );
    await provider.preflight?.({
      runId: 'run-1',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      purpose: 'judge',
      credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      signal: new AbortController().signal,
    });
    assert.equal(fetchCalls, 0);
  });

  it('sends a strict Messages request and normalizes usage without exposing credentials', async () => {
    const transport = recordingFetch(() =>
      messageResponse({
        content: '{"message":"continue"}',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          cost_usd: 0.125,
        },
      }),
    );
    const provider = createAnthropicCompletionProvider({
      fetch: transport.fetch,
    });

    const response = await provider.complete(
      completionRequest({
        systemPrompt: 'Act as a role player.',
        temperature: 0.3,
        maxTokens: 400,
        responseSchema: schema,
      }),
      { credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' } },
    );

    assert.deepEqual(response, {
      content: '{"message":"continue"}',
      stopReason: 'end_turn',
      usage: { inputTokens: 15, outputTokens: 4, cachedInputTokens: 3 },
      costUsd: 0.125,
    });
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0]!;
    assert.equal(call.url, `${ANTHROPIC_DEFAULT_BASE_URL}/v1/messages`);
    assert.equal(call.init.method, 'POST');
    const headers = new Headers(call.init.headers);
    assert.equal(
      headers.get('anthropic-version'),
      ANTHROPIC_MESSAGES_API_VERSION,
    );
    assert.equal(headers.get('x-api-key'), 'test-direct-key');
    assert.equal(headers.has('authorization'), false);
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [
        { role: 'user', content: 'Do the task.' },
        { role: 'assistant', content: 'I inspected it.' },
        { role: 'user', content: 'Finish it.' },
      ],
      system: 'Act as a role player.',
      temperature: 0.3,
      output_config: {
        format: {
          type: ANTHROPIC_STRUCTURED_OUTPUT_FORMAT,
          schema: schema.schema,
        },
      },
    });
  });

  it('omits temperature for Claude models that require default sampling on direct and gateway requests', async () => {
    for (const [model, samplingTemperature] of [
      ['claude-sonnet-4-6', true],
      ['claude-opus-4-6', true],
      ['claude-haiku-4-5', true],
      ['claude-sonnet-4-7', true],
      ['claude-opus-4-7', false],
      ['claude-opus-4-8', false],
      ['claude-opus-4-7-20261001', false],
      ['claude-sonnet-5-5', false],
      ['claude-opus-5-5', false],
      ['claude-haiku-5', false],
      ['anthropic/claude-sonnet-5', false],
      ['gateway/claude-opus-4.7', false],
      ['claude-sonnet-6-0', false],
    ] as const) {
      for (const gateway of [false, true]) {
        const transport = recordingFetch(() =>
          messageResponse({ content: '{"message":"continue"}' }),
        );
        const provider = createAnthropicCompletionProvider({
          ...(gateway
            ? { baseUrl: 'https://gateway.example.test/anthropic' }
            : {}),
          fetch: transport.fetch,
        });
        for (const [purpose, temperature] of [
          ['role_player', 0.3],
          ['judge', 0],
        ] as const) {
          const request = completionRequest({
            model: { provider: 'anthropic', model },
            purpose,
            temperature,
            responseSchema: schema,
          });
          await provider.complete(request, {
            credentials: {
              [gateway
                ? ANTHROPIC_AUTH_TOKEN_CREDENTIAL
                : ANTHROPIC_API_KEY_CREDENTIAL]: 'test-scoped-key',
            },
          });
          const body = JSON.parse(String(transport.calls.at(-1)!.init.body));
          assert.equal(
            Object.hasOwn(body, 'temperature'),
            samplingTemperature,
            model,
          );
          if (samplingTemperature)
            assert.equal(body.temperature, temperature, model);
          assert.equal(request.temperature, temperature);
        }
      }
    }
  });

  it('raises output caps for always-thinking Claude models on direct and gateway requests', async () => {
    for (const [model, alwaysThinks] of [
      ['claude-sonnet-4-6', false],
      ['claude-opus-4-8', false],
      ['claude-sonnet-5-5', true],
      ['anthropic/claude-opus-5-5', true],
      ['claude-haiku-5', true],
      ['gateway/claude-sonnet-5.5', true],
      ['claude-opus-6-0', true],
    ] as const) {
      for (const gateway of [false, true]) {
        const transport = recordingFetch(() => messageResponse());
        const provider = createAnthropicCompletionProvider({
          ...(gateway
            ? { baseUrl: 'https://gateway.example.test/anthropic' }
            : {}),
          fetch: transport.fetch,
        });
        for (const purpose of ['role_player', 'judge'] as const) {
          for (const maxTokens of [
            undefined,
            400,
            700,
            1_024,
            16_000,
            ANTHROPIC_MAX_TOKENS,
          ]) {
            const request = completionRequest({
              model: { provider: 'anthropic', model },
              purpose,
              ...(maxTokens === undefined ? {} : { maxTokens }),
            });
            await provider.complete(request, {
              credentials: {
                [gateway
                  ? ANTHROPIC_AUTH_TOKEN_CREDENTIAL
                  : ANTHROPIC_API_KEY_CREDENTIAL]: 'test-scoped-key',
              },
            });
            const body = JSON.parse(String(transport.calls.at(-1)!.init.body));
            const requested = maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
            assert.equal(
              body.max_tokens,
              alwaysThinks ? Math.max(requested, 16_000) : requested,
              model,
            );
            assert.equal(request.maxTokens, maxTokens);
          }
        }
      }
    }
  });

  it('excludes thinking blocks from plain and structured answers while retaining output usage', async () => {
    for (const model of ['claude-sonnet-4-6', 'claude-sonnet-5-5']) {
      for (const structured of [false, true]) {
        const provider = createAnthropicCompletionProvider({
          fetch: async () =>
            Response.json({
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: '', signature: 'signature' },
                { type: 'redacted_thinking', data: 'private-redacted-data' },
                { type: 'text', text: '{"message":' },
                { type: 'thinking', thinking: 'private-thought' },
                { type: 'text', text: '"continue"}' },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 100 },
            }),
        });
        const response = await provider.complete(
          completionRequest({
            model: { provider: 'anthropic', model },
            ...(structured ? { responseSchema: schema } : {}),
          }),
          { credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' } },
        );
        assert.deepEqual(response, {
          content: '{"message":"continue"}',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 100, cachedInputTokens: 0 },
        });
      }
    }
  });

  it('recursively projects unsupported constraints without mutating the neutral schema', async () => {
    const neutralSchema: StrictCompletionResponseSchema = {
      name: 'bounded_result',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            pattern: '\\S',
          },
          score: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            multipleOf: 0.25,
          },
          needs: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            uniqueItems: true,
            items: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 240,
                },
              },
              required: ['description'],
              additionalProperties: false,
            },
          },
          optional_items: {
            type: 'array',
            minItems: 0,
            items: { type: 'string' },
          },
          required_items: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
        },
        allOf: [
          { $ref: '#/$defs/non_negative' },
          { properties: { score: { type: 'number', maximum: 1 } } },
        ],
        $defs: {
          non_negative: { type: 'number', minimum: 0 },
        },
        required: ['summary', 'score', 'needs'],
        additionalProperties: false,
      },
    };
    const originalSchema = structuredClone(neutralSchema);
    const transport = recordingFetch(() =>
      messageResponse({ content: '{"summary":"done","score":1,"needs":[]}' }),
    );
    const provider = createAnthropicCompletionProvider({
      fetch: transport.fetch,
    });

    await provider.complete(
      completionRequest({ responseSchema: neutralSchema }),
      {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      },
    );

    const body = JSON.parse(String(transport.calls[0]?.init.body));
    assert.deepEqual(body.output_config.format.schema, {
      type: 'object',
      properties: {
        summary: { type: 'string', pattern: '\\S' },
        score: { type: 'number' },
        needs: {
          type: 'array',
          items: {
            type: 'object',
            properties: { description: { type: 'string' } },
            required: ['description'],
            additionalProperties: false,
          },
        },
        optional_items: {
          type: 'array',
          minItems: 0,
          items: { type: 'string' },
        },
        required_items: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
        },
      },
      allOf: [
        { $ref: '#/$defs/non_negative' },
        { properties: { score: { type: 'number' } } },
      ],
      $defs: { non_negative: { type: 'number' } },
      required: ['summary', 'score', 'needs'],
      additionalProperties: false,
    });
    assert.deepEqual(neutralSchema, originalSchema);
  });

  it('uses bearer authentication for a Messages-compatible base URL', async () => {
    const transport = recordingFetch(() =>
      messageResponse({ stopReason: 'future_safe_reason' }),
    );
    const provider = createAnthropicCompletionProvider({
      id: 'stripe-gateway',
      baseUrl: 'http://127.0.0.1:4321/anthropic/',
      credential: 'stripe.gateway-token',
      fetch: transport.fetch,
    });

    assert.equal(provider.version, FORGE_VERSION);
    assert.deepEqual(provider.metadata, { endpoint_mode: 'custom' });
    assert.deepEqual(
      provider.requirements({
        model: { provider: 'stripe-gateway', model: 'claude-opus-4-6' },
        purpose: 'role_player',
      }),
      {
        credentials: {
          [ANTHROPIC_AUTH_TOKEN_CREDENTIAL]: {
            reference: 'stripe.gateway-token',
          },
        },
      },
    );
    const response = await provider.complete(
      completionRequest({
        model: { provider: 'stripe-gateway', model: 'claude-opus-4-6' },
      }),
      {
        credentials: {
          [ANTHROPIC_AUTH_TOKEN_CREDENTIAL]: 'test-gateway-token',
        },
      },
    );

    assert.equal(response.stopReason, 'other');
    assert.equal(
      transport.calls[0]?.url,
      'http://127.0.0.1:4321/anthropic/v1/messages',
    );
    const headers = new Headers(transport.calls[0]?.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-gateway-token');
    assert.equal(headers.has('x-api-key'), false);
    assert.equal(
      JSON.parse(String(transport.calls[0]?.init.body)).max_tokens,
      ANTHROPIC_DEFAULT_MAX_TOKENS,
    );
  });

  it('supports an explicit API-key scheme for a custom HTTPS endpoint', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({
      baseUrl: 'https://gateway.example.test/anthropic',
      auth: 'api-key',
      credential: 'gateway.api-key',
      fetch: transport.fetch,
    });

    assert.deepEqual(
      provider.requirements({
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        purpose: 'judge',
      }),
      {
        credentials: {
          [ANTHROPIC_API_KEY_CREDENTIAL]: { reference: 'gateway.api-key' },
        },
      },
    );
    await provider.complete(completionRequest(), {
      credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'custom-api-key' },
    });
    const headers = new Headers(transport.calls[0]?.init.headers);
    assert.equal(headers.get('x-api-key'), 'custom-api-key');
    assert.equal(headers.has('authorization'), false);
  });

  it('uses native HTTP transport and reconstructs fragmented UTF-8 text blocks', async (t) => {
    let recordedRequest:
      | {
          method: string | undefined;
          url: string | undefined;
          headers: IncomingHttpHeaders;
          body: unknown;
        }
      | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      recordedRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      const bytes = Buffer.from(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: '{"message":"' },
            { type: 'text', text: '漢字"}' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
      const split = bytes.indexOf(Buffer.from('漢')) + 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(bytes.subarray(0, split));
      setImmediate(() => response.end(bytes.subarray(split)));
    });
    const baseUrl = await listenLoopback(server);
    t.onTestFinished(() => closeServer(server));
    const provider = createAnthropicCompletionProvider({
      baseUrl: `${baseUrl}/gateway/`,
      auth: 'api-key',
      timeoutMs: 5_000,
    });
    const result = await provider.complete(
      completionRequest({ responseSchema: schema }),
      {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'synthetic-local-key' },
      },
    );

    assert.deepEqual(result, {
      content: '{"message":"漢字"}',
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 },
    });
    assert.equal(recordedRequest?.method, 'POST');
    assert.equal(recordedRequest?.url, '/gateway/v1/messages');
    assert.equal(recordedRequest?.headers['x-api-key'], 'synthetic-local-key');
    assert.equal(recordedRequest?.headers.authorization, undefined);
    assert.deepEqual(recordedRequest?.body, {
      model: 'claude-sonnet-4-6',
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: completionRequest().messages,
      output_config: { format: { type: 'json_schema', schema: schema.schema } },
    });
  });

  it('aborts native HTTP body reads after response headers arrive', async (t) => {
    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"type":"message",');
    });
    const baseUrl = await listenLoopback(server);
    t.onTestFinished(() => closeServer(server));
    const controller = new AbortController();
    const provider = createAnthropicCompletionProvider({
      baseUrl,
      timeoutMs: 5_000,
      fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init);
        responseStarted();
        return response;
      },
    });
    const completion = provider.complete(
      completionRequest({ signal: controller.signal }),
      {
        credentials: {
          [ANTHROPIC_AUTH_TOKEN_CREDENTIAL]: 'synthetic-local-token',
        },
      },
    );

    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error('private caller cancellation reason'));
    const error = await captureRejection(completion);
    assert.equal(hasCode(error, 'aborted'), true);
    assert.doesNotMatch(String(error), /private caller cancellation reason/);
  });

  it('rejects native HTTP redirects without forwarding either credential scheme', async (t) => {
    let destinationRequests = 0;
    const destination = createServer((_request, response) => {
      destinationRequests += 1;
      response.end('unexpected redirected request');
    });
    const destinationUrl = await listenLoopback(destination);
    t.onTestFinished(() => closeServer(destination));
    let sourceRequests = 0;
    const source = createServer((_request, response) => {
      sourceRequests += 1;
      response.writeHead(307, {
        location: `${destinationUrl}/different-origin`,
      });
      response.end('private redirect response body');
    });
    const baseUrl = await listenLoopback(source);
    t.onTestFinished(() => closeServer(source));

    for (const auth of ['api-key', 'bearer'] as const) {
      const credentialName =
        auth === 'api-key'
          ? ANTHROPIC_API_KEY_CREDENTIAL
          : ANTHROPIC_AUTH_TOKEN_CREDENTIAL;
      const provider = createAnthropicCompletionProvider({
        baseUrl,
        auth,
        timeoutMs: 5_000,
      });
      const error = await captureRejection(
        provider.complete(completionRequest(), {
          credentials: { [credentialName]: 'synthetic-scoped-secret' },
        }),
      );

      assert.equal(hasCode(error, 'http_error'), true);
      assert.match(String(error), /HTTP 307/);
      assert.doesNotMatch(
        String(error),
        /synthetic-scoped-secret|private redirect response body/,
      );
    }
    assert.equal(sourceRequests, 2);
    assert.equal(destinationRequests, 0);
  });

  it('rejects provider mismatches and unsupported structured-output models before fetch', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({
      fetch: transport.fetch,
    });

    assert.throws(
      () =>
        provider.requirements({
          model: { provider: 'openai', model: 'claude-sonnet-4-6' },
          purpose: 'judge',
        }),
      (error) => hasCode(error, 'invalid_request'),
    );
    await rejectsWithCode(
      provider.complete(
        completionRequest({
          model: { provider: 'anthropic', model: 'claude-sonnet-4-4' },
          responseSchema: schema,
        }),
        { credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' } },
      ),
      'invalid_request',
    );
    await rejectsWithCode(
      provider.complete(
        completionRequest({ maxTokens: ANTHROPIC_MAX_TOKENS + 1 }),
        { credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' } },
      ),
      'invalid_request',
    );
    await rejectsWithCode(
      provider.complete(
        completionRequest({
          messages: [
            {
              role: 'user',
              content: 'é'.repeat(ANTHROPIC_MAX_MESSAGE_BYTES / 2 + 1),
            },
          ],
        }),
        { credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' } },
      ),
      'invalid_request',
    );
    assert.equal(transport.calls.length, 0);
  });

  it('bounds the complete serialized request after individually bounded messages', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({
      fetch: transport.fetch,
    });
    const messages = Array.from({ length: 4 }, () => ({
      role: 'user' as const,
      content: 'x'.repeat(ANTHROPIC_MAX_MESSAGE_BYTES),
    }));
    messages[3]!.content = '';
    const overhead = Buffer.byteLength(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        messages,
      }),
    );
    messages[3]!.content = 'x'.repeat(ANTHROPIC_MAX_REQUEST_BYTES - overhead);
    await provider.complete(completionRequest({ messages }), {
      credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
    });
    assert.equal(
      Buffer.byteLength(String(transport.calls[0]?.init.body)),
      ANTHROPIC_MAX_REQUEST_BYTES,
    );

    messages[3]!.content += 'x';
    await rejectsWithCode(
      provider.complete(completionRequest({ messages }), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      }),
      'invalid_request',
    );
    assert.equal(transport.calls.length, 1);
  });

  it('rejects cyclic and excessively nested response schemas before fetch', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({
      fetch: transport.fetch,
    });
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    let nested: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 101; depth += 1) nested = { items: nested };

    for (const invalid of [cyclic, nested]) {
      await rejectsWithCode(
        provider.complete(
          completionRequest({
            responseSchema: { ...schema, schema: invalid },
          }),
          {
            credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
          },
        ),
        'invalid_request',
      );
    }
    assert.equal(transport.calls.length, 0);
  });

  it('rejects missing, extra, or unsafe credentials before fetch', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({
      fetch: transport.fetch,
    });

    for (const credentials of [
      {},
      { [ANTHROPIC_API_KEY_CREDENTIAL]: 'key', extra: 'extra' },
      { [ANTHROPIC_API_KEY_CREDENTIAL]: 'unsafe\nkey' },
    ]) {
      await rejectsWithCode(
        provider.complete(completionRequest(), { credentials }),
        'invalid_credentials',
      );
    }
    assert.equal(transport.calls.length, 0);
  });

  it('combines the caller signal with a configurable lower timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider = createAnthropicCompletionProvider({
      timeoutMs: 5,
      fetch: (async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((resolve, reject) => {
          const fallback = setTimeout(() => resolve(messageResponse()), 1_000);
          const rejectOnAbort = (): void => {
            clearTimeout(fallback);
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (receivedSignal?.aborted) {
            rejectOnAbort();
          } else {
            receivedSignal?.addEventListener('abort', rejectOnAbort, {
              once: true,
            });
          }
        });
      }) as typeof fetch,
    });

    await rejectsWithCode(
      provider.complete(completionRequest(), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      }),
      'timeout',
    );
    assert.equal(receivedSignal?.aborted, true);

    const controller = new AbortController();
    controller.abort();
    await rejectsWithCode(
      provider.complete(completionRequest({ signal: controller.signal }), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      }),
      'aborted',
    );
  });

  it('bounds streamed response bytes before parsing', async () => {
    let pulledChunks = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulledChunks += 1;
          controller.enqueue(
            new Uint8Array(
              pulledChunks === 1 ? ANTHROPIC_MAX_RESPONSE_BYTES : 1,
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const provider = createAnthropicCompletionProvider({
      fetch: async () => new Response(stream, { status: 200 }),
    });

    await rejectsWithCode(
      provider.complete(completionRequest(), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      }),
      'response_too_large',
    );
    assert.equal(cancelled, true);
    assert.equal(pulledChunks, 2);
  });

  it('keeps HTTP, transport, and malformed-response errors body and secret safe', async () => {
    const secret = 'provider-secret-value';
    const sensitiveBody = 'sensitive upstream response';
    const httpProvider = createAnthropicCompletionProvider({
      fetch: async () => new Response(sensitiveBody, { status: 429 }),
    });
    const httpError = await captureRejection(
      httpProvider.complete(completionRequest(), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: secret },
      }),
    );
    assert.equal(hasCode(httpError, 'http_error'), true);
    assert.doesNotMatch(
      String(httpError),
      new RegExp(`${secret}|${sensitiveBody}`),
    );

    const transportProvider = createAnthropicCompletionProvider({
      fetch: async () => {
        throw new Error(`socket failed with ${secret}`);
      },
    });
    const transportError = await captureRejection(
      transportProvider.complete(completionRequest(), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: secret },
      }),
    );
    assert.equal(hasCode(transportError, 'transport_error'), true);
    assert.doesNotMatch(String(transportError), new RegExp(secret));

    const malformedProvider = createAnthropicCompletionProvider({
      fetch: async () => new Response(sensitiveBody, { status: 200 }),
    });
    const malformedError = await captureRejection(
      malformedProvider.complete(completionRequest(), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: secret },
      }),
    );
    assert.equal(hasCode(malformedError, 'invalid_response'), true);
    assert.doesNotMatch(String(malformedError), new RegExp(sensitiveBody));
  });

  it('strictly validates the response envelope and structured JSON content', async () => {
    for (const response of [
      {
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: {},
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1' }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '{}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: -1, output_tokens: 1 },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'private-thought' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 100 },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'private-data' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 100 },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 42 },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]) {
      const provider = createAnthropicCompletionProvider({
        fetch: async () => Response.json(response),
      });
      await rejectsWithCode(
        provider.complete(completionRequest(), {
          credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
        }),
        'invalid_response',
      );
    }

    const nonJsonProvider = createAnthropicCompletionProvider({
      fetch: async () => messageResponse({ content: 'not structured JSON' }),
    });
    await rejectsWithCode(
      nonJsonProvider.complete(completionRequest({ responseSchema: schema }), {
        credentials: { [ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key' },
      }),
      'invalid_response',
    );
  });

  it('pins the supported structured-output model family and rejects unsafe options', () => {
    for (const model of [
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'anthropic/claude-opus-5-0',
    ]) {
      assert.equal(supportsAnthropicStructuredOutputModel(model), true);
    }
    for (const model of [
      'claude-sonnet-4-4',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet',
      'gpt-5',
    ]) {
      assert.equal(supportsAnthropicStructuredOutputModel(model), false);
    }
    assert.throws(
      () =>
        createAnthropicCompletionProvider({
          baseUrl: 'https://user:secret@example.test',
        }),
      /must not contain credentials/,
    );
    assert.throws(
      () =>
        createAnthropicCompletionProvider({
          baseUrl: 'http://gateway.example.test',
        }),
      /loopback/,
    );
    assert.throws(
      () => createAnthropicCompletionProvider({ timeoutMs: 300_001 }),
      /timeoutMs/,
    );
  });
});

function completionRequest(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    runId: 'run-1',
    purpose: 'role_player',
    model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    messages: [
      { role: 'user', content: 'Do the task.' },
      { role: 'assistant', content: 'I inspected it.' },
      { role: 'user', content: 'Finish it.' },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function listenLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function messageResponse(
  options: {
    content?: string;
    stopReason?: string;
    usage?: Readonly<Record<string, number>>;
  } = {},
): Response {
  return Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: options.content ?? 'done' }],
    model: 'claude-sonnet-4-6',
    stop_reason: options.stopReason ?? 'end_turn',
    usage: options.usage ?? { input_tokens: 3, output_tokens: 2 },
  });
}

interface RecordedFetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function recordingFetch(response: () => Response): {
  readonly calls: RecordedFetchCall[];
  readonly fetch: typeof fetch;
} {
  const calls: RecordedFetchCall[] = [];
  return {
    calls,
    fetch: (async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return response();
    }) as typeof fetch,
  };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: AnthropicCompletionError['code'],
): Promise<void> {
  await assert.rejects(promise, (error) => hasCode(error, code));
}

function hasCode(
  error: unknown,
  code: AnthropicCompletionError['code'],
): boolean {
  return error instanceof AnthropicCompletionError && error.code === code;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to reject.');
}
