import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {
  CompletionRequest,
  CompletionResponse,
  StrictCompletionResponseSchema,
} from '../../contracts/completion.js';
import {
  ANTHROPIC_API_KEY_CREDENTIAL,
  ANTHROPIC_AUTH_TOKEN_CREDENTIAL,
  ANTHROPIC_COMPLETION_PROVIDER_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_MAX_MESSAGE_BYTES,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_MAX_RESPONSE_BYTES,
  ANTHROPIC_MESSAGES_API_VERSION,
  ANTHROPIC_MESSAGES_COMPATIBLE_PROVIDER_VERSION,
  ANTHROPIC_STRUCTURED_OUTPUT_FORMAT,
  AnthropicCompletionError,
  createAnthropicCompletionProvider,
  supportsAnthropicStructuredOutputModel,
} from './index.js';

const schema: StrictCompletionResponseSchema = {
  name: 'ava_turn',
  description: 'One structured Ava turn.',
  strict: true,
  schema: {
    type: 'object',
    properties: {message: {type: 'string'}},
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
    assert.equal(provider.version, ANTHROPIC_COMPLETION_PROVIDER_VERSION);
    assert.deepEqual(
      provider.requirements({
        model: {provider: 'anthropic', model: 'claude-sonnet-4-6'},
        purpose: 'judge',
      }),
      {
        credentials: {
          [ANTHROPIC_API_KEY_CREDENTIAL]: {reference: 'anthropic.api-key'},
        },
      },
    );
    await provider.preflight?.({
      runId: 'run-1',
      model: {provider: 'anthropic', model: 'claude-sonnet-4-6'},
      purpose: 'judge',
      credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
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
    const provider = createAnthropicCompletionProvider({fetch: transport.fetch});

    const response = await provider.complete(
      completionRequest({
        systemPrompt: 'Act as a role player.',
        temperature: 0.3,
        maxTokens: 400,
        responseSchema: schema,
      }),
      {credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'}},
    );

    assert.deepEqual(response, {
      content: '{"message":"continue"}',
      stopReason: 'end_turn',
      usage: {inputTokens: 15, outputTokens: 4, cachedInputTokens: 3},
      costUsd: 0.125,
    });
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0]!;
    assert.equal(call.url, `${ANTHROPIC_DEFAULT_BASE_URL}/v1/messages`);
    assert.equal(call.init.method, 'POST');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('anthropic-version'), ANTHROPIC_MESSAGES_API_VERSION);
    assert.equal(headers.get('x-api-key'), 'test-direct-key');
    assert.equal(headers.has('authorization'), false);
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [
        {role: 'user', content: 'Do the task.'},
        {role: 'assistant', content: 'I inspected it.'},
        {role: 'user', content: 'Finish it.'},
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
          optional_items: {type: 'array', minItems: 0, items: {type: 'string'}},
          required_items: {type: 'array', minItems: 1, items: {type: 'string'}},
        },
        allOf: [
          {$ref: '#/$defs/non_negative'},
          {properties: {score: {type: 'number', maximum: 1}}},
        ],
        $defs: {
          non_negative: {type: 'number', minimum: 0},
        },
        required: ['summary', 'score', 'needs'],
        additionalProperties: false,
      },
    };
    const originalSchema = structuredClone(neutralSchema);
    const transport = recordingFetch(() =>
      messageResponse({content: '{"summary":"done","score":1,"needs":[]}'}),
    );
    const provider = createAnthropicCompletionProvider({fetch: transport.fetch});

    await provider.complete(completionRequest({responseSchema: neutralSchema}), {
      credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
    });

    const body = JSON.parse(String(transport.calls[0]?.init.body));
    assert.deepEqual(body.output_config.format.schema, {
      type: 'object',
      properties: {
        summary: {type: 'string', pattern: '\\S'},
        score: {type: 'number'},
        needs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {description: {type: 'string'}},
            required: ['description'],
            additionalProperties: false,
          },
        },
        optional_items: {type: 'array', minItems: 0, items: {type: 'string'}},
        required_items: {type: 'array', minItems: 1, items: {type: 'string'}},
      },
      allOf: [
        {$ref: '#/$defs/non_negative'},
        {properties: {score: {type: 'number'}}},
      ],
      $defs: {non_negative: {type: 'number'}},
      required: ['summary', 'score', 'needs'],
      additionalProperties: false,
    });
    assert.deepEqual(neutralSchema, originalSchema);
  });

  it('uses bearer authentication for a Messages-compatible base URL', async () => {
    const transport = recordingFetch(() =>
      messageResponse({stopReason: 'future_safe_reason'}),
    );
    const provider = createAnthropicCompletionProvider({
      id: 'stripe-gateway',
      baseUrl: 'http://127.0.0.1:4321/anthropic/',
      credential: 'stripe.gateway-token',
      fetch: transport.fetch,
    });

    assert.equal(
      provider.version,
      ANTHROPIC_MESSAGES_COMPATIBLE_PROVIDER_VERSION,
    );
    assert.deepEqual(
      provider.requirements({
        model: {provider: 'stripe-gateway', model: 'claude-opus-4-6'},
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
        model: {provider: 'stripe-gateway', model: 'claude-opus-4-6'},
      }),
      {credentials: {[ANTHROPIC_AUTH_TOKEN_CREDENTIAL]: 'test-gateway-token'}},
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
        model: {provider: 'anthropic', model: 'claude-sonnet-4-6'},
        purpose: 'judge',
      }),
      {
        credentials: {
          [ANTHROPIC_API_KEY_CREDENTIAL]: {reference: 'gateway.api-key'},
        },
      },
    );
    await provider.complete(completionRequest(), {
      credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'custom-api-key'},
    });
    const headers = new Headers(transport.calls[0]?.init.headers);
    assert.equal(headers.get('x-api-key'), 'custom-api-key');
    assert.equal(headers.has('authorization'), false);
  });

  it('rejects provider mismatches and unsupported structured-output models before fetch', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({fetch: transport.fetch});

    assert.throws(
      () =>
        provider.requirements({
          model: {provider: 'openai', model: 'claude-sonnet-4-6'},
          purpose: 'judge',
        }),
      (error) => hasCode(error, 'invalid_request'),
    );
    await rejectsWithCode(
      provider.complete(
        completionRequest({
          model: {provider: 'anthropic', model: 'claude-sonnet-4-4'},
          responseSchema: schema,
        }),
        {credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'}},
      ),
      'invalid_request',
    );
    await rejectsWithCode(
      provider.complete(
        completionRequest({maxTokens: ANTHROPIC_MAX_TOKENS + 1}),
        {credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'}},
      ),
      'invalid_request',
    );
    await rejectsWithCode(
      provider.complete(
        completionRequest({
          messages: [
            {role: 'user', content: 'x'.repeat(ANTHROPIC_MAX_MESSAGE_BYTES + 1)},
          ],
        }),
        {credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'}},
      ),
      'invalid_request',
    );
    assert.equal(transport.calls.length, 0);
  });

  it('rejects missing, extra, or unsafe credentials before fetch', async () => {
    const transport = recordingFetch(() => messageResponse());
    const provider = createAnthropicCompletionProvider({fetch: transport.fetch});

    for (const credentials of [
      {},
      {[ANTHROPIC_API_KEY_CREDENTIAL]: 'key', extra: 'extra'},
      {[ANTHROPIC_API_KEY_CREDENTIAL]: 'unsafe\nkey'},
    ]) {
      await rejectsWithCode(
        provider.complete(completionRequest(), {credentials}),
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
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
      }),
      'timeout',
    );
    assert.equal(receivedSignal?.aborted, true);

    const controller = new AbortController();
    controller.abort();
    await rejectsWithCode(
      provider.complete(completionRequest({signal: controller.signal}), {
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
      }),
      'aborted',
    );
  });

  it('bounds streamed response bytes before parsing', async () => {
    const provider = createAnthropicCompletionProvider({
      fetch: async () =>
        new Response('x'.repeat(ANTHROPIC_MAX_RESPONSE_BYTES + 1), {
          status: 200,
        }),
    });

    await rejectsWithCode(
      provider.complete(completionRequest(), {
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
      }),
      'response_too_large',
    );
  });

  it('keeps HTTP, transport, and malformed-response errors body and secret safe', async () => {
    const secret = 'provider-secret-value';
    const sensitiveBody = 'sensitive upstream response';
    const httpProvider = createAnthropicCompletionProvider({
      fetch: async () => new Response(sensitiveBody, {status: 429}),
    });
    const httpError = await captureRejection(
      httpProvider.complete(completionRequest(), {
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: secret},
      }),
    );
    assert.equal(hasCode(httpError, 'http_error'), true);
    assert.doesNotMatch(String(httpError), new RegExp(`${secret}|${sensitiveBody}`));

    const transportProvider = createAnthropicCompletionProvider({
      fetch: async () => {
        throw new Error(`socket failed with ${secret}`);
      },
    });
    const transportError = await captureRejection(
      transportProvider.complete(completionRequest(), {
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: secret},
      }),
    );
    assert.equal(hasCode(transportError, 'transport_error'), true);
    assert.doesNotMatch(String(transportError), new RegExp(secret));

    const malformedProvider = createAnthropicCompletionProvider({
      fetch: async () => new Response(sensitiveBody, {status: 200}),
    });
    const malformedError = await captureRejection(
      malformedProvider.complete(completionRequest(), {
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: secret},
      }),
    );
    assert.equal(hasCode(malformedError, 'invalid_response'), true);
    assert.doesNotMatch(String(malformedError), new RegExp(sensitiveBody));
  });

  it('strictly validates the response envelope and structured JSON content', async () => {
    for (const response of [
      {type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: {}},
      {
        type: 'message',
        role: 'assistant',
        content: [{type: 'tool_use', id: 'tool-1'}],
        stop_reason: 'tool_use',
        usage: {input_tokens: 1, output_tokens: 1},
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{type: 'text', text: '{}'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: -1, output_tokens: 1},
      },
    ]) {
      const provider = createAnthropicCompletionProvider({
        fetch: async () => Response.json(response),
      });
      await rejectsWithCode(
        provider.complete(completionRequest(), {
          credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
        }),
        'invalid_response',
      );
    }

    const nonJsonProvider = createAnthropicCompletionProvider({
      fetch: async () => messageResponse({content: 'not structured JSON'}),
    });
    await rejectsWithCode(
      nonJsonProvider.complete(completionRequest({responseSchema: schema}), {
        credentials: {[ANTHROPIC_API_KEY_CREDENTIAL]: 'test-direct-key'},
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
      () => createAnthropicCompletionProvider({baseUrl: 'https://user:secret@example.test'}),
      /must not contain credentials/,
    );
    assert.throws(
      () => createAnthropicCompletionProvider({baseUrl: 'http://gateway.example.test'}),
      /loopback/,
    );
    assert.throws(
      () => createAnthropicCompletionProvider({timeoutMs: 300_001}),
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
    model: {provider: 'anthropic', model: 'claude-sonnet-4-6'},
    messages: [
      {role: 'user', content: 'Do the task.'},
      {role: 'assistant', content: 'I inspected it.'},
      {role: 'user', content: 'Finish it.'},
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
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
    content: [{type: 'text', text: options.content ?? 'done'}],
    model: 'claude-sonnet-4-6',
    stop_reason: options.stopReason ?? 'end_turn',
    usage: options.usage ?? {input_tokens: 3, output_tokens: 2},
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
      calls.push({url: String(input), init});
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
