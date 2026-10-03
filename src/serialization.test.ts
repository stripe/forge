import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {serializeCanonicalJson} from './serialization.js';

describe('serializeCanonicalJson', () => {
  it('sorts keys recursively while retaining array order', () => {
    assert.equal(serializeCanonicalJson({z: 1, a: [{b: 2, a: 1}]}), '{"a":[{"a":1,"b":2}],"z":1}\n');
  });

  it('preserves reserved JSON keys without invoking object prototype setters', () => {
    const input = JSON.parse(
      '{"z":1,"__proto__":{"polluted":true},"constructor":"data"}',
    ) as unknown;

    assert.equal(serializeCanonicalJson(input), '{"__proto__":{"polluted":true},"constructor":"data","z":1}\n');
    assert.equal(({} as {polluted?: boolean}).polluted, undefined);
  });

  it('rejects unsupported JSON values rather than silently projecting them', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'),
      () => undefined, new Date(), [undefined], Array(1), {missing: undefined}]) {
      assert.throws(() => serializeCanonicalJson(value), TypeError);
    }
    assert.throws(() => serializeCanonicalJson({nested: Array(1)}), /\$\.nested\[0\]/);
  });

  it('rejects object and array cycles while allowing shared child objects', () => {
    const cyclic: {self?: unknown} = {};
    cyclic.self = cyclic;
    assert.throws(() => serializeCanonicalJson(cyclic), /Cyclic/);
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    assert.throws(() => serializeCanonicalJson(cyclicArray), /Cyclic/);
    const shared = {value: null};
    assert.equal(serializeCanonicalJson([shared, shared]), '[{"value":null},{"value":null}]\n');
  });

  it('accepts null-prototype records and canonicalizes negative zero without mutating input', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {z: -0, a: null});
    assert.equal(serializeCanonicalJson(input), '{"a":null,"z":0}\n');
    assert.equal(Object.is(input.z, -0), true);
    assert.equal(Object.getPrototypeOf(input), null);
  });
});
