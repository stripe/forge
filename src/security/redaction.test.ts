import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {
  REDACTED_SECRET,
  SecretLeakError,
  assertNoSecrets,
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

  it('rejects canonical bytes which still contain a credential', () => {
    expect(() => assertNoSecrets('before sk-secret after', ['sk-secret'], 'result.json'))
      .toThrow(SecretLeakError);
  });
});
