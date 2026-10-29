import assert from 'node:assert/strict';
import { renameSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, it, vi } from 'vitest';
import {
  assertDatasetPath,
  createDirectoryRunInputProvider,
} from './inputs.ts';

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
    const { root } = await datasetInputs();
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
      const { root } = await datasetInputs();
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
    const { root } = await datasetInputs();
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
    const { root, inputs } = await datasetInputs();
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
    const { inputs } = await datasetInputs();
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

  it('aborts an active read while it waits for input bytes', {
    timeout: 1_000,
  }, async (t) => {
    const { root, inputs } = await datasetInputs();
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

async function datasetInputs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-input-test-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'fixtures'));
  await fs.writeFile(path.join(root, 'fixtures', 'hello.txt'), 'hello');
  const inputs = await createDirectoryRunInputProvider(root);
  return { root, inputs };
}
