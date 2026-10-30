import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { OPEN_CODE_MODEL_PROFILE } from '../../../test/support/opencode.ts';
import {
  OpenCodeRouteConfigurationError,
  parseOpenCodeModelRoutes,
} from './routes.ts';

describe('parseOpenCodeModelRoutes', () => {
  it('returns no overrides when routing is not configured', () => {
    assert.deepEqual(parseOpenCodeModelRoutes({}), {
      routes: {},
      credentialBindings: {},
    });
    assert.deepEqual(
      parseOpenCodeModelRoutes({ OPENCODE_MODEL_ROUTES: '  ' }).routes,
      {},
    );
  });

  it('maps exact model names to named endpoints and their key bindings', () => {
    const routing = parseOpenCodeModelRoutes({
      OPENCODE_MODEL_ROUTES:
        'qwen/qwen4-coder=openrouter,\n kimi-k3=OpenRouter',
      OPENCODE_ENDPOINT_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    assert.deepEqual(routing.routes, {
      'qwen/qwen4-coder': {
        endpoint: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        credential: 'opencode.endpoint.openrouter.api-key',
      },
      'kimi-k3': {
        endpoint: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        credential: 'opencode.endpoint.openrouter.api-key',
      },
    });
    assert.deepEqual(routing.credentialBindings, {
      'opencode.endpoint.openrouter.api-key':
        'OPENCODE_ENDPOINT_OPENROUTER_API_KEY',
    });
  });

  it('rejects malformed entries, duplicate models, and missing endpoint URLs', () => {
    for (const routes of [
      'no-separator',
      '=openrouter',
      'model=',
      'm=bad-name!',
    ]) {
      assert.throws(
        () => parseOpenCodeModelRoutes({ OPENCODE_MODEL_ROUTES: routes }),
        OpenCodeRouteConfigurationError,
      );
    }
    assert.throws(
      () =>
        parseOpenCodeModelRoutes({
          OPENCODE_MODEL_ROUTES: 'm=openrouter,m=openrouter',
          OPENCODE_ENDPOINT_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        }),
      /more than once/,
    );
    assert.throws(
      () => parseOpenCodeModelRoutes({ OPENCODE_MODEL_ROUTES: 'm=openrouter' }),
      /OPENCODE_ENDPOINT_OPENROUTER_BASE_URL is not set/,
    );
  });
});

describe('CLI OpenCode model routing', () => {
  it('builds the default composition with routed endpoints and key bindings', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { createDefaultCliComposition } = await import('../../cli.ts');
    const root = await mkdtemp(path.join(tmpdir(), 'forge-opencode-routes-'));
    try {
      const environment = {
        OPENCODE_BASE_URL: 'https://gateway.example/v1',
        OPENCODE_API_KEY: 'gateway-token',
        OPENCODE_MODEL_ROUTES: 'qwen/qwen4-coder=openrouter',
        OPENCODE_ENDPOINT_OPENROUTER_BASE_URL:
          'https://openrouter.example/api/v1',
        OPENCODE_ENDPOINT_OPENROUTER_API_KEY: 'openrouter-key',
      };
      const composition = await createDefaultCliComposition({
        datasetRoot: root,
        resultsRoot: root,
        environment,
      });
      const opencode = composition.agents.get('opencode')!;
      const resolve = async (model: string) => {
        const requirements = opencode.requirements({
          adapter: 'opencode',
          provider: 'openai-compatible',
          model,
          model_profile: OPEN_CODE_MODEL_PROFILE,
        });
        const reference =
          requirements.environment.credentials!.OPENCODE_API_KEY!.reference;
        return {
          baseURL: JSON.parse(
            requirements.environment.variables!.OPENCODE_CONFIG_CONTENT!,
          ).provider.forge.options.baseURL,
          key: await composition.credentialResolver.resolve(reference, {
            runId: 'route-test',
            purpose: 'agent',
            signal: new AbortController().signal,
          }),
        };
      };
      assert.deepEqual(await resolve('qwen/qwen4-coder'), {
        baseURL: 'https://openrouter.example/api/v1',
        key: 'openrouter-key',
      });
      assert.deepEqual(await resolve('openrouter-gemini-4-argon'), {
        baseURL: 'https://gateway.example/v1',
        key: 'gateway-token',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
