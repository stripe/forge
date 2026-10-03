import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {
  REDACTED_SECRET,
  SecretLeakError,
  assertNoSecrets,
  assertNoSecretsInJsonValue,
  redactSecrets,
} from './redaction.js';

describe('credential redaction', () => {
  it('redacts nested values and keys without mutating the input', () => {
    const input = Object.freeze({
      message: 'token=sk-secret',
      nested: Object.freeze({'sk-secret': Object.freeze(['sk-secret', null, true, false, 7])}),
    });
    const result = redactSecrets(input, ['sk-secret']);

    expect(result.value).toEqual({
      message: `token=${REDACTED_SECRET}`,
      nested: {[REDACTED_SECRET]: [REDACTED_SECRET, null, true, false, 7]},
    });
    expect(result.replacements).toBe(3);
    expect(input).toEqual({
      message: 'token=sk-secret',
      nested: {'sk-secret': ['sk-secret', null, true, false, 7]},
    });
    assert.notEqual(result.value, input);
    assert.notEqual(result.value.nested, input.nested);
  });

  it('counts exact occurrences once and redacts overlapping credentials longest first', () => {
    const short = 'synthetic.*$token';
    const long = `${short}-extended`;
    const secrets = Object.freeze(['', short, long, short]);

    const result = redactSecrets(`${long}|${short}${short}|syntheticZZ$token|safe`, secrets);

    assert.deepEqual(result, {
      value: `${REDACTED_SECRET}|${REDACTED_SECRET}${REDACTED_SECRET}|syntheticZZ$token|safe`,
      replacements: 3,
    });
    assert.deepEqual(secrets, ['', short, long, short]);
  });

  it('fails closed when redaction would overwrite another object key', () => {
    for (const input of [
      {'synthetic-token-one': 'first', 'synthetic-token-two': 'second'},
      {[REDACTED_SECRET]: 'first', 'synthetic-token-one': 'second'},
    ]) {
      assert.throws(
        () => redactSecrets(input, ['synthetic-token-one', 'synthetic-token-two']),
        {name: 'TypeError', message: 'Secret redaction produced duplicate object keys.'},
      );
      assert.equal(Object.keys(input).length, 2);
      assert.deepEqual(Object.values(input), ['first', 'second']);
    }
  });

  it('redacts shared children independently while rejecting object and array cycles', () => {
    const shared = Object.freeze({token: 'synthetic-shared-token'});
    const result = redactSecrets({left: shared, right: shared}, ['synthetic-shared-token']);

    assert.deepEqual(result, {
      value: {left: {token: REDACTED_SECRET}, right: {token: REDACTED_SECRET}},
      replacements: 2,
    });
    assert.notEqual(result.value.left, result.value.right);
    assert.deepEqual(shared, {token: 'synthetic-shared-token'});

    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    for (const input of [objectCycle, arrayCycle]) {
      assert.throws(() => redactSecrets(input, []), {
        name: 'TypeError',
        message: 'Cannot redact a cyclic value.',
      });
    }
  });

  it('rejects unsupported nested values instead of silently omitting them', () => {
    assert.throws(() => redactSecrets({nested: [undefined]}, []), {
      name: 'TypeError',
      message: 'Secret redaction accepts only JSON-compatible values.',
    });
  });

  it('preserves an own __proto__ JSON key without mutating object prototypes', () => {
    const input = JSON.parse('{"__proto__":{"token":"sk-secret"}}') as unknown;
    const result = redactSecrets(input, ['sk-secret']);

    expect(Object.hasOwn(result.value as object, '__proto__')).toBe(true);
    expect(result.value).toEqual({
      ['__proto__']: {token: REDACTED_SECRET},
    });
    expect(({} as {token?: string}).token).toBeUndefined();
  });

  it('rejects text and UTF-8 bytes without exposing the credential in the error', () => {
    const secret = 'synthetic-café-🔒';
    const body = `before ${secret} after`;
    for (const input of [body, Uint8Array.from(Buffer.from(body))]) {
      assert.throws(() => assertNoSecrets(input, ['', secret, secret], 'result.json'), (error) => {
        assert.ok(error instanceof SecretLeakError);
        assert.equal(error.code, 'secret_leak_detected');
        assert.equal(error.artifact, 'result.json');
        assert.equal(error.name, 'SecretLeakError');
        assert.ok(error.message.includes('result.json'));
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
  });

  it('scans only the supplied byte view and permits values with no credential occurrences', () => {
    const secret = 'synthetic-outside-token';
    const bytes = Uint8Array.from(Buffer.from(`${secret}|safe|${secret}`));
    const before = bytes.slice();
    const safeView = bytes.subarray(secret.length + 1, secret.length + 5);

    assertNoSecrets(safeView, ['', secret], 'safe.txt');
    assertNoSecretsInJsonValue({safe: [null, false, 0, 'ordinary text']}, ['', secret], 'safe.json');
    assert.deepEqual(bytes, before);
    assert.deepEqual(redactSecrets({safe: 'ordinary text'}, ['', secret]), {
      value: {safe: 'ordinary text'},
      replacements: 0,
    });
  });

  it('rejects a credential in logical JSON even when serialization escapes it', () => {
    const secret = 'quoted"credential\\suffix';
    const value = {resolution: {message: `before ${secret} after`}};

    expect(JSON.stringify(value)).not.toContain(secret);
    expect(() => assertNoSecretsInJsonValue(value, [secret], 'setup.json'))
      .toThrow(SecretLeakError);
  });
});
