import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, it, vi } from 'vitest';
import { createClaudeCodeAdapter } from '../agents/claude-code/index.ts';
import { createCodexAdapter } from '../agents/codex/index.ts';
import { createOpenCodeAdapter } from '../agents/opencode/index.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type { ModelProbeOutcome } from '../contracts/modelProbe.ts';
import { createAnthropicCompletionProvider } from '../providers/anthropic/index.ts';
import { createOpenAICompletionProvider } from '../providers/openai/index.ts';
import { createStaticCredentialResolver } from '../testing/index.ts';
import { createHttpModelProbe } from './httpProbe.ts';

const signal = new AbortController().signal;
const credential = credentialReference('test.key');
const credentialResolver = createStaticCredentialResolver({
  'test.key': 'secret-value',
});
const context = { credentialResolver, signal };
const model = { provider: 'openai', model: 'test-model' };
const structuredResponse = {
  object: 'response',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"ok":true}' }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};

function fetchResponse(
  body: unknown,
  status = 200,
  headers = {},
): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('model probes', () => {
  it('probes an OpenAI-compatible HTTP endpoint with the exact model and scoped key', async () => {
    let calls = 0;
    const server = createServer(async (request, response) => {
      calls++;
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer secret-value');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'vendor/unknown-model');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply OK.' }]);
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'model_not_found' } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const adapter = createOpenCodeAdapter({
        credential,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const probe = adapter.probeModel!({
        adapter: 'opencode',
        provider: 'openai-compatible',
        model: 'vendor/unknown-model',
      });
      assert.equal(await probe.run(context), 'unknown_model');
      assert.equal(calls, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('accepts agent responses truncated by the small test budget', async () => {
    for (const [adapter, provider, response] of [
      [
        createCodexAdapter({ credential }),
        'openai',
        {
          object: 'response',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        },
      ],
      [
        createClaudeCodeAdapter({ credential }),
        'anthropic',
        { type: 'message', stop_reason: 'max_tokens', content: [] },
      ],
      [
        createOpenCodeAdapter({
          credential,
          baseUrl: 'https://models.example/v1',
        }),
        'openai-compatible',
        { choices: [{ finish_reason: 'length', message: { content: null } }] },
      ],
    ] as const) {
      vi.stubGlobal('fetch', fetchResponse(response));
      assert.equal(
        await adapter.probeModel!({
          adapter: adapter.id,
          provider,
          model: 'example',
        }).run(context),
        'ok',
      );
    }
  });

  it('uses the default Claude API-key header without bearer auth', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(new Headers(init.headers).get('x-api-key'), 'secret-value');
      assert.equal(new Headers(init.headers).get('authorization'), null);
      return new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'text', text: 'OK' }],
        }),
      );
    });
    const adapter = createClaudeCodeAdapter({ credential });
    assert.equal(
      await adapter.probeModel!({
        adapter: 'claude-code',
        provider: 'anthropic',
        model: 'example',
      }).run(context),
      'ok',
    );
  });

  const failures: [
    number,
    unknown,
    ModelProbeOutcome,
    Record<string, string>?,
  ][] = [
    [
      400,
      { error: { message: 'example-code is not a valid model ID' } },
      'unknown_model',
    ],
    [
      404,
      {
        error: {
          code: 'model_not_found',
          message: 'The model does not exist.',
        },
      },
      'unknown_model',
    ],
    [
      400,
      { error: { message: 'Model example is not available' } },
      'unknown_model',
    ],
    [404, { error: { type: 'not_found_error' } }, 'unknown_model'],
    [401, {}, 'auth'],
    [403, {}, 'auth'],
    [429, {}, 'rate_limited'],
    [503, {}, 'rate_limited', { 'retry-after': '1' }],
    [503, {}, 'other'],
    [504, {}, 'timeout'],
    [
      400,
      { error: { message: 'response_format json_schema is unsupported' } },
      'missing_structured_output',
    ],
    [
      422,
      { error: { message: 'output_config is unsupported' } },
      'missing_structured_output',
    ],
    [400, { error: { message: 'Unrelated bad request' } }, 'other'],
    [500, { error: { message: 'secret-value' } }, 'other'],
  ];
  for (const [status, body, expected, headers] of failures) {
    it(`classifies HTTP ${status} as ${expected}: ${JSON.stringify(body)}`, async () => {
      const provider = createOpenAICompletionProvider({
        credential,
        fetch: fetchResponse(body, status, headers),
      });
      assert.equal(
        await provider.probeModel!({ model, purpose: 'judge' }).run(context),
        expected,
      );
    });
  }

  it('sends one strict Responses request and validates the returned object', async () => {
    let calls = 0;
    const provider = createOpenAICompletionProvider({
      credential,
      baseUrl: 'https://models.example/v1',
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, 'https://models.example/v1/responses');
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer secret-value',
        );
        assert.equal(init?.redirect, 'manual');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'test-model');
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        assert.equal(body.store, false);
        assert.deepEqual(body.input, [
          { role: 'user', content: 'Return {"ok":true}.' },
        ]);
        return new Response(JSON.stringify(structuredResponse));
      },
    });
    const probe = provider.probeModel!({ model, purpose: 'judge' });
    assert.equal(calls, 0);
    assert.equal(await probe.run(context), 'ok');
    assert.equal(calls, 1);
    for (const text of [
      'plain text',
      '{"ok":false}',
      '{"ok":true,"extra":1}',
      '{}',
    ]) {
      const response = structuredClone(structuredResponse);
      response.output[0]!.content[0]!.text = text;
      const invalid = createOpenAICompletionProvider({
        credential,
        fetch: fetchResponse(response),
      });
      assert.equal(
        await invalid.probeModel!({ model, purpose: 'role_player' }).run(
          context,
        ),
        'missing_structured_output',
      );
    }
  });

  it('uses the Anthropic provider endpoint, auth mode and structured wire schema', async () => {
    const provider = createAnthropicCompletionProvider({
      credential,
      baseUrl: 'https://models.example',
      fetch: async (url, init) => {
        assert.equal(url, 'https://models.example/v1/messages');
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer secret-value',
        );
        assert.equal(
          new Headers(init?.headers).get('anthropic-version'),
          '2023-06-01',
        );
        const body = JSON.parse(String(init?.body));
        assert.equal(body.output_config.format.type, 'json_schema');
        return new Response(
          JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '{"ok":true}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      },
    });
    assert.equal(
      await provider.probeModel!({
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        purpose: 'role_player',
      }).run(context),
      'ok',
    );
  });

  it('reports missing credentials without sending any request', async () => {
    const provider = createOpenAICompletionProvider({
      credential,
      fetch: async () => {
        assert.fail('must not fetch');
      },
    });
    assert.equal(
      await provider.probeModel!({ model, purpose: 'judge' }).run({
        signal,
        credentialResolver: createStaticCredentialResolver({}),
      }),
      'auth',
    );
  });

  it('bounds time, handles transport failures, and preserves caller cancellation', async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout uses a native timer; inject a signal for a deterministic deadline.
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const probe = createHttpModelProbe({
      endpoint: 'https://models.example',
      credential,
      headers: () => ({}),
      body: '{}',
      accepts: () => true,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('deadline')),
            { once: true },
          );
        }),
    });
    const result = probe.run(context);
    await vi.waitFor(() => {
      assert.ok(vi.mocked(AbortSignal.timeout).mock.calls.length > 0);
    });
    await Promise.resolve();
    deadline.abort();
    assert.equal(await result, 'timeout');
    const broken = createHttpModelProbe({
      endpoint: 'https://models.example',
      credential,
      headers: () => ({}),
      body: '{}',
      accepts: () => true,
      fetch: async () => {
        throw new Error('secret-value');
      },
    });
    assert.equal(await broken.run(context), 'other');
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(broken.run({ ...context, signal: cancelled.signal }), {
      name: 'AbortError',
    });
  });

  it('bounds responses and never follows redirects', async () => {
    for (const response of [
      new Response('x'.repeat(70_000)),
      new Response('', {
        status: 302,
        headers: { location: 'https://other.example' },
      }),
    ]) {
      const provider = createOpenAICompletionProvider({
        credential,
        fetch: async (_url, init) => {
          assert.equal(init?.redirect, 'manual');
          return response;
        },
      });
      assert.equal(
        await provider.probeModel!({ model, purpose: 'judge' }).run(context),
        'other',
      );
    }
  });

  it('uses each agent protocol and its own credential', async () => {
    const agents = [
      {
        adapter: createClaudeCodeAdapter({
          credential,
          baseUrl: 'https://claude.example',
          credentialEnvironmentName: 'ANTHROPIC_AUTH_TOKEN',
        }),
        provider: 'anthropic',
        endpoint: 'https://claude.example/v1/messages',
        response: { type: 'message', content: [{ type: 'text', text: 'OK' }] },
      },
      {
        adapter: createCodexAdapter({
          credential,
          baseUrl: 'https://codex.example/v1',
        }),
        provider: 'openai',
        endpoint: 'https://codex.example/v1/responses',
        response: structuredResponse,
      },
      {
        adapter: createOpenCodeAdapter({
          baseUrl: 'https://opencode.example/v1',
          credential,
        }),
        provider: 'openai-compatible',
        endpoint: 'https://opencode.example/v1/chat/completions',
        response: { choices: [{ message: { content: 'OK' } }] },
      },
    ];
    for (const { adapter, provider, endpoint, response } of agents) {
      let calls = 0;
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        calls++;
        assert.equal(url, endpoint);
        assert.equal(
          new Headers(init.headers).get('authorization'),
          'Bearer secret-value',
        );
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, 'vendor/example');
        assert.equal(body.text, undefined);
        assert.equal(body.output_config, undefined);
        assert.deepEqual(body.messages ?? body.input, [
          { role: 'user', content: 'Reply OK.' },
        ]);
        return new Response(JSON.stringify(response));
      });
      const probe = adapter.probeModel!({
        adapter: adapter.id,
        provider,
        model: 'vendor/example',
      });
      assert.equal(calls, 0);
      assert.equal(probe.endpoint, endpoint);
      assert.equal(await probe.run(context), 'ok');
      assert.equal(calls, 1);
    }
  });

  it('detects an unknown OpenCode model on its OpenAI-compatible route', async () => {
    vi.stubGlobal(
      'fetch',
      fetchResponse({ error: { code: 'model_not_found' } }, 404),
    );
    const adapter = createOpenCodeAdapter({
      credential,
      baseUrl: 'https://models.example/v1',
    });
    assert.equal(
      await adapter.probeModel!({
        adapter: 'opencode',
        provider: 'openai-compatible',
        model: 'unknown-example',
      }).run(context),
      'unknown_model',
    );
  });
});
