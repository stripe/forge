import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createOpenCodeAdapter } from './index.ts';
import { WEB_SEARCH_PLUGIN } from './webSearchPlugin.ts';

function configuration(
  engine = 'exa',
  extra: { upstream_providers?: string[]; endpoint?: string } = {},
) {
  return JSON.parse(
    createOpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:18991/v1',
      endpoints: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          credential: 'opencode.endpoint.openrouter.api-key',
        },
      },
    }).requirements({
      ...extra,
      adapter: 'opencode',
      provider: 'openai-compatible',
      model: 'vendor/model',
      model_profile: {
        limit: { context: 32000, output: 4000 },
        reasoning: false,
        temperature: true,
        attachment: false,
        web_search: { engine: engine as 'exa' | 'native' },
      },
    }).environment.variables!.OPENCODE_CONFIG_CONTENT!,
  );
}

async function transform(engine: string, config = configuration()) {
  const plugin = await import(
    `data:text/javascript;base64,${Buffer.from(WEB_SEARCH_PLUGIN).toString('base64')}`
  );
  await (await plugin.default({}, { engine })).config(config);
  return config.provider.forge.options.transformRequestBody as (
    body: unknown,
  ) => Record<string, unknown>;
}

describe('OpenCode OpenRouter request plugin', () => {
  it('sends the upstream provider pin and the search tool in one request body', async () => {
    const config = configuration('native', {
      endpoint: 'openrouter',
      upstream_providers: ['google-vertex'],
    });
    // The pin is a model option the SDK spreads into the body as providerOptions.forge.
    const pin = config.provider.forge.models['vendor/model'].options;
    assert.deepEqual(pin, {
      provider: { order: ['google-vertex'], allow_fallbacks: false },
    });
    assert.equal(
      config.provider.forge.options.baseURL,
      'https://openrouter.ai/api/v1',
    );
    const apply = await transform('native', config);
    // Stand-in for the SDK's prepared body: model options spread alongside messages.
    const body = apply({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'Search' }],
      stream: true,
      ...pin,
    });
    assert.deepEqual(body.provider, pin.provider);
    assert.deepEqual(body.tools, [
      { type: 'openrouter:web_search', parameters: { engine: 'native' } },
    ]);
  });

  it('prevents a request when plugin loading or config initialization is skipped or fails', async () => {
    const config = configuration();
    const options = config.provider.forge.options;
    // Pinned compatible SDK's call before postJsonToApi (chat model line 112).
    const prepare = () =>
      options.transformRequestBody?.({
        model: 'vendor/model',
        messages: [{ role: 'user' }],
      });
    assert.throws(prepare, TypeError);
    config.provider.forge.npm = 'unexpected';
    await assert.rejects(transform('exa', config), /Invalid Forge/);
    assert.throws(prepare, TypeError);
    config.provider.forge.npm = '@ai-sdk/openai-compatible';
    await transform('exa', config);
    assert.deepEqual(prepare().tools, [
      { type: 'openrouter:web_search', parameters: { engine: 'exa' } },
    ]);
  });
  it('appends one server tool after SDK preparation and preserves every other field', async () => {
    for (const engine of ['native', 'exa']) {
      const apply = await transform(engine);
      const fn = {
        type: 'function',
        function: { name: 'bash', parameters: { type: 'object' } },
      };
      const input = {
        model: 'vendor/model',
        messages: [{ role: 'user', content: 'Search' }],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.5,
        tools: [fn],
      };
      const before = structuredClone(input);
      const output = apply(input);
      assert.deepEqual(output, {
        ...input,
        tools: [fn, { type: 'openrouter:web_search', parameters: { engine } }],
      });
      assert.deepEqual(input, before);
      assert.equal(output.messages, input.messages);
      for (const tools of [undefined, []])
        assert.deepEqual(apply({ ...input, tools }).tools, [
          { type: 'openrouter:web_search', parameters: { engine } },
        ]);
      assert.throws(() => apply(output), /Invalid Forge/);
    }
  });
  it('fails closed on unexpected SDK request and option shapes', async () => {
    const apply = await transform('exa');
    for (const body of [
      null,
      [],
      {},
      { model: 'm', messages: [] },
      { model: 'm', messages: [null] },
      ...[
        null,
        {},
        [{ type: 'provider-defined' }],
        [{ type: 'function', function: { name: 'bash', parameters: null } }],
      ].map((tools) => ({ model: 'm', messages: [{ role: 'user' }], tools })),
    ])
      assert.throws(() => apply(body), /Invalid Forge/);
    await assert.rejects(transform('auto'), /Invalid Forge/);
  });
});
