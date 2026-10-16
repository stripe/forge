import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { JsonObject } from '../model/types.ts';
import { normalizeSetupStepResolution } from './resolution.ts';

describe('setup resolution audit boundary', () => {
  it('snapshots shared acyclic data without accepting cyclic receipts', () => {
    const shared = { commit: 'before' };
    const normalized = normalizeSetupStepResolution(
      { source: shared, installed: shared },
      'acme/install',
    );
    shared.commit = 'after';

    assert.deepEqual(normalized, {
      source: { commit: 'before' },
      installed: { commit: 'before' },
    });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized?.source), true);
    assert.equal(Object.isFrozen(normalized?.installed), true);

    const cyclic: JsonObject = {};
    cyclic.source = cyclic;
    assert.throws(
      () => normalizeSetupStepResolution(cyclic, 'acme/install'),
      /invalid resolution/,
    );
  });

  it('rejects deep or sparse receipt data before it can be silently truncated', () => {
    let deep: JsonObject = { commit: 'revision' };
    for (let depth = 0; depth < 65; depth += 1) deep = { source: deep };
    assert.throws(
      () => normalizeSetupStepResolution(deep, 'acme/install'),
      /oversized resolution/,
    );

    const sparse = new Array<string>(2);
    sparse[1] = 'revision';
    assert.throws(
      () => normalizeSetupStepResolution({ sources: sparse }, 'acme/install'),
      /invalid resolution/,
    );

    const hidden = { commit: 'revision' };
    Object.defineProperty(hidden, 'source', {
      value: 'hidden',
      enumerable: false,
    });
    assert.throws(
      () => normalizeSetupStepResolution(hidden, 'acme/install'),
      /invalid resolution/,
    );
  });

  it('bounds encoded UTF-8 receipt bytes rather than string length', () => {
    const ascii = 'x'.repeat(600_000);
    assert.equal(
      normalizeSetupStepResolution({ value: ascii }, 'acme/install')?.value,
      ascii,
    );
    const multibyte = 'é'.repeat(ascii.length);
    assert.throws(
      () => normalizeSetupStepResolution({ value: multibyte }, 'acme/install'),
      /oversized resolution/,
    );
  });
});
