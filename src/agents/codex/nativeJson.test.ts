import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {nativeJsonValue} from './nativeJson.js';

function extract(source: string, path: readonly string[]): string | undefined {
  // The production caller must establish this precondition before scanning.
  JSON.parse(source);
  return nativeJsonValue(source, path);
}

describe('exact native JSON value spans', () => {
  it('preserves native number spellings and property order without JSON reserialization', () => {
    const source = `{
      "payload": {"item": {"result": {"structuredContent": {
        "z": -0.0, "integer": 1.0, "exp": 1e+03, "small": 1E-7,
        "10": 10.00, "2": 2.0, "nested": [false, null, {"value": -0}]
      }}}}
    }`;
    const selected = extract(source, ['payload', 'item', 'result', 'structuredContent']);
    assert.equal(selected, '{"z":-0.0,"integer":1.0,"exp":1e+03,"small":1E-7,"10":10.00,"2":2.0,"nested":[false,null,{"value":-0}]}');
    assert.notEqual(selected, JSON.stringify(JSON.parse(selected!)));
  });

  it('preserves string escapes and whitespace inside strings exactly', () => {
    const source = String.raw`{"payload": {"value": { "text": "a  b\t c\n d", "unicode": "\u0061", "slash": "\/", "quote": "\"", "backslash": "\\" }}}`;
    assert.equal(extract(source, ['payload', 'value']),
      String.raw`{"text":"a  b\t c\n d","unicode":"\u0061","slash":"\/","quote":"\"","backslash":"\\"}`);
    assert.equal(extract(source, ['payload', 'value', 'unicode']), String.raw`"\u0061"`);
  });

  it('skips nested siblings and brackets/commas/escaped quotes inside strings', () => {
    const source = String.raw`{
      "ignored": [{"text": "brackets: } ] { [ , : \"; trailing slash \\"}, [1, {"value": 7}]],
      "payload": {"item": {"result": {"content": [{"type": "text", "text": "right, } ]"}]}}},
      "later": {"payload": {"item": {"result": {"content": "wrong"}}}}
    }`;
    assert.equal(extract(source, ['payload', 'item', 'result', 'content']),
      '[{"type":"text","text":"right, } ]"}]');
  });

  it('selects escaped, empty, Unicode, and prototype-like property names without special interpretation', () => {
    const source = String.raw`{"pay\u006coad":{"":{"é":{"__proto__":{"constructor":"safe"}}}}}`;
    assert.equal(extract(source, ['payload', '', 'é', '__proto__', 'constructor']), '"safe"');
    assert.equal(extract(String.raw`{"a\"b":{"c\\d":2.0}}`, ['a"b', 'c\\d']), '2.0');
  });

  it('rejects duplicate matching decoded keys at every selected path level', () => {
    for (const source of [
      '{"payload":{"value":1},"payload":{"value":2}}',
      '{"payload":{"value":1,"value":2}}',
      String.raw`{"payload":{"value":1,"val\u0075e":2}}`,
      String.raw`{"payload":{"value":1},"pay\u006coad":{"value":1}}`,
      '{"payload":null,"payload":{"value":1}}',
    ]) assert.equal(extract(source, ['payload', 'value']), undefined);
  });

  it('does not confuse unrelated duplicate keys or nested names with the selected property', () => {
    assert.equal(extract('{"other":0,"other":1,"payload":{"value":2.0}}', ['payload', 'value']), '2.0');
    assert.equal(extract('{"other":{"value":1},"payload":{"value":{"nested":1,"nested":2}}}', ['payload', 'value']), '{"nested":1,"nested":2}');
  });

  it('returns undefined for absent keys and object paths through arrays or primitives', () => {
    for (const [source, path] of [
      ['{}', ['missing']],
      ['{"payload":{}}', ['payload', 'missing']],
      ['{"payload":null}', ['payload', 'value']],
      ['{"payload":1}', ['payload', 'value']],
      ['{"payload":[{"value":1}]}', ['payload', '0', 'value']],
      ['[]', ['0']],
    ] as const) assert.equal(extract(source, path), undefined);
  });

  it('supports exact primitive, array, and object root extraction with an empty path', () => {
    for (const [source, expected] of [
      [' \t-0.0e+1\r\n', '-0.0e+1'],
      [' \ntrue\r ', 'true'],
      [' null ', 'null'],
      [' "a b" ', '"a b"'],
      [' [ 1.0, { "b" : 2e0 } ] ', '[1.0,{"b":2e0}]'],
      [' { "empty" : [ ], "object" : { } } ', '{"empty":[],"object":{}}'],
    ]) assert.equal(extract(source!, []), expected);
  });

  it('removes only the four JSON whitespace characters', () => {
    const source = '{\r\n\t "payload" : { "text" : "a b c d" } \r\n}';
    assert.equal(extract(source, ['payload']), '{"text":"a b c d"}');
  });

  it('handles the bounded maximum nesting iteratively', () => {
    let source = '-0.0';
    for (let depth = 0; depth < 64; depth += 1) source = `{"next":${source}}`;
    assert.equal(extract(source, Array.from({length: 64}, () => 'next')), '-0.0');
    assert.equal(nativeJsonValue(`{"next":${source}}`, []), undefined);
    assert.equal(nativeJsonValue('{}', Array.from({length: 65}, () => 'next')), undefined);
  });

  it('bounds source size and safely returns undefined for malformed structural boundaries', () => {
    assert.equal(nativeJsonValue(' '.repeat(1024 * 1024 + 1), []), undefined);
    for (const source of ['', ' ', '{', '[}', '{"payload":', '{"payload":"unterminated}', '{} {}', '{"payload":1,}']) {
      assert.equal(nativeJsonValue(source, ['payload']), undefined);
    }
  });
});
