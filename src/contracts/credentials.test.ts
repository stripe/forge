import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
      bindings: { 'provider/key': 'FORGE_TEST_TOKEN' },
      environment: {
        FORGE_TEST_TOKEN: 'secret-value',
        UNDECLARED_TOKEN: 'must-not-escape',
      },
    });
    const environment = await createEnvironmentResolver(credentials).resolve(
      {
        variables: { PUBLIC_SETTING: 'enabled' },
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

    assert.deepEqual(environment.variables, { PUBLIC_SETTING: 'enabled' });
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
      environment: { TOKEN: 'ambient-secret' },
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
          variables: { TOKEN: 'plain' },
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
      variables: { PUBLIC_SETTING: 'enabled' },
      credentials: {
        API_TOKEN: { reference: credentialReference('provider/key') },
      },
    };
    const normalized = normalizeEnvironmentSpecification(input);

    input.variables.PUBLIC_SETTING = 'changed';
    input.credentials.API_TOKEN.reference = credentialReference('changed/key');
    assert.deepEqual(normalized, {
      variables: { PUBLIC_SETTING: 'enabled' },
      credentials: {
        API_TOKEN: { reference: 'provider/key' },
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
      { credential: { TOKEN: { reference: 'provider/key' } } },
      { variables: null },
      { variables: undefined },
      { variables: [] },
      { credentials: null },
      { credentials: undefined },
      { credentials: [] },
      { credentials: { TOKEN: null } },
      { credentials: { TOKEN: { reference: 'provider/key', extra: true } } },
      {
        credentials: {
          TOKEN: { reference: 'provider/key', scopes: ['agent'] },
        },
      },
    ];

    for (const input of malformed) {
      assert.throws(() => normalizeEnvironmentSpecification(input));
    }
  });

  it('purely normalizes and freezes a scoped environment specification', () => {
    const normalized = normalizeScopedEnvironmentSpecification({
      variables: { PUBLIC_SETTING: 'enabled' },
      credentials: {
        API_TOKEN: {
          reference: credentialReference('provider/key'),
          scopes: ['setup'],
        },
      },
    });

    assert.deepEqual(normalized, {
      variables: { PUBLIC_SETTING: 'enabled' },
      credentials: {
        API_TOKEN: { reference: 'provider/key', scopes: ['setup'] },
      },
    });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.variables), true);
    assert.equal(Object.isFrozen(normalized.credentials.API_TOKEN), true);
    assert.equal(
      Object.isFrozen(normalized.credentials.API_TOKEN!.scopes),
      true,
    );
    assert.throws(
      () =>
        normalizeScopedEnvironmentSpecification({
          variables: { 'BAD-NAME': 'value' },
        }),
      /Invalid environment variable name/,
    );
    assert.throws(
      () =>
        normalizeScopedEnvironmentSpecification({
          variables: { VALID_NAME: 'line-one\nline-two' },
        }),
      /invalid value/,
    );
    for (const malformed of [
      [],
      { credential: {} },
      { variables: null },
      { variables: [] },
      { credentials: null },
      { credentials: [] },
      {
        credentials: {
          TOKEN: { reference: 'provider/key', scopes: ['agent'], extra: true },
        },
      },
    ]) {
      assert.throws(() => normalizeScopedEnvironmentSpecification(malformed));
    }
  });

  it('bounds opaque references in UTF-8 bytes and rejects control characters', () => {
    const maximum = 'é'.repeat(512);
    assert.equal(credentialReference(maximum), maximum);
    assert.equal(
      credentialReference('provider/key with spaces'),
      'provider/key with spaces',
    );
    for (const reference of [
      '',
      'é'.repeat(513),
      'key\0',
      'key\r',
      'key\n',
      'key\u001f',
      'key\u007f',
    ]) {
      assert.throws(
        () => credentialReference(reference),
        /bounded non-empty strings/,
      );
    }
  });

  it('snapshots scopes in canonical order and preserves explicit prototype-named variables', () => {
    const input = {
      variables: JSON.parse('{"__proto__":"plain","constructor":"explicit"}'),
      credentials: JSON.parse(
        '{"toString":{"reference":"token","scopes":["agent","setup","agent"]}}',
      ),
    };
    const normalized = normalizeScopedEnvironmentSpecification(input);
    input.variables.__proto__ = 'changed';
    input.credentials.toString.scopes.splice(0);

    assert.deepEqual(
      normalized.variables,
      JSON.parse('{"__proto__":"plain","constructor":"explicit"}'),
    );
    assert.equal(Object.getPrototypeOf(normalized.variables), Object.prototype);
    const credentialName: string = 'toString';
    assert.deepEqual(normalized.credentials[credentialName], {
      reference: 'token',
      scopes: ['setup', 'agent'],
    });
    assert.ok(Object.isFrozen(normalized.credentials[credentialName]!.scopes));
  });

  it('rejects hidden and symbol declaration fields before resolving any credentials', async () => {
    const resolved: string[] = [];
    const resolver = createEnvironmentResolver({
      async resolve(reference) {
        resolved.push(reference);
        return 'private-token';
      },
    });
    for (const field of ['variables', 'credentials']) {
      for (const makeDictionary of [
        (value: unknown) => ({ [Symbol('TOKEN')]: value }),
        (value: unknown) => Object.defineProperty({}, 'TOKEN', { value }),
      ]) {
        const rawValue =
          field === 'variables' ? 'plain' : { reference: 'token' };
        assert.throws(
          () =>
            normalizeEnvironmentSpecification({
              [field]: makeDictionary(rawValue),
            }),
          /enumerable string fields/,
        );
        const scopedValue =
          field === 'variables'
            ? 'plain'
            : { reference: 'token', scopes: ['agent'] };
        const dictionary = makeDictionary(scopedValue);
        if (field === 'credentials') {
          Object.defineProperty(dictionary, 'FIRST_TOKEN', {
            enumerable: true,
            value: {
              reference: credentialReference('first'),
              scopes: ['agent'],
            },
          });
        }
        const input = {
          credentials: {
            FIRST_TOKEN: {
              reference: credentialReference('first'),
              scopes: ['agent'] as const,
            },
          },
          [field]: dictionary,
        };
        assert.throws(
          () => normalizeScopedEnvironmentSpecification(input),
          /enumerable string fields/,
        );
        await assert.rejects(
          resolver.resolve(input, {
            runId: 'malformed-dictionary',
            purpose: 'runtime',
            signal: new AbortController().signal,
          }),
          /enumerable string fields/,
        );
      }
    }
    assert.deepEqual(resolved, []);
  });

  it('rejects invalid resolved values without exposing them or resolving later credentials', async () => {
    for (const value of [
      undefined,
      null,
      123,
      '',
      'private-token\0',
      'private-token\r',
      'private-token\n',
    ]) {
      const resolved: string[] = [];
      const resolver = createEnvironmentResolver({
        async resolve(reference) {
          resolved.push(reference);
          return value as string;
        },
      });
      await assert.rejects(
        resolver.resolve(
          {
            credentials: {
              FIRST_TOKEN: {
                reference: credentialReference('first'),
                scopes: ['setup'],
              },
              SECOND_TOKEN: {
                reference: credentialReference('second'),
                scopes: ['agent'],
              },
            },
          },
          {
            runId: 'invalid-value',
            purpose: 'runtime',
            signal: new AbortController().signal,
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, /invalid value for FIRST_TOKEN/);
          assert.equal(error.message.includes('private-token'), false);
          return true;
        },
      );
      assert.deepEqual(resolved, ['first']);
    }
  });

  it('does not resolve credentials after cancellation has already fired', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before lookup');
    controller.abort(reason);
    const resolved: string[] = [];
    const resolver = createEnvironmentResolver({
      async resolve(reference) {
        resolved.push(reference);
        return 'private-token';
      },
    });
    await assert.rejects(
      resolver.resolve(
        {
          credentials: {
            TOKEN: {
              reference: credentialReference('token'),
              scopes: ['agent'],
            },
          },
        },
        {
          runId: 'already-aborted',
          purpose: 'runtime',
          signal: controller.signal,
        },
      ),
      (error: unknown) => error === reason,
    );
    assert.deepEqual(resolved, []);
  });

  it('rechecks cancellation after lookup before returning secrets or resolving the next binding', async () => {
    for (const reason of [new Error('cancelled during lookup'), 'cancelled']) {
      const controller = new AbortController();
      const resolved: string[] = [];
      const resolver = createEnvironmentResolver({
        async resolve(reference, context) {
          assert.equal(context.signal, controller.signal);
          assert.equal(context.runId, 'lookup-cancelled');
          assert.equal(context.purpose, 'runtime:FIRST_TOKEN');
          resolved.push(reference);
          controller.abort(reason);
          return 'private-token';
        },
      });
      await assert.rejects(
        resolver.resolve(
          {
            credentials: {
              FIRST_TOKEN: {
                reference: credentialReference('first'),
                scopes: ['setup'],
              },
              SECOND_TOKEN: {
                reference: credentialReference('second'),
                scopes: ['agent'],
              },
            },
          },
          {
            runId: 'lookup-cancelled',
            purpose: 'runtime',
            signal: controller.signal,
          },
        ),
        (error: unknown) => {
          if (reason instanceof Error) assert.equal(error, reason);
          else
            assert.ok(
              error instanceof DOMException && error.name === 'AbortError',
            );
          return true;
        },
      );
      assert.deepEqual(resolved, ['first']);
    }
  });

  it('rejects runtime-incompatible credential values before returning them', async () => {
    const credentials = createEnvironmentCredentialResolver({
      bindings: { 'provider/key': 'FORGE_TEST_TOKEN' },
      environment: { FORGE_TEST_TOKEN: 'secret\nsecond-line' },
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
      bindings: { 'provider/key': '__proto__' },
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
