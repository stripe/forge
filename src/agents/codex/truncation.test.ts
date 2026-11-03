import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { codexTruncationBudget } from './truncation.ts';

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

  it('validates chars markers using byte budgets with an odd byte assigned to the tail', () => {
    const original = '0123456789'.repeat(20);
    const expected = '0123…191 chars truncated…56789';
    assert.equal(codexTruncationBudget(original, expected), 9);
    for (const observed of [
      expected.replace('191', '190'),
      expected.replace('191', '192'),
      expected.replace('0123', '0124'),
      expected.replace('56789', '56788'),
      '01234…191 chars truncated…6789', // Odd byte belongs to the tail.
      '012…191 chars truncated…456789', // Equal counts, impossible split.
      'unrelated …191 chars truncated… text',
    ])
      assert.equal(codexTruncationBudget(original, observed), undefined);
  });

  it('counts omitted Unicode scalars after rounding both UTF-8 boundaries', () => {
    // 9 bytes => 4 for the head and 5 for the tail. Head rounds down before
    // 漢; tail rounds up past 字. Each retained é is one scalar, two bytes.
    const original = 'é漢🦀middle🦀字é';
    assert.equal(
      codexTruncationBudget(original, 'é…10 chars truncated…é'),
      4,
    ); // Multiple byte budgets can produce the same rounded transform.
    assert.equal(
      codexTruncationBudget('🦀éhidden漢🦀', '🦀…8 chars truncated…🦀'),
      8,
    );
    // A 9-byte budget cuts through the head emoji and the é before the tail
    // emoji. The complete tail emoji survives, giving asymmetric byte lengths.
    assert.equal(
      codexTruncationBudget('é🦀hiddené🦀', 'é…8 chars truncated…🦀'),
      7,
    );
    assert.equal(
      codexTruncationBudget('é🦀hidden🦀é', 'é…8 chars truncated…é'),
      4,
    ); // Both four-byte emojis cross the byte targets and are omitted.
    assert.equal(
      codexTruncationBudget('🦀éhidden漢🦀', '🦀…10 chars truncated…🦀'),
      undefined,
    ); // UTF-16 code units are not the chars unit.
    assert.equal(
      codexTruncationBudget('🦀hidden🦀a', '…7 chars truncated…🦀a'),
      undefined,
    ); // Balanced-looking bytes cannot fit the head boundary.
    assert.equal(codexTruncationBudget('🦀', '…1 chars truncated…'), 0);
  });

  it('verifies chars clipping when literal chars and tokens markers survive in the source', () => {
    const prefix = '…1 tokens truncated…';
    const suffix = '…1 chars truncated…!';
    assert.equal(Buffer.byteLength(prefix), Buffer.byteLength(suffix));
    const original = `${prefix}${'x'.repeat(100)}${suffix}`;
    const expected = `${prefix}…100 chars truncated…${suffix}`;
    assert.equal(
      codexTruncationBudget(original, expected),
      Buffer.byteLength(prefix) * 2,
    );
    assert.equal(codexTruncationBudget(original, original), undefined);
    assert.equal(
      codexTruncationBudget(original, `${expected}…1 chars truncated…`),
      undefined,
    );
  });

  it('rejects malformed chars counts and UTF-16 without replacing evidence', () => {
    const original = '0123456789'.repeat(20);
    for (const count of ['0', '-1', '01', '201', '99999999999999999999', '1.5'])
      assert.equal(
        codexTruncationBudget(original, `0123…${count} chars truncated…56789`),
        undefined,
      );
    assert.equal(
      codexTruncationBudget(original, '0123...191 chars truncated...56789'),
      undefined,
    );
    assert.equal(
      codexTruncationBudget('\ud800hidden�', '�…6 chars truncated…�'),
      undefined,
    );
    assert.equal(
      codexTruncationBudget('�hidden�', '\ud800…6 chars truncated…�'),
      undefined,
    );
  });
});
