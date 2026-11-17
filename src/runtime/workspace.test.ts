import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { WorkspaceEntryLimitError } from '../contracts/runtime.ts';
import { collectJudgeWorkspaceEvidence } from '../evaluation/judgeWorkspace.ts';
import { createOwnedWorkspace } from './workspace.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('owned workspace', () => {
  it('skips excluded directory trees before counting and keeps bounded partial evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-listing-'));
    roots.push(root);
    const workspace = await createOwnedWorkspace(root);
    for (const file of [
      'node_modules/pkg/a.js',
      'node_modules/pkg/b.js',
      'node_modules/pkg/c.js',
      'src/node_modules/nested/pkg.js',
      'src/app.ts',
      'src/view.ts',
    ]) {
      await workspace.writeFile(file, Buffer.from(file));
    }
    const options = { maxEntries: 3, excludeDirectoryNames: ['node_modules'] };
    assert.deepEqual(
      (await workspace.listFiles(options)).map(({ path }) => path),
      ['src', 'src/app.ts', 'src/view.ts'],
    );
    assert.deepEqual(
      await workspace.listFiles({ ...options, under: 'node_modules' }),
      [],
    );
    const complete = await collectJudgeWorkspaceEvidence(workspace, {
      maxEntries: 3,
    });
    assert.equal(complete.evidence.complete, true);
    assert.deepEqual(
      complete.evidence.entries.map(({ path }) => path),
      ['src/app.ts', 'src/view.ts'],
    );

    await workspace.writeFile('src/z.ts', Buffer.from('beyond limit'));
    await assert.rejects(workspace.listFiles(options), (error) => {
      assert.ok(error instanceof WorkspaceEntryLimitError);
      assert.equal(error.maxEntries, 3);
      assert.deepEqual(
        error.entries.map(({ path }) => path),
        ['src', 'src/app.ts', 'src/view.ts'],
      );
      assert.ok(Object.isFrozen(error.entries));
      assert.ok(error.entries.every(Object.isFrozen));
      return true;
    });
    const partial = await collectJudgeWorkspaceEvidence(workspace, {
      maxEntries: 3,
    });
    assert.deepEqual(
      partial.evidence.entries.map(({ path }) => path),
      ['src/app.ts', 'src/view.ts'],
    );
    assert.equal(partial.evidence.complete, false);
    assert.equal(partial.evidence.truncated, true);
    assert.match(
      partial.renderedText,
      /listing was truncated.*entry limit of 3/,
    );
    assert.doesNotMatch(partial.renderedText, /beyond limit/);
  });

  it('matches exact directory basenames and retains files and symlinks with excluded names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-exclusions-'));
    roots.push(root);
    const workspace = await createOwnedWorkspace(root);
    await workspace.writeFile('file-dir', Buffer.from('file'));
    await workspace.writeFile('kept-dir/app.ts', Buffer.from('app'));
    await workspace.writeFile('skip-dir/app.ts', Buffer.from('excluded'));
    await fs.symlink('kept-dir', path.join(root, 'link-dir'));
    assert.deepEqual(
      (
        await workspace.listFiles({
          excludeDirectoryNames: ['file-dir', 'link-dir', 'kept', 'skip-dir'],
        })
      ).map(({ path }) => path),
      ['file-dir', 'kept-dir', 'kept-dir/app.ts', 'link-dir'],
    );
  });

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
