import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {createOwnedWorkspace} from './workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('owned workspace', () => {
  it('writes atomically and exposes bounded, stable inspection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-test-'));
    roots.push(root);
    const workspace = await createOwnedWorkspace(root);
    await workspace.writeFile('nested/file.txt', Buffer.from('hello'));

    assert.deepEqual(await workspace.inspect('nested/file.txt'), {
      path: 'nested/file.txt',
      kind: 'file',
      size: 5,
    });
    assert.equal(Buffer.from(await workspace.readFile('nested/file.txt')).toString(), 'hello');
    assert.deepEqual(await workspace.listFiles(), [
      {path: 'nested', kind: 'directory'},
      {path: 'nested/file.txt', kind: 'file', size: 5},
    ]);
    await assert.rejects(workspace.readFile('nested/file.txt', {maxBytes: 2}), /byte limit/);
  });

  it('reports but never follows symlinks and rejects traversal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-test-'));
    roots.push(root);
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
    const workspace = await createOwnedWorkspace(root);

    assert.deepEqual(await workspace.inspect('escape'), {path: 'escape', kind: 'symlink'});
    assert.deepEqual(await workspace.listFiles(), [{path: 'escape', kind: 'symlink'}]);
    await assert.rejects(workspace.readFile('escape/anything'), /symlink|not a file|ENOENT/);
    await assert.rejects(workspace.writeFile('../escape', new Uint8Array()), /Invalid workspace/);
  });
});
