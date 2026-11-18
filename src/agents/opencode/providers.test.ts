import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  openCodeProviderBaseUrlEnvironment,
  openCodeProviderCredentialEnvironment,
  parseOpenCodeProviders,
} from './providers.ts';

describe('parseOpenCodeProviders', () => {
  it('returns no providers when none are configured', () => {
    assert.deepEqual(parseOpenCodeProviders({ OPENCODE_BASE_URL: 'x' }), {});
  });

  it('maps lowercase provider names to an openai-compatible API root and credential reference', () => {
    assert.deepEqual(
      parseOpenCodeProviders({
        OPENCODE_PROVIDER_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENCODE_PROVIDER_OPENROUTER_API_KEY: 'secret',
        OPENCODE_PROVIDER_GATEWAY_2_BASE_URL: 'https://gateway.example/v1',
        OPENCODE_PROVIDER_UNSET_BASE_URL: '',
      }),
      {
        openrouter: {
          integration: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          credential: 'opencode.provider.openrouter.api-key',
        },
        gateway_2: {
          integration: 'openai-compatible',
          baseUrl: 'https://gateway.example/v1',
          credential: 'opencode.provider.gateway_2.api-key',
        },
      },
    );
  });

  it('rejects provider variables that cannot name a provider', () => {
    for (const variable of [
      'OPENCODE_PROVIDER__BASE_URL',
      'OPENCODE_PROVIDER_bad_BASE_URL',
      'OPENCODE_PROVIDER_1X_BASE_URL',
    ])
      assert.throws(
        () => parseOpenCodeProviders({ [variable]: 'https://x.example' }),
        /does not name a provider/,
      );
  });
});

describe('OpenCode provider host variables', () => {
  it('derives the base URL variable from the provider name', () => {
    assert.equal(
      openCodeProviderBaseUrlEnvironment('openrouter'),
      'OPENCODE_PROVIDER_OPENROUTER_BASE_URL',
    );
  });

  it('derives the key variable only from provider credential references', () => {
    assert.equal(
      openCodeProviderCredentialEnvironment(
        'opencode.provider.openrouter.api-key',
      ),
      'OPENCODE_PROVIDER_OPENROUTER_API_KEY',
    );
    assert.equal(
      openCodeProviderCredentialEnvironment('opencode.api-key'),
      undefined,
    );
    assert.equal(
      openCodeProviderCredentialEnvironment('opencode.provider.Bad.api-key'),
      undefined,
    );
  });
});
