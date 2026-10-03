import {describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';

import {serializeCanonicalJson} from './serialization.js';

describe('serializeCanonicalJson', () => {
  it('sorts keys recursively while retaining array order', () => {
    expect(serializeCanonicalJson({z: 1, a: [{b: 2, a: 1}]})).toBe(
      '{"a":[{"a":1,"b":2}],"z":1}\n',
    );
  });

  it('preserves reserved JSON keys without invoking object prototype setters', () => {
    const input = JSON.parse(
      '{"z":1,"__proto__":{"polluted":true},"constructor":"data"}',
    ) as unknown;

    expect(serializeCanonicalJson(input)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"data","z":1}\n',
    );
    expect(({} as {polluted?: boolean}).polluted).toBeUndefined();
  });

  it('rejects unsupported JSON values rather than silently projecting them', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'),
      () => undefined, new Date(), [undefined], Array(1), {missing: undefined}]) {
      expect(() => serializeCanonicalJson(value)).toThrow(TypeError);
    }
    expect(() => serializeCanonicalJson({nested: Array(1)})).toThrow(/\$\.nested\[0\]/);
  });

  it('rejects object and array cycles while allowing shared child objects', () => {
    const cyclic: {self?: unknown} = {};
    cyclic.self = cyclic;
    expect(() => serializeCanonicalJson(cyclic)).toThrow('Cyclic');
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(() => serializeCanonicalJson(cyclicArray)).toThrow('Cyclic');
    const shared = {value: null};
    expect(serializeCanonicalJson([shared, shared])).toBe('[{"value":null},{"value":null}]\n');
  });

  it('accepts null-prototype records and canonicalizes negative zero without mutating input', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {z: -0, a: null});
    expect(serializeCanonicalJson(input)).toBe('{"a":null,"z":0}\n');
    expect(Object.is(input.z, -0)).toBe(true);
    expect(Object.getPrototypeOf(input)).toBe(null);
  });
});
