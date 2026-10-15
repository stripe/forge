import assert from 'node:assert/strict';
import { renameSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, it, vi } from 'vitest';
import { sha256Hex } from '../model/hashes.js';
import { loadDataset } from '../model/loaders.js';
import { writeSetupHandler } from '../setup/forgeWrite.js';
import { createMemoryWorkspace } from '../testing/memoryWorkspace.js';
import { createTestResolvedRunPlan } from '../testing/plans.js';
import {
  assertDatasetPath,
  createDirectoryRunInputProvider,
} from './inputs.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('createDirectoryRunInputProvider', () => {
  it('requires canonical relative paths with bounded UTF-8 segments and total length', () => {
    const maximumPath = [255, 255, 255, 254, 1]
      .map((length) => 'a'.repeat(length))
      .join('/');
    assert.equal(maximumPath.length, 1024);
    assert.doesNotThrow(() => assertDatasetPath(maximumPath));
    assert.doesNotThrow(() => assertDatasetPath(`${'é'.repeat(127)}a`));
    for (const datasetPath of [
      '',
      '/absolute',
      'C:relative',
      'C:/absolute',
      'fixtures\\file',
      'file\0',
      '.',
      '..',
      './file',
      'fixtures/../file',
      'fixtures//file',
      'fixtures/',
      'a'.repeat(256),
      'é'.repeat(128),
      `${maximumPath}a`,
    ]) {
      assert.throws(
        () => assertDatasetPath(datasetPath),
        /Invalid dataset-relative path/,
      );
    }
  });

  it('rejects symlinks to files and ancestor directories even when their targets are inside the dataset', async () => {
    const { root } = await verifiedDatasetInputs();
    await fs.symlink('hello.txt', path.join(root, 'fixtures/file-link.txt'));
    await fs.symlink('fixtures', path.join(root, 'tree-link'));
    const inputs = await createDirectoryRunInputProvider(root);
    for (const datasetPath of [
      'fixtures/file-link.txt',
      'tree-link/hello.txt',
    ]) {
      await assert.rejects(
        inputs.inspect(datasetPath),
        /does not exist or is unsafe/,
      );
      await assert.rejects(
        inputs.read(datasetPath),
        /does not exist or is unsafe/,
      );
    }
    await assert.rejects(
      inputs.listFiles('tree-link'),
      /does not exist or is unsafe/,
    );
    await assert.rejects(
      inputs.listFiles('fixtures'),
      /may not contain symlinks/,
    );
  });

  it('rejects a directory swapped to an outside symlink between validation and opening', async () => {
    for (const replacement of ['different-inode', 'same-inode']) {
      const { root } = await verifiedDatasetInputs();
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-outside-input-test-'),
      );
      temporaryRoots.push(outside);
      if (replacement === 'same-inode') {
        await fs.link(
          path.join(root, 'fixtures/hello.txt'),
          path.join(outside, 'hello.txt'),
        );
      } else {
        await fs.writeFile(path.join(outside, 'hello.txt'), 'other');
      }
      const inputs = await createDirectoryRunInputProvider(root);
      let swaps = 0;
      await assert.rejects(
        inputs.read('fixtures/hello.txt', {
          get maxBytes() {
            // Schedule the concurrent ancestor replacement after path validation.
            renameSync(
              path.join(root, 'fixtures'),
              path.join(root, 'original-fixtures'),
            );
            symlinkSync(outside, path.join(root, 'fixtures'));
            swaps++;
            return 5;
          },
        }),
        replacement === 'same-inode'
          ? /does not exist or is unsafe/
          : /changed while opening/,
      );
      assert.equal(swaps, 1);
    }
  });

  it('enforces exact byte and entry limits and rejects invalid limits', async () => {
    const { root } = await verifiedDatasetInputs();
    const inputs = await createDirectoryRunInputProvider(root, { maxBytes: 4 });
    await assert.rejects(inputs.read('fixtures/hello.txt'), /4 byte limit/);
    assert.equal(
      Buffer.from(
        await inputs.read('fixtures/hello.txt', { maxBytes: 5 }),
      ).toString(),
      'hello',
    );
    await fs.writeFile(path.join(root, 'fixtures/second.txt'), 'world');
    assert.equal(
      (await inputs.listFiles('fixtures', { maxEntries: 2 })).length,
      2,
    );
    await assert.rejects(
      inputs.listFiles('fixtures', { maxEntries: 1 }),
      /1 entry limit/,
    );
    for (const limit of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await assert.rejects(
        createDirectoryRunInputProvider(root, { maxBytes: limit }),
        /positive integers/,
      );
      await assert.rejects(
        inputs.read('fixtures/hello.txt', { maxBytes: limit }),
        /positive integers/,
      );
      await assert.rejects(
        inputs.listFiles('fixtures', { maxEntries: limit }),
        /positive integers/,
      );
    }
  });

  it('checks streamed byte limits after the file size check', async () => {
    const { root, inputs } = await verifiedDatasetInputs();
    const probe = await fs.open(path.join(root, 'fixtures/hello.txt'), 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    vi.spyOn(fileHandlePrototype, 'createReadStream').mockImplementation(() =>
      Readable.from([Buffer.from('larger')]),
    );
    await assert.rejects(
      inputs.read('fixtures/hello.txt', { maxBytes: 5 }),
      /exceeds its 5 byte limit/,
    );
  });

  it('preserves cancellation reasons for reads and listings', async () => {
    const { inputs } = await verifiedDatasetInputs();
    const controller = new AbortController();
    const reason = new Error('cancelled input access');
    controller.abort(reason);
    await assert.rejects(
      inputs.read('fixtures/hello.txt', { signal: controller.signal }),
      (error: unknown) => error === reason,
    );
    await assert.rejects(
      inputs.listFiles('fixtures', { signal: controller.signal }),
      (error: unknown) => error === reason,
    );
  });

  it('rejects a manifest file replaced by an empty directory without rejecting subtrees', async () => {
    const { root, inputs } = await verifiedDatasetInputs();
    assert.equal((await inputs.inspect('fixtures')).kind, 'directory');
    assert.deepEqual(await inputs.listFiles('fixtures'), [
      { path: 'fixtures/hello.txt', kind: 'file', size: 5 },
    ]);
    const source = path.join(root, 'fixtures/hello.txt');
    await fs.rm(source);
    await fs.mkdir(source);
    await assert.rejects(
      inputs.inspect('fixtures/hello.txt'),
      /manifest file type/,
    );
    await assert.rejects(
      inputs.listFiles('fixtures/hello.txt'),
      /manifest file type/,
    );
    await assert.rejects(inputs.listFiles('fixtures'), /manifest file type/);

    const plain = await createDirectoryRunInputProvider(root);
    assert.equal((await plain.inspect('fixtures/hello.txt')).kind, 'directory');
    assert.deepEqual(await plain.listFiles('fixtures/hello.txt'), []);
  });

  it('fails forge/write instead of skipping a source file replaced by an empty directory', async () => {
    const { root, inputs } = await verifiedDatasetInputs();
    const source = path.join(root, 'fixtures/hello.txt');
    await fs.rm(source);
    await fs.mkdir(source);
    const workspace = createMemoryWorkspace();
    const plan = createTestResolvedRunPlan();
    const prepared = writeSetupHandler.preflight(
      {
        uses: 'forge/write',
        with: {
          target: 'hello.txt',
          source: { dataset_path: 'fixtures/hello.txt' },
        },
      },
      { stepIndex: 0, selection: plan.agent, runtime: plan.runtime },
    );
    await assert.rejects(
      prepared.apply({
        runId: 'changed-input-type',
        paths: { workspace: '/workspace', home: '/home/forge' },
        workspace: workspace.mutable,
        stateDirectories: new Map(),
        commands: {
          async run() {
            throw new Error('No commands expected.');
          },
        },
        inputs,
        signal: new AbortController().signal,
        stepIndex: 0,
        selection: plan.agent,
        runtime: plan.runtime,
      }),
      /manifest file type/,
    );
    assert.equal(workspace.snapshot().size, 0);
  });

  it('aborts an active read while it waits for input bytes', {
    timeout: 1_000,
  }, async (t) => {
    const { root, inputs } = await verifiedDatasetInputs();
    const probe = await fs.open(path.join(root, 'fixtures/hello.txt'), 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      createReadStream(
        options?: Parameters<fs.FileHandle['createReadStream']>[0],
      ): Readable;
    };
    await probe.close();
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let stalled: PassThrough | undefined;
    vi.spyOn(fileHandlePrototype, 'createReadStream').mockImplementation(
      (options: Parameters<fs.FileHandle['createReadStream']>[0]) => {
        stalled = new PassThrough({
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        announceStarted();
        return stalled;
      },
    );
    t.onTestFinished(() => {
      stalled?.destroy();
    });
    const controller = new AbortController();
    const reading = inputs.read('fixtures/hello.txt', {
      signal: controller.signal,
    });
    const rejected = assert.rejects(reading, { name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
  });

  it('verifies consumed bytes against a snapshot of the loaded manifest', async () => {
    const { root, dataset, inputs } = await verifiedDatasetInputs();
    assert.equal(
      Buffer.from(await inputs.read('fixtures/hello.txt')).toString(),
      'hello',
    );
    await fs.writeFile(path.join(root, 'fixtures/hello.txt'), 'other');
    await assert.rejects(
      inputs.read('fixtures/hello.txt'),
      /manifest.*SHA-256/,
    );
    dataset.manifest.files.find(
      (file) => file.path === 'fixtures/hello.txt',
    )!.sha256 = sha256Hex('other');
    await assert.rejects(
      inputs.read('fixtures/hello.txt'),
      /manifest.*SHA-256/,
    );
  });

  it('rejects undeclared and missing files after dataset verification', async () => {
    const { root, inputs } = await verifiedDatasetInputs();
    assert.deepEqual(await inputs.listFiles('fixtures'), [
      { path: 'fixtures/hello.txt', kind: 'file', size: 5 },
    ]);
    const extra = path.join(root, 'fixtures/extra.txt');
    await fs.writeFile(extra, 'extra');
    await assert.rejects(
      inputs.inspect('fixtures/extra.txt'),
      /manifest inventory/,
    );
    await assert.rejects(
      inputs.read('fixtures/extra.txt'),
      /manifest inventory/,
    );
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
    await fs.writeFile(
      path.join(root, 'fixtures', 'nested', 'world.txt'),
      'world',
    );
    await fs.writeFile(path.join(root, 'fixtures', 'Z-last.txt'), 'mixed');
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
    const inputs = await createDirectoryRunInputProvider(root, {
      maxBytes: 10,
    });

    assert.equal(
      Buffer.from(await inputs.read('fixtures/hello.txt')).toString('utf8'),
      'hello',
    );
    assert.deepEqual(await inputs.listFiles('fixtures'), [
      { path: 'fixtures/Z-last.txt', kind: 'file', size: 5 },
      { path: 'fixtures/hello.txt', kind: 'file', size: 5 },
      { path: 'fixtures/nested/world.txt', kind: 'file', size: 5 },
    ]);
    await assert.rejects(
      inputs.read('../secret'),
      /Invalid dataset-relative path/,
    );
    await assert.rejects(
      inputs.read('outside/not-owned'),
      /outside its root|does not exist/,
    );
    await assert.rejects(
      inputs.read('fixtures/hello.txt', { maxBytes: 2 }),
      /byte limit/,
    );
  });
});

async function verifiedDatasetInputs() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-verified-input-test-'),
  );
  temporaryRoots.push(root);
  const caseBody =
    'id: test/example\nexecution_mode: one_shot\ninitial_prompt: Read the fixture\n';
  const payloads = [
    { path: 'cases/example.case.yaml', body: caseBody },
    { path: 'fixtures/hello.txt', body: 'hello' },
  ];
  for (const file of payloads) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.body);
  }
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      dataset: { id: 'test', version: '1' },
      cases: ['cases/example.case.yaml'],
      files: payloads.map(({ path: filePath, body }) => ({
        path: filePath,
        size: Buffer.byteLength(body),
        sha256: sha256Hex(body),
      })),
    }),
  );
  const dataset = await loadDataset(root);
  const inputs = await createDirectoryRunInputProvider(dataset.root, {
    manifest: dataset.manifest,
  });
  return { root, dataset, inputs };
}
