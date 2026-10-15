import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { codexTruncationBudget } from './truncation.js';

describe('pinned Codex middle-out truncation', () => {
  it('validates the complete transform, including a marker already in the source', () => {
    const original = '…12 tokens truncated…'.repeat(100);
    const marker = `…${Math.ceil(Buffer.byteLength(original) / 4) - 15} tokens truncated…`;
    const expected = `${original.slice(0, 24)}${marker}${original.slice(-24)}`;
    // Each 24-character end has 30 UTF-8 bytes because of the ellipses.
    assert.equal(codexTruncationBudget(original, expected), 15);
    for (const observed of [
      expected.replace('…12', '…13'),
      `${expected.slice(0, -1)}!`,
      expected.replace(marker, '…0 tokens truncated…'),
      `${expected}…1 tokens truncated…`,
      'unrelated …12 tokens truncated… text',
    ])
      assert.equal(codexTruncationBudget(original, observed), undefined);
  });

  it('rounds each UTF-8 boundary but computes the count before rounding', () => {
    const original = '🦀'.repeat(101);
    // 3-token budget => 6 bytes each side, rounded to one 4-byte codepoint.
    assert.equal(
      codexTruncationBudget(original, '🦀…98 tokens truncated…🦀'),
      3,
    );
    assert.equal(
      codexTruncationBudget(original, '🦀…99 tokens truncated…🦀'),
      2,
    );
    assert.equal(
      codexTruncationBudget(original, '🦀…97 tokens truncated…🦀'),
      undefined,
    );
    assert.equal(
      codexTruncationBudget(original, '�…98 tokens truncated…🦀'),
      undefined,
    );
  });

  it('rejects unsupported counts, asymmetric clips, and malformed UTF-16', () => {
    const original = '0123456789'.repeat(20);
    for (const count of [
      '0',
      '-1',
      '01',
      '50',
      '51',
      '99999999999999999999',
      '1.5',
    ]) {
      assert.equal(
        codexTruncationBudget(
          original,
          `01234567…${count} tokens truncated…23456789`,
        ),
        undefined,
      );
    }
    assert.equal(
      codexTruncationBudget(original, '01234567…46 tokens truncated…23456789'),
      4,
    );
    assert.equal(
      codexTruncationBudget(original, '0123456…46 tokens truncated…123456789'),
      undefined,
    );
    assert.equal(
      codexTruncationBudget(
        original,
        '01234567...46 tokens truncated...23456789',
      ),
      undefined,
    );
    assert.equal(
      codexTruncationBudget('�'.repeat(20), '\ud800…13 tokens truncated…�'),
      undefined,
    );
    assert.equal(codexTruncationBudget('short', 'short'), undefined);
  });
});
