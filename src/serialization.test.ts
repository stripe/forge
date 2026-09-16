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

  it('rejects undefined and cycles', () => {
    expect(() => serializeCanonicalJson({missing: undefined})).toThrow('Undefined');
    const cyclic: {self?: unknown} = {};
    cyclic.self = cyclic;
    expect(() => serializeCanonicalJson(cyclic)).toThrow('Cyclic');
  });
});
