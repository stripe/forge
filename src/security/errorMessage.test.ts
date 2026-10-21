import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  boundedErrorMessage,
  MAX_ERROR_MESSAGE_CHARACTERS,
} from './errorMessage.ts';

describe('bounded error messages', () => {
  it('retains only the message and redacts every supplied credential', () => {
    const error = Object.assign(
      new Error('Denied: provider-secret agent-secret'),
      {
        cause: new Error('private cause'),
        response: 'private response',
      },
    );
    assert.equal(
      boundedErrorMessage(error, 'Unavailable.', [
        'provider-secret',
        'agent-secret',
      ]),
      'Denied: [REDACTED] [REDACTED]',
    );
  });

  it('redacts before truncating, including a credential crossing the boundary', () => {
    const prefix = 'x'.repeat(MAX_ERROR_MESSAGE_CHARACTERS - 4);
    const message = boundedErrorMessage(
      new Error(`${prefix}secret-token more detail`),
      'Unavailable.',
      ['secret-token'],
    );
    assert.equal(message.length, MAX_ERROR_MESSAGE_CHARACTERS);
    assert.equal(message, `${prefix}[RE…`);
    assert.doesNotMatch(message, /secret/);
  });

  it('uses a safe fallback for arbitrary thrown values and empty messages', () => {
    for (const error of [
      null,
      'private response',
      { message: 'private response' },
      new Error('  '),
    ]) {
      assert.equal(boundedErrorMessage(error, 'Unavailable.'), 'Unavailable.');
    }
  });
});
