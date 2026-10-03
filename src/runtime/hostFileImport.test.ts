import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {importHostFileIntoState} from './hostFileImport.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

async function fixture(body = Buffer.from('replacement bytes')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-import-publication-'));
  roots.push(root);
  const state = path.join(root, 'state');
  const staging = path.join(root, 'staging');
  await fs.mkdir(state);
  await fs.mkdir(staging);
  const source = path.join(root, 'source');
  const destination = path.join(state, 'tool');
  await fs.writeFile(source, body);
  await fs.writeFile(destination, 'original bytes', {mode: 0o600});
  const request = {
    sourcePath: source, stateDirectoryId: 'tool-state', relativePath: 'tool',
    maxBytes: body.byteLength, sha256: `sha256:${createHash('sha256').update(body).digest('hex')}` as const,
    mode: 0o755,
  };
  return {state, staging, destination, request, body};
}

describe('host import publication', () => {
  it('preserves the existing file and removes staged bytes after failed digest verification', async () => {
    const test = await fixture();
    await assert.rejects(importHostFileIntoState(test.state, test.staging,
      {...test.request, sha256: `sha256:${'0'.repeat(64)}`}), /expected SHA-256/);
    assert.equal(await fs.readFile(test.destination, 'utf8'), 'original bytes');
    if (process.platform !== 'win32') assert.equal((await fs.stat(test.destination)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(test.staging), []);
    await importHostFileIntoState(test.state, test.staging, test.request);
    assert.deepEqual(await fs.readFile(test.destination), test.body);
    if (process.platform !== 'win32') assert.equal((await fs.stat(test.destination)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readdir(test.staging), []);
  });

  it('cleans up an allocated staging file when cancellation interrupts the transfer', async () => {
    const test = await fixture(Buffer.alloc(1024 * 1024, 'a'));
    const controller = new AbortController();
    const reason = new Error('cancel staged transfer');
    const watcher = watch(test.staging, (_event, filename) => {
      if (filename?.toString().startsWith('.forge-import-')) controller.abort(reason);
    });
    try {
      await assert.rejects(importHostFileIntoState(test.state, test.staging, test.request, controller.signal),
        (error) => error === reason);
      assert.equal(await fs.readFile(test.destination, 'utf8'), 'original bytes');
      assert.deepEqual(await fs.readdir(test.staging), []);
    } finally {
      watcher.close();
    }
  });
});
