import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  openCodeEndpointCredentialEnvironment,
  parseOpenCodeEndpoints,
} from './endpoints.ts';

describe('parseOpenCodeEndpoints', () => {
  it('returns no endpoints when none are configured', () => {
    assert.deepEqual(parseOpenCodeEndpoints({ OPENCODE_BASE_URL: 'x' }), {});
  });

  it('maps lowercase endpoint names to their API root and credential reference', () => {
    assert.deepEqual(
      parseOpenCodeEndpoints({
        OPENCODE_ENDPOINT_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENCODE_ENDPOINT_OPENROUTER_API_KEY: 'secret',
        OPENCODE_ENDPOINT_GATEWAY_2_BASE_URL: 'https://gateway.example/v1',
        OPENCODE_ENDPOINT_UNSET_BASE_URL: '',
      }),
      {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          credential: 'opencode.endpoint.openrouter.api-key',
        },
        gateway_2: {
          baseUrl: 'https://gateway.example/v1',
          credential: 'opencode.endpoint.gateway_2.api-key',
        },
      },
    );
  });

  it('rejects endpoint variables that cannot name an endpoint', () => {
    for (const variable of [
      'OPENCODE_ENDPOINT__BASE_URL',
      'OPENCODE_ENDPOINT_bad_BASE_URL',
      'OPENCODE_ENDPOINT_1X_BASE_URL',
    ])
      assert.throws(
        () => parseOpenCodeEndpoints({ [variable]: 'https://x.example' }),
        /does not name an endpoint/,
      );
  });
});

describe('openCodeEndpointCredentialEnvironment', () => {
  it('derives the host variable only from endpoint credential references', () => {
    assert.equal(
      openCodeEndpointCredentialEnvironment(
        'opencode.endpoint.openrouter.api-key',
      ),
      'OPENCODE_ENDPOINT_OPENROUTER_API_KEY',
    );
    assert.equal(
      openCodeEndpointCredentialEnvironment('opencode.api-key'),
      undefined,
    );
    assert.equal(
      openCodeEndpointCredentialEnvironment('opencode.endpoint.Bad.api-key'),
      undefined,
    );
  });
});

describe('CLI OpenCode endpoints', () => {
  it('builds the default composition with named endpoints and key bindings', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { createDefaultCliComposition } = await import('../../cli.ts');
    const root = await mkdtemp(path.join(tmpdir(), 'forge-opencode-endpoints-'));
    try {
      const composition = await createDefaultCliComposition({
        datasetRoot: root,
        resultsRoot: root,
        environment: {
          OPENCODE_BASE_URL: 'https://gateway.example/v1',
          OPENCODE_API_KEY: 'gateway-token',
          OPENCODE_ENDPOINT_OPENROUTER_BASE_URL:
            'https://openrouter.example/api/v1',
          OPENCODE_ENDPOINT_OPENROUTER_API_KEY: 'openrouter-key',
        },
      });
      const opencode = composition.agents.get('opencode')!;
      const resolve = async (endpoint?: string) => {
        const requirements = opencode.requirements({
          adapter: 'opencode',
          provider: 'openai-compatible',
          model: 'm',
          ...(endpoint === undefined ? {} : { endpoint }),
          model_profile: {
            limit: { context: 32000, output: 4000 },
            reasoning: false,
            temperature: true,
            attachment: false,
          },
        });
        return {
          baseURL: JSON.parse(
            requirements.environment.variables!.OPENCODE_CONFIG_CONTENT!,
          ).provider.forge.options.baseURL,
          key: await composition.credentialResolver.resolve(
            requirements.environment.credentials!.OPENCODE_API_KEY!.reference,
            {
              runId: 'endpoint-test',
              purpose: 'agent',
              signal: new AbortController().signal,
            },
          ),
        };
      };
      assert.deepEqual(await resolve('openrouter'), {
        baseURL: 'https://openrouter.example/api/v1',
        key: 'openrouter-key',
      });
      assert.deepEqual(await resolve(), {
        baseURL: 'https://gateway.example/v1',
        key: 'gateway-token',
      });
      await assert.rejects(
        resolve('missing'),
        /endpoint "missing" is not configured/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
