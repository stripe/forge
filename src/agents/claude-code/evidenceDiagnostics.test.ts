import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  ClaudeSessionInvalidError,
  omittedValueWarning,
  safeAtifPath,
  safeSessionFailure,
} from './evidenceDiagnostics.ts';

it('stops an ATIF path at the first segment the converter does not write', () => {
  assert.equal(
    safeAtifPath(['steps', 1, 'tool_calls', 0, 'arguments', 'private-key']),
    'steps.1.tool_calls.0.arguments',
  );
  assert.equal(safeAtifPath(['private-key']), 'trajectory');
});

it('names the category, and the line when there is one', () => {
  assert.equal(
    safeSessionFailure(new ClaudeSessionInvalidError('', 'malformed JSONL', 3)),
    'Claude session evidence could not be normalized safely (malformed JSONL at line 3).',
  );
  assert.equal(
    safeSessionFailure(
      new ClaudeSessionInvalidError('', 'no complete conversation'),
    ),
    'Claude session evidence could not be normalized safely (no complete conversation).',
  );
  assert.equal(
    safeSessionFailure(new Error('private detail')),
    'Claude session evidence could not be normalized safely.',
  );
});

it('builds a value_omitted warning for a native line', () => {
  assert.deepEqual(
    omittedValueWarning('A Claude tool result had no content.', 4),
    {
      code: 'value_omitted',
      message: 'A Claude tool result had no content.',
      path: 'line:4',
    },
  );
});
