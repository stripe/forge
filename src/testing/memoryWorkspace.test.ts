import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {createMemoryWorkspace} from './memoryWorkspace.js';

describe('createMemoryWorkspace', () => {
  it('isolates initial bytes, written bytes, and snapshots from the workspace', async () => {
    const initial = Buffer.from('initial');
    const written = Buffer.from('written');
    const workspace = createMemoryWorkspace({'src/a.txt': initial});
    initial.fill(0);
    await workspace.mutable.writeFile('src/b.txt', written);
    written.fill(0);
    const snapshot = workspace.snapshot();
    snapshot.get('src/a.txt')!.fill(0);
    expect(Buffer.from(await workspace.readonly.readFile('src/a.txt')).toString())
      .toBe('initial');
    expect(Buffer.from(await workspace.readonly.readFile('src/b.txt')).toString())
      .toBe('written');
    await workspace.mutable.writeFile('src/b.txt', Buffer.from('updated'));
    expect(Buffer.from(snapshot.get('src/b.txt')!).toString()).toBe('written');
  });

  it('applies read and subtree bounds while rejecting file/directory conflicts', async () => {
    const workspace = createMemoryWorkspace({
      'src/nested/a.txt': 'alpha', 'src/b.txt': 'beta', 'src-other/c.txt': 'outside',
    });
    await expect(workspace.readonly.listFiles({under: 'src', maxEntries: 3}))
      .resolves.toEqual([
        {path: 'src/b.txt', kind: 'file', size: 4},
        {path: 'src/nested', kind: 'directory'},
        {path: 'src/nested/a.txt', kind: 'file', size: 5},
      ]);
    await expect(workspace.readonly.listFiles({under: 'src', maxEntries: 2}))
      .rejects.toThrow(/entry limit/);
    await expect(workspace.readonly.readFile('src/b.txt', {maxBytes: 3}))
      .rejects.toThrow(/byte limit/);
    await expect(workspace.mutable.writeFile('src/b.txt/child', Buffer.from('x')))
      .rejects.toThrow(/parent is a regular file/);
    await expect(workspace.mutable.writeFile('src/nested', Buffer.from('x')))
      .rejects.toThrow(/existing directory/);
    expect(() => createMemoryWorkspace({'a': 'file', 'a/b': 'child'}))
      .toThrow(/both a file and directory/);
    await expect(workspace.readonly.inspect('src/missing')).resolves.toEqual({
      path: 'src/missing', kind: 'absent',
    });
  });
});
