import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, describe, it} from 'node:test';
import {createDirectoryRunInputProvider} from './inputs.js';
import {loadDataset} from '../model/loaders.js';
import {sha256Hex} from '../model/hashes.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})),
  );
});

describe('createDirectoryRunInputProvider', () => {
  it('aborts an active read while it waits for input bytes', {timeout: 1_000}, async (t) => {
    const {root, inputs} = await verifiedDatasetInputs();
    const probe = await fs.open(path.join(root, 'fixtures/hello.txt'), 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {announceStarted = resolve;});
    let stalled: PassThrough | undefined;
    t.mock.method(fileHandlePrototype, 'createReadStream', (
      options: Parameters<fs.FileHandle['createReadStream']>[0],
    ) => {
      stalled = new PassThrough({
        ...(options?.signal === undefined ? {} : {signal: options.signal}),
      });
      announceStarted();
      return stalled;
    });
    t.after(() => {stalled?.destroy();});
    const controller = new AbortController();
    const reading = inputs.read('fixtures/hello.txt', {signal: controller.signal});
    const rejected = assert.rejects(reading, {name: 'AbortError'});
    await started;
    controller.abort();
    await rejected;
  });

  it('verifies consumed bytes against a snapshot of the loaded manifest', async () => {
    const {root, dataset, inputs} = await verifiedDatasetInputs();
    assert.equal(Buffer.from(await inputs.read('fixtures/hello.txt')).toString(), 'hello');
    await fs.writeFile(path.join(root, 'fixtures/hello.txt'), 'other');
    await assert.rejects(inputs.read('fixtures/hello.txt'), /manifest.*SHA-256/);
    dataset.manifest.files.find((file) => file.path === 'fixtures/hello.txt')!.sha256 = sha256Hex('other');
    await assert.rejects(inputs.read('fixtures/hello.txt'), /manifest.*SHA-256/);
  });

  it('rejects undeclared and missing files after dataset verification', async () => {
    const {root, inputs} = await verifiedDatasetInputs();
    assert.deepEqual(await inputs.listFiles('fixtures'), [
      {path: 'fixtures/hello.txt', kind: 'file', size: 5},
    ]);
    const extra = path.join(root, 'fixtures/extra.txt');
    await fs.writeFile(extra, 'extra');
    await assert.rejects(inputs.inspect('fixtures/extra.txt'), /manifest inventory/);
    await assert.rejects(inputs.read('fixtures/extra.txt'), /manifest inventory/);
    await assert.rejects(inputs.listFiles('fixtures'), /manifest inventory/);
    await fs.rm(extra);
    await fs.rm(path.join(root, 'fixtures/hello.txt'));
    await assert.rejects(inputs.listFiles('fixtures'), /manifest inventory/);
  });

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

async function verifiedDatasetInputs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-verified-input-test-'));
  temporaryRoots.push(root);
  const caseBody = 'schema_version: 1\nid: test/example\nexecution_mode: one_shot\ninitial_prompt: Read the fixture\n';
  const payloads = [
    {path: 'cases/example.yaml', body: caseBody},
    {path: 'fixtures/hello.txt', body: 'hello'},
  ];
  for (const file of payloads) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, file.body);
  }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    schema_version: 1,
    dataset: {id: 'test', version: '1'},
    cases: [{id: 'test/example', path: 'cases/example.yaml'}],
    files: payloads.map(({path: filePath, body}) => ({
      path: filePath, size: Buffer.byteLength(body), sha256: sha256Hex(body),
    })),
  }));
  const dataset = await loadDataset(root);
  const inputs = await createDirectoryRunInputProvider(dataset.root, {manifest: dataset.manifest});
  return {root, dataset, inputs};
}
