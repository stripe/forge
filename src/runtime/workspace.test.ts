import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createOwnedWorkspace } from './workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('owned workspace', () => {
  it('writes exact bytes and exposes bounded inspection', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-workspace-test-'),
    );
    roots.push(root);
    const workspace = await createOwnedWorkspace(root);
    await workspace.writeFile('nested/file.txt', Buffer.from('hello'));

    assert.deepEqual(await workspace.inspect('nested/file.txt'), {
      path: 'nested/file.txt',
      kind: 'file',
      size: 5,
    });
    assert.equal(
      Buffer.from(await workspace.readFile('nested/file.txt')).toString(),
      'hello',
    );
    assert.deepEqual(await workspace.listFiles(), [
      { path: 'nested', kind: 'directory' },
      { path: 'nested/file.txt', kind: 'file', size: 5 },
    ]);
    await assert.rejects(
      workspace.readFile('nested/file.txt', { maxBytes: 2 }),
      /byte limit/,
    );
  });

  it('reports but never follows symlinks and rejects traversal', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-workspace-test-'),
    );
    roots.push(root);
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-workspace-outside-'),
    );
    roots.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside');
    await fs.symlink(outside, path.join(root, 'escape'));
    const workspace = await createOwnedWorkspace(root);

    assert.deepEqual(await workspace.inspect('escape'), {
      path: 'escape',
      kind: 'symlink',
    });
    assert.deepEqual(await workspace.listFiles(), [
      { path: 'escape', kind: 'symlink' },
    ]);
    await assert.rejects(
      workspace.inspect('escape/sentinel.txt'),
      /outside its owned root/,
    );
    await assert.rejects(
      workspace.readFile('escape/sentinel.txt'),
      /outside its owned root/,
    );
    await assert.rejects(workspace.listFiles({ under: 'escape' }), /symlink/);
    await assert.rejects(
      workspace.writeFile('escape/sentinel.txt', Buffer.from('changed')),
      /not a real directory/,
    );
    assert.equal(
      await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'),
      'outside',
    );
    await assert.rejects(
      workspace.writeFile('../escape', new Uint8Array()),
      /Invalid workspace/,
    );
  });

  it('lists paths in code-unit order and applies subtree, entry and cancellation bounds', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-workspace-test-'),
    );
    roots.push(root);
    const workspace = await createOwnedWorkspace(root);
    for (const file of ['b', 'Z', 'B', 'a', 'nested/z', 'nested/A']) {
      await workspace.writeFile(file, Buffer.from(file));
    }
    assert.deepEqual(
      (await workspace.listFiles()).map(({ path }) => path),
      ['B', 'Z', 'a', 'b', 'nested', 'nested/A', 'nested/z'],
    );
    assert.deepEqual(
      (await workspace.listFiles({ under: 'nested' })).map(({ path }) => path),
      ['nested/A', 'nested/z'],
    );
    assert.deepEqual(await workspace.inspect('.'), {
      path: '.',
      kind: 'directory',
    });
    assert.deepEqual(await workspace.inspect('missing/child'), {
      path: 'missing/child',
      kind: 'absent',
    });
    await assert.rejects(workspace.listFiles({ maxEntries: 2 }), /entry limit/);
    const reason = new Error('cancel listing');
    await assert.rejects(
      workspace.listFiles({ signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
  });

  it('preserves the current owner and requested mode for host-written files', {
    skip:
      typeof process.getuid !== 'function' ||
      typeof process.getgid !== 'function',
  }, async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-workspace-test-'),
    );
    roots.push(root);
    const uid = process.getuid!();
    const gid = process.getgid!();
    const workspace = await createOwnedWorkspace(root, {
      writeOwner: { uid, gid },
    });
    await workspace.writeFile('private/file.txt', Buffer.from('owned'), {
      mode: 0o600,
    });

    const [directory, file] = await Promise.all([
      fs.stat(path.join(root, 'private')),
      fs.stat(path.join(root, 'private', 'file.txt')),
    ]);
    assert.equal(directory.uid, uid);
    assert.equal(directory.gid, gid);
    assert.equal(file.uid, uid);
    assert.equal(file.gid, gid);
    assert.equal(file.mode & 0o777, 0o600);
  });
});
