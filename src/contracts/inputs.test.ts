import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {createDirectoryRunInputProvider} from './inputs.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})),
  );
});

describe('createDirectoryRunInputProvider', () => {
  it('reads bounded dataset files and rejects traversal and escaping symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-input-test-'));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, 'fixtures'));
    await fs.writeFile(path.join(root, 'fixtures', 'hello.txt'), 'hello');
    await fs.mkdir(path.join(root, 'fixtures', 'nested'));
    await fs.writeFile(path.join(root, 'fixtures', 'nested', 'world.txt'), 'world');
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
    const inputs = await createDirectoryRunInputProvider(root, {maxBytes: 10});

    assert.equal(
      Buffer.from(await inputs.read('fixtures/hello.txt')).toString('utf8'),
      'hello',
    );
    assert.deepEqual(await inputs.listFiles('fixtures'), [
      {path: 'fixtures/hello.txt', kind: 'file', size: 5},
      {path: 'fixtures/nested/world.txt', kind: 'file', size: 5},
    ]);
    await assert.rejects(inputs.read('../secret'), /Invalid dataset-relative path/);
    await assert.rejects(inputs.read('outside/not-owned'), /outside its root|does not exist/);
    await assert.rejects(inputs.read('fixtures/hello.txt', {maxBytes: 2}), /byte limit/);
  });
});
