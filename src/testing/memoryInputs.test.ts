import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createMemoryRunInputProvider } from './memoryInputs.ts';

describe('createMemoryRunInputProvider', () => {
  it('snapshots initial bytes and returns isolated reads and sorted subtree files', async () => {
    const bytes = Buffer.from('alpha');
    const inputs = createMemoryRunInputProvider({
      'fixtures/z.txt': bytes,
      'fixtures/nested/a.txt': 'beta',
      'fixtures-other/outside.txt': 'outside',
    });
    bytes.fill(0);
    const read = await inputs.read('fixtures/z.txt');
    assert.equal(Buffer.from(read).toString(), 'alpha');
    read.fill(0);
    assert.equal(
      Buffer.from(await inputs.read('fixtures/z.txt')).toString(),
      'alpha',
    );
    assert.deepEqual(await inputs.inspect('fixtures'), {
      path: 'fixtures',
      kind: 'directory',
    });
    assert.deepEqual(await inputs.inspect('fixtures/z.txt'), {
      path: 'fixtures/z.txt',
      kind: 'file',
      size: 5,
    });
    assert.deepEqual(await inputs.listFiles('fixtures', { maxEntries: 2 }), [
      { path: 'fixtures/nested/a.txt', kind: 'file', size: 4 },
      { path: 'fixtures/z.txt', kind: 'file', size: 5 },
    ]);
  });

  it('enforces default and per-read bounds, entry limits, and cancellation', async () => {
    const inputs = createMemoryRunInputProvider(
      {
        'fixtures/a.txt': 'alpha',
        'fixtures/b.txt': 'beta',
      },
      { maxBytes: 4 },
    );
    await assert.rejects(inputs.read('fixtures/a.txt'), /4 byte limit/);
    assert.deepEqual(
      await inputs.read('fixtures/a.txt', { maxBytes: 5 }),
      Uint8Array.from(Buffer.from('alpha')),
    );
    await assert.rejects(
      inputs.listFiles('fixtures', { maxEntries: 1 }),
      /entry limit/,
    );
    await assert.rejects(
      inputs.read('fixtures/b.txt', { maxBytes: 0 }),
      /positive/,
    );
    const controller = new AbortController();
    controller.abort(new Error('input cancelled'));
    await assert.rejects(
      inputs.read('fixtures/b.txt', { signal: controller.signal }),
      /input cancelled/,
    );
    await assert.rejects(
      inputs.listFiles('fixtures', { signal: controller.signal }),
      /input cancelled/,
    );
  });

  it('rejects unsafe paths, missing inputs, and conflicting file/directory fixtures', async () => {
    assert.throws(
      () => createMemoryRunInputProvider({ '../outside': 'unsafe' }),
      /dataset-relative/,
    );
    assert.throws(
      () => createMemoryRunInputProvider({ a: 'file', 'a/b': 'child' }),
      /both a file and directory/,
    );
    const inputs = createMemoryRunInputProvider({ 'fixtures/a.txt': 'alpha' });
    await assert.rejects(inputs.inspect('missing'), /does not exist/);
    await assert.rejects(inputs.read('fixtures'), /file does not exist/);
    await assert.rejects(
      inputs.listFiles('fixtures/a.txt'),
      /directory does not exist/,
    );
    await assert.rejects(inputs.read('fixtures/../a.txt'), /dataset-relative/);
  });
});
