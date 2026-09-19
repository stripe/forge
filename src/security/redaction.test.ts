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
    const input = {message: 'token=sk-secret', nested: {'sk-secret': ['sk-secret']}};
    const result = redactSecrets(input, ['sk-secret']);

    expect(result.value).toEqual({
      message: `token=${REDACTED_SECRET}`,
      nested: {[REDACTED_SECRET]: [REDACTED_SECRET]},
    });
    expect(result.replacements).toBe(3);
    expect(input.message).toContain('sk-secret');
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

  it('rejects canonical bytes which still contain a credential', () => {
    expect(() => assertNoSecrets('before sk-secret after', ['sk-secret'], 'result.json'))
      .toThrow(SecretLeakError);
  });

  it('rejects a credential in logical JSON even when serialization escapes it', () => {
    const secret = 'quoted"credential\\suffix';
    const value = {resolution: {message: `before ${secret} after`}};

    expect(JSON.stringify(value)).not.toContain(secret);
    expect(() => assertNoSecretsInJsonValue(value, [secret], 'setup.json'))
      .toThrow(SecretLeakError);
  });
});
