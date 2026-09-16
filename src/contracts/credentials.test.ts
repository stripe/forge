import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  createEnvironmentCredentialResolver,
  createEnvironmentResolver,
  credentialReference,
} from './credentials.js';

describe('credential and environment resolution', () => {
  it('resolves only explicit references and preserves secret scopes', async () => {
    const credentials = createEnvironmentCredentialResolver({
      bindings: {'provider/key': 'FORGE_TEST_TOKEN'},
      environment: {
        FORGE_TEST_TOKEN: 'secret-value',
        UNDECLARED_TOKEN: 'must-not-escape',
      },
    });
    const environment = await createEnvironmentResolver(credentials).resolve(
      {
        variables: {PUBLIC_SETTING: 'enabled'},
        credentials: {
          API_TOKEN: {
            reference: credentialReference('provider/key'),
            scopes: ['agent'],
          },
        },
      },
      {
        runId: 'run-1',
        purpose: 'runtime',
        signal: new AbortController().signal,
      },
    );

    assert.deepEqual(environment.variables, {PUBLIC_SETTING: 'enabled'});
    assert.deepEqual(environment.credentials.API_TOKEN, {
      value: 'secret-value',
      scopes: ['agent'],
    });
    assert.equal('UNDECLARED_TOKEN' in environment.variables, false);
    assert.equal(Object.isFrozen(environment.credentials), true);
  });

  it('rejects missing mappings and plain/secret name collisions', async () => {
    const credentials = createEnvironmentCredentialResolver({
      bindings: {},
      environment: {TOKEN: 'ambient-secret'},
    });
    await assert.rejects(
      credentials.resolve(credentialReference('TOKEN'), {
        runId: 'run-1',
        purpose: 'test',
        signal: new AbortController().signal,
      }),
      /No environment binding/,
    );

    await assert.rejects(
      createEnvironmentResolver(credentials).resolve(
        {
          variables: {TOKEN: 'plain'},
          credentials: {
            TOKEN: {
              reference: credentialReference('TOKEN'),
              scopes: ['setup'],
            },
          },
        },
        {
          runId: 'run-1',
          purpose: 'test',
          signal: new AbortController().signal,
        },
      ),
      /both plain and credential-backed/,
    );
  });

  it('validates every binding before resolving the first secret', async () => {
    const resolved: string[] = [];
    const resolver = createEnvironmentResolver({
      async resolve(reference) {
        resolved.push(reference);
        return 'secret-value';
      },
    });

    await assert.rejects(
      resolver.resolve(
        {
          credentials: {
            FIRST_TOKEN: {
              reference: credentialReference('first-token'),
              scopes: ['agent'],
            },
            INVALID_TOKEN: {
              reference: credentialReference('invalid-token'),
              scopes: [],
            },
          },
        },
        {
          runId: 'run-1',
          purpose: 'test',
          signal: new AbortController().signal,
        },
      ),
      /must declare at least one scope/,
    );
    assert.deepEqual(resolved, []);
  });
});
