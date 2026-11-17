import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createProviderLookup,
  ProviderConfigurationError,
  resolveProvider,
} from './providers.ts';

describe('provider lookup', () => {
  const lookup = createProviderLookup({
    anthropic: { integration: 'anthropic' },
    openrouter: {
      integration: 'openai-compatible',
      baseUrl: 'https://openrouter.example/v1',
    },
  });

  it('resolves a configured name whose integration the adapter supports', () => {
    assert.equal(
      resolveProvider(lookup, 'OpenCode', 'openrouter', ['openai-compatible'])
        .baseUrl,
      'https://openrouter.example/v1',
    );
  });

  it('reports an unknown provider with the configured logical names only', () => {
    assert.throws(
      () => resolveProvider(lookup, 'OpenCode', 'nope', ['openai-compatible']),
      (error: unknown) =>
        error instanceof ProviderConfigurationError &&
        error.reason === 'unknown_provider' &&
        error.provider === 'nope' &&
        error.message ===
          'Provider "nope" is not configured for OpenCode; configured providers: anthropic, openrouter.' &&
        !error.message.includes('example'),
    );
  });

  it('reports an integration the adapter does not support', () => {
    assert.throws(
      () => resolveProvider(lookup, 'Codex', 'anthropic', ['openai']),
      (error: unknown) =>
        error instanceof ProviderConfigurationError &&
        error.reason === 'unsupported_integration' &&
        /uses the anthropic integration, which Codex does not support; it requires openai\./.test(
          error.message,
        ),
    );
  });

  it('is immutable', () => {
    const entries = { a: { integration: 'openai' as const } };
    const frozen = createProviderLookup(entries);
    (entries.a as { integration: string }).integration = 'anthropic';
    assert.equal(frozen.get('a')?.integration, 'openai');
    assert.ok(Object.isFrozen(frozen.get('a')));
    assert.ok(Object.isFrozen(frozen.names()));
  });
});
