import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { credentialReference } from './credentials.ts';
import {
  createMerchantCredentialResolver,
  merchantCredentialReference,
} from './merchant.ts';

const context = {
  runId: 'run-1',
  purpose: 'forge-eval:STRIPE_API_KEY',
  signal: new AbortController().signal,
};

describe('merchant credential resolver', () => {
  it('routes merchant references to the provisioner and all others to the fallback', async () => {
    const calls: string[] = [];
    const resolver = createMerchantCredentialResolver({
      async provision(recipe, received) {
        assert.equal(received, context);
        calls.push(`provision:${recipe}`);
        return `sk_test_${recipe}`;
      },
      fallback: {
        async resolve(reference) {
          calls.push(`fallback:${reference}`);
          return 'model-key';
        },
      },
    });

    assert.equal(
      await resolver.resolve(merchantCredentialReference('default'), context),
      'sk_test_default',
    );
    assert.equal(
      await resolver.resolve(credentialReference('model.api-key'), context),
      'model-key',
    );
    assert.deepEqual(calls, ['provision:default', 'fallback:model.api-key']);
  });

  it('propagates provisioning failures without consulting the fallback', async () => {
    const resolver = createMerchantCredentialResolver({
      async provision() {
        throw new Error('No merchant is available.');
      },
      fallback: {
        async resolve() {
          throw new Error('Fallback must not resolve merchant references.');
        },
      },
    });

    await assert.rejects(
      resolver.resolve(merchantCredentialReference('default'), context),
      /No merchant is available/,
    );
  });
});
