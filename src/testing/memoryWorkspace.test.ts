import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createMemoryWorkspace } from './memoryWorkspace.ts';

describe('createMemoryWorkspace', () => {
  it('isolates initial bytes, written bytes, and snapshots from the workspace', async () => {
    const initial = Buffer.from('initial');
    const written = Buffer.from('written');
    const workspace = createMemoryWorkspace({ 'src/a.txt': initial });
    initial.fill(0);
    const firstRead = await workspace.mutable.readFile('src/a.txt');
    firstRead.fill(0);
    await workspace.mutable.writeFile('src/b.txt', written);
    written.fill(0);
    const snapshot = workspace.snapshot();
    snapshot.get('src/a.txt')!.fill(0);
    assert.equal(
      Buffer.from(await workspace.readonly.readFile('src/a.txt')).toString(),
      'initial',
    );
    assert.equal(
      Buffer.from(await workspace.readonly.readFile('src/b.txt')).toString(),
      'written',
    );
    await workspace.mutable.writeFile('src/b.txt', Buffer.from('updated'));
    assert.equal(Buffer.from(snapshot.get('src/b.txt')!).toString(), 'written');
    workspace.seal();
    await assert.rejects(
      workspace.mutable.writeFile('src/c.txt', Buffer.from('gamma')),
      /sealed/,
    );
  });

  it('applies read and subtree bounds while rejecting file/directory conflicts', async () => {
    const workspace = createMemoryWorkspace({
      'src/nested/a.txt': 'alpha',
      'src/b.txt': 'beta',
      'src-other/c.txt': 'outside',
    });
    assert.deepEqual(
      await workspace.readonly.listFiles({ under: 'src', maxEntries: 3 }),
      [
        { path: 'src/b.txt', kind: 'file', size: 4 },
        { path: 'src/nested', kind: 'directory' },
        { path: 'src/nested/a.txt', kind: 'file', size: 5 },
      ],
    );
    await assert.rejects(
      workspace.readonly.listFiles({ under: 'src', maxEntries: 2 }),
      /entry limit/,
    );
    await assert.rejects(
      workspace.readonly.readFile('src/b.txt', { maxBytes: 3 }),
      /byte limit/,
    );
    await assert.rejects(
      workspace.mutable.writeFile('src/b.txt/child', Buffer.from('x')),
      /parent is a regular file/,
    );
    await assert.rejects(
      workspace.mutable.writeFile('src/nested', Buffer.from('x')),
      /existing directory/,
    );
    assert.throws(
      () => createMemoryWorkspace({ a: 'file', 'a/b': 'child' }),
      /both a file and directory/,
    );
    assert.deepEqual(await workspace.readonly.inspect('src/missing'), {
      path: 'src/missing',
      kind: 'absent',
    });
  });
});
