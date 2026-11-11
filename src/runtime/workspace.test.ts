import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsPromises, * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function captureFixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-workspace-capture-'),
  );
  roots.push(root);
  const workspace = await createOwnedWorkspace(root);
  await workspace.writeFile('session.json.partial', Buffer.from('safe'));
  return {
    root: await fs.realpath(root),
    capture: path.join(root, 'session.json.partial'),
    workspace,
  };
}

async function fileHandlePrototype(file: string) {
  const handle = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  return prototype;
}

describe('owned workspace', () => {
  it('rejects replacement of the capture with a symlink after checking its parent', async () => {
    const test = await captureFixture();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-workspace-outside-'),
    );
    roots.push(outside);
    const target = path.join(outside, 'sentinel');
    await fs.writeFile(target, 'outside');
    const realpath = fsPromises.realpath;
    const check = vi.spyOn(fsPromises, 'realpath').mockImplementationOnce(
      async () => {
        const parent = await realpath(test.root);
        await fs.unlink(test.capture);
        await fs.symlink(target, test.capture);
        return parent;
      },
    );
    syncBuiltinESMExports();

    await assert.rejects(
      test.workspace.readFile('session.json.partial'),
      (error) =>
        error instanceof Error && 'code' in error && error.code === 'ELOOP',
    );
    assert.equal(check.mock.calls.length, 1);
    assert.equal(await fs.readFile(target, 'utf8'), 'outside');
  });

  it('rejects replacement of the capture with a FIFO without waiting for a writer', {
    skip: process.platform === 'win32',
    timeout: 1000,
  }, async () => {
    const test = await captureFixture();
    const realpath = fsPromises.realpath;
    const check = vi.spyOn(fsPromises, 'realpath').mockImplementationOnce(
      async () => {
        const parent = await realpath(test.root);
        await fs.unlink(test.capture);
        const created = spawnSync('mkfifo', [test.capture], { timeout: 500 });
        assert.equal(created.status, 0, created.stderr?.toString());
        return parent;
      },
    );
    syncBuiltinESMExports();

    await assert.rejects(
      test.workspace.readFile('session.json.partial'),
      /not a file/,
    );
    assert.equal(check.mock.calls.length, 1);
  });

  it('keeps reading the validated handle when its pathname is replaced after fstat', async () => {
    const test = await captureFixture();
    const prototype = await fileHandlePrototype(test.capture);
    const stat = prototype.stat;
    let opened: fs.FileHandle | undefined;
    const checked = vi.spyOn(prototype, 'stat').mockImplementationOnce(
      async function (this: typeof prototype, ...args: Parameters<typeof stat>) {
        opened = this;
        const result = await stat.apply(this, args);
        await fs.unlink(test.capture);
        await fs.symlink('missing-target', test.capture);
        return result;
      },
    );

    assert.equal(
      Buffer.from(
        await test.workspace.readFile('session.json.partial'),
      ).toString(),
      'safe',
    );
    assert.equal(checked.mock.calls.length, 1);
    assert.equal(opened?.fd, -1);
  });

  it('caps reads at limit + 1 bytes when the capture grows after fstat', async () => {
    const test = await captureFixture();
    const prototype = await fileHandlePrototype(test.capture);
    const stat = prototype.stat;
    let opened: fs.FileHandle | undefined;
    const checked = vi.spyOn(prototype, 'stat').mockImplementationOnce(
      async function (this: typeof prototype, ...args: Parameters<typeof stat>) {
        opened = this;
        const result = await stat.apply(this, args);
        await fs.appendFile(test.capture, Buffer.alloc(128 * 1024, 'a'));
        return result;
      },
    );
    const read = prototype.read;
    let bytesRead = 0;
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: typeof prototype,
      ...args: Parameters<typeof read>
    ) {
      const result = await read.apply(this, args);
      bytesRead += result.bytesRead;
      return result;
    });

    await assert.rejects(
      test.workspace.readFile('session.json.partial', { maxBytes: 64 * 1024 }),
      /byte limit/,
    );
    assert.equal(checked.mock.calls.length, 1);
    assert.equal(bytesRead, 64 * 1024 + 1);
    assert.equal(opened?.fd, -1);
  });

  it('propagates cancellation during a read and closes the descriptor', async () => {
    const test = await captureFixture();
    const controller = new AbortController();
    const reason = new Error('cancel capture read');
    const prototype = await fileHandlePrototype(test.capture);
    const read = prototype.read;
    let opened: fs.FileHandle | undefined;
    vi.spyOn(prototype, 'read').mockImplementationOnce(async function (
      this: typeof prototype,
      ...args: Parameters<typeof read>
    ) {
      opened = this;
      const result = await read.apply(this, args);
      controller.abort(reason);
      return result;
    });

    await assert.rejects(
      test.workspace.readFile('session.json.partial', {
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
    assert.equal(opened?.fd, -1);
    const original = opened;
    await assert.rejects(
      test.workspace.readFile('session.json.partial', {
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
    assert.equal(opened, original);
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
