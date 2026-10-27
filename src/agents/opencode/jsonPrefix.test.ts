import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isJsonPrefix } from './jsonPrefix.ts';

describe('JSON prefix classification', () => {
  it('recognizes every cut point in nested JSON, literals, numbers, and escaped strings', () => {
    for (const text of [
      '{"values": [true, false, null, -12.34e+5, 0.12E-3], "nested": {"text": "世界"}}',
      '{"text":"escaped \\" quote and \\\\ slash and \\u1234 code point"}',
      '"root string"',
      ...['true', 'false', 'null', '-1.23e-4', '0', '[]', '{}'],
    ]) {
      JSON.parse(text);
      for (let cut = 0; cut <= text.length; cut++)
        assert.equal(isJsonPrefix(text.slice(0, cut)), true, `cut ${cut}`);
    }
  });

  it('keeps interior corruption invalid even when it ends inside an open container or string', () => {
    for (const text of [
      '{broken}',
      '{"x":!}',
      '{"x":!',
      '{"x":truX',
      '{"x":tru ',
      '{"x":01',
      '[true false',
      '[}',
      '{"x":"bad\u0000',
      '{"x":"bad\\q',
      '{"x":"bad\\uX',
      '{"x":true}garbage',
      '{"x":"closed"} {',
    ]) {
      assert.equal(isJsonPrefix(text), false, text);
    }
  });
});
