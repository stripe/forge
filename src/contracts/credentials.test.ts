import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  createEnvironmentCredentialResolver,
  createEnvironmentResolver,
  credentialReference,
  normalizeEnvironmentSpecification,
  normalizeScopedEnvironmentSpecification,
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

  it('strictly normalizes and snapshots capability environment declarations', () => {
    const input = {
      variables: {PUBLIC_SETTING: 'enabled'},
      credentials: {
        API_TOKEN: {reference: credentialReference('provider/key')},
      },
    };
    const normalized = normalizeEnvironmentSpecification(input);

    input.variables.PUBLIC_SETTING = 'changed';
    input.credentials.API_TOKEN.reference = credentialReference('changed/key');
    assert.deepEqual(normalized, {
      variables: {PUBLIC_SETTING: 'enabled'},
      credentials: {
        API_TOKEN: {reference: 'provider/key'},
      },
    });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.variables), true);
    assert.equal(Object.isFrozen(normalized.credentials), true);
    assert.equal(Object.isFrozen(normalized.credentials.API_TOKEN), true);
  });

  it('rejects malformed capability environment declarations', () => {
    const malformed: readonly unknown[] = [
      null,
      [],
      new Date(),
      {credential: {TOKEN: {reference: 'provider/key'}}},
      {variables: null},
      {variables: undefined},
      {variables: []},
      {credentials: null},
      {credentials: undefined},
      {credentials: []},
      {credentials: {TOKEN: null}},
      {credentials: {TOKEN: {reference: 'provider/key', extra: true}}},
      {credentials: {TOKEN: {reference: 'provider/key', scopes: ['agent']}}},
    ];

    for (const input of malformed) {
      assert.throws(() => normalizeEnvironmentSpecification(input));
    }
  });

  it('purely normalizes and freezes a scoped environment specification', () => {
    const normalized = normalizeScopedEnvironmentSpecification({
      variables: {PUBLIC_SETTING: 'enabled'},
      credentials: {
        API_TOKEN: {
          reference: credentialReference('provider/key'),
          scopes: ['setup'],
        },
      },
    });

    assert.deepEqual(normalized, {
      variables: {PUBLIC_SETTING: 'enabled'},
      credentials: {
        API_TOKEN: {reference: 'provider/key', scopes: ['setup']},
      },
    });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.variables), true);
    assert.equal(Object.isFrozen(normalized.credentials.API_TOKEN), true);
    assert.equal(Object.isFrozen(normalized.credentials.API_TOKEN!.scopes), true);
    assert.throws(
      () => normalizeScopedEnvironmentSpecification({
        variables: {'BAD-NAME': 'value'},
      }),
      /Invalid environment variable name/,
    );
    assert.throws(
      () => normalizeScopedEnvironmentSpecification({
        variables: {VALID_NAME: 'line-one\nline-two'},
      }),
      /invalid value/,
    );
    for (const malformed of [
      [],
      {credential: {}},
      {variables: null},
      {variables: []},
      {credentials: null},
      {credentials: []},
      {
        credentials: {
          TOKEN: {reference: 'provider/key', scopes: ['agent'], extra: true},
        },
      },
    ]) {
      assert.throws(() => normalizeScopedEnvironmentSpecification(malformed));
    }
  });

  it('rejects runtime-incompatible credential values before returning them', async () => {
    const credentials = createEnvironmentCredentialResolver({
      bindings: {'provider/key': 'FORGE_TEST_TOKEN'},
      environment: {FORGE_TEST_TOKEN: 'secret\nsecond-line'},
    });

    await assert.rejects(
      credentials.resolve(credentialReference('provider/key'), {
        runId: 'run-newline',
        purpose: 'runtime',
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('secret'), false);
        assert.match(error.message, /provider\/key/);
        return true;
      },
    );
  });

  it('does not resolve inherited object properties as credential values', async () => {
    const credentials = createEnvironmentCredentialResolver({
      bindings: {'provider/key': '__proto__'},
      environment: {},
    });

    await assert.rejects(
      credentials.resolve(credentialReference('provider/key'), {
        runId: 'run-inherited',
        purpose: 'runtime',
        signal: new AbortController().signal,
      }),
      /provider\/key/,
    );
  });
});
