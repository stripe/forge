import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '../contracts/credentials.ts';
import { pluginMcpCredentials } from './pluginCredentials.ts';

const servers = ['stripe'] as const;
describe('plugin credential policy', () => {
  it('declares opaque credentials under their registered names', () => {
    assert.deepEqual(pluginMcpCredentials(servers), {
      STRIPE_API_KEY: { reference: 'env:STRIPE_API_KEY' },
    });
  });

  it('resolves only the selected host binding without implicit fallbacks', async () => {
    for (const [explicit, environment, message] of [
      [
        {},
        { STRIPE_API_KEY: 'synthetic-key' },
        /No environment binding exists/,
      ],
      [
        { 'env:STRIPE_API_KEY': 'STRIPE_TEST_KEY' },
        { STRIPE_API_KEY: 'synthetic-default-key' },
        /Set STRIPE_TEST_KEY/,
      ],
    ] as const) {
      const resolver = createEnvironmentCredentialResolver({
        bindings: explicit,
        environment,
      });
      await assert.rejects(
        resolver.resolve(credentialReference('env:STRIPE_API_KEY'), {
          runId: 'test',
          purpose: 'agent',
          signal: new AbortController().signal,
        }),
        message,
      );
    }
  });
});
