import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { collectSecrets, credentialValues } from './collectSecrets.ts';

const environment = {
  variables: { PLAIN: 'not-a-secret' },
  credentials: {
    API_KEY: { value: 'sk_one', scopes: ['agent'] as const },
    TOKEN: { value: 'tok_two', scopes: ['setup'] as const },
  },
};

describe('collectSecrets', () => {
  it('lists credential values but not plain variables', () => {
    assert.deepEqual(credentialValues(environment), ['sk_one', 'tok_two']);
  });

  it('combines credential and completion secrets once each', () => {
    assert.deepEqual(
      collectSecrets(environment, { secrets: ['tok_two', 'provider_key'] }),
      ['sk_one', 'tok_two', 'provider_key'],
    );
  });
});
