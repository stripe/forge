import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { type CredentialResolver, credentialReference } from './credentials.ts';
import {
  merchantCredentialReference,
  routeMerchantCredentials,
} from './merchant.ts';

const context = {
  runId: 'run-1',
  purpose: 'forge-eval:STRIPE_API_KEY',
  signal: new AbortController().signal,
};

describe('merchant credential routing', () => {
  it('routes merchant references to the provisioner and all others to lookup', async () => {
    const calls: string[] = [];
    const lookup: CredentialResolver = {
      async resolve(reference) {
        calls.push(`lookup:${reference}`);
        return 'model-key';
      },
    };
    const resolver = routeMerchantCredentials(lookup, {
      async provisionKey(recipe, received) {
        assert.equal(received, context);
        calls.push(`provision:${recipe}`);
        return `rk_test_${recipe}`;
      },
    });

    assert.equal(
      await resolver.resolve(merchantCredentialReference('default'), context),
      'rk_test_default',
    );
    assert.equal(
      await resolver.resolve(credentialReference('model.api-key'), context),
      'model-key',
    );
    assert.deepEqual(calls, ['provision:default', 'lookup:model.api-key']);
    assert.equal(routeMerchantCredentials(lookup, undefined), lookup);
  });

  it('propagates provisioning failures without consulting lookup', async () => {
    const resolver = routeMerchantCredentials(
      {
        async resolve() {
          throw new Error('Lookup must not resolve merchant references.');
        },
      },
      {
        async provisionKey() {
          throw new Error('No merchant is available.');
        },
      },
    );

    await assert.rejects(
      resolver.resolve(merchantCredentialReference('default'), context),
      /No merchant is available/,
    );
  });
});
