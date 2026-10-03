import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {createMemoryRunInputProvider} from './memoryInputs.js';

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
    expect(Buffer.from(read).toString()).toBe('alpha');
    read.fill(0);
    expect(Buffer.from(await inputs.read('fixtures/z.txt')).toString()).toBe('alpha');
    await expect(inputs.inspect('fixtures')).resolves.toEqual({
      path: 'fixtures', kind: 'directory',
    });
    await expect(inputs.inspect('fixtures/z.txt')).resolves.toEqual({
      path: 'fixtures/z.txt', kind: 'file', size: 5,
    });
    await expect(inputs.listFiles('fixtures', {maxEntries: 2})).resolves.toEqual([
      {path: 'fixtures/nested/a.txt', kind: 'file', size: 4},
      {path: 'fixtures/z.txt', kind: 'file', size: 5},
    ]);
  });

  it('enforces default and per-read bounds, entry limits, and cancellation', async () => {
    const inputs = createMemoryRunInputProvider({
      'fixtures/a.txt': 'alpha', 'fixtures/b.txt': 'beta',
    }, {maxBytes: 4});
    await expect(inputs.read('fixtures/a.txt')).rejects.toThrow(/4 byte limit/);
    await expect(inputs.read('fixtures/a.txt', {maxBytes: 5})).resolves.toEqual(
      Uint8Array.from(Buffer.from('alpha')),
    );
    await expect(inputs.listFiles('fixtures', {maxEntries: 1})).rejects.toThrow(/entry limit/);
    await expect(inputs.read('fixtures/b.txt', {maxBytes: 0})).rejects.toThrow(/positive/);
    const controller = new AbortController();
    controller.abort(new Error('input cancelled'));
    await expect(inputs.read('fixtures/b.txt', {signal: controller.signal}))
      .rejects.toThrow('input cancelled');
    await expect(inputs.listFiles('fixtures', {signal: controller.signal}))
      .rejects.toThrow('input cancelled');
  });

  it('rejects unsafe paths, missing inputs, and conflicting file/directory fixtures', async () => {
    expect(() => createMemoryRunInputProvider({'../outside': 'unsafe'}))
      .toThrow(/dataset-relative/);
    expect(() => createMemoryRunInputProvider({'a': 'file', 'a/b': 'child'}))
      .toThrow(/both a file and directory/);
    const inputs = createMemoryRunInputProvider({'fixtures/a.txt': 'alpha'});
    await expect(inputs.inspect('missing')).rejects.toThrow(/does not exist/);
    await expect(inputs.read('fixtures')).rejects.toThrow(/file does not exist/);
    await expect(inputs.listFiles('fixtures/a.txt')).rejects.toThrow(/directory does not exist/);
    await expect(inputs.read('fixtures/../a.txt')).rejects.toThrow(/dataset-relative/);
  });
});
