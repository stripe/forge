import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';
import type { DatasetManifestV1 } from '../src/index.ts';
import { loadDataset } from '../src/index.ts';

const repositoryRoot = process.cwd();
const scriptPath = path.join(repositoryRoot, 'scripts', 'check-cases.mjs');
const { checkRepositoryCases, REPOSITORY_DATASET_ROOTS } = (await import(
  pathToFileURL(scriptPath).href
)) as {
  REPOSITORY_DATASET_ROOTS: readonly string[];
  checkRepositoryCases(options: {
    root: string;
    loadDataset: typeof loadDataset;
  }): Promise<{
    datasets: number;
    cases: number;
    errors: string[];
  }>;
};

describe('repository case check', () => {
  it('validates the explicit checked-in snapshots and fixture datasets through the public loader', async () => {
    assert.deepEqual(
      await checkRepositoryCases({ root: repositoryRoot, loadDataset }),
      {
        datasets: 3,
        cases: 3,
        errors: [],
      },
    );
  });

  it('ignores datasets outside the explicit repository roots', async (context) => {
    const root = await fixture();
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const unrelated = path.join(
      root,
      'test',
      'fixtures',
      'unlisted',
      'dataset',
    );
    await fs.mkdir(unrelated, { recursive: true });
    await fs.writeFile(
      path.join(unrelated, 'manifest.json'),
      'invalid manifest',
    );

    assert.deepEqual(await checkRepositoryCases({ root, loadDataset }), {
      datasets: 3,
      cases: 3,
      errors: [],
    });
  });

  it('reports a malformed authored case and still validates the next dataset', async (context) => {
    const root = await fixture();
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const datasetRoot = path.join(root, REPOSITORY_DATASET_ROOTS[0]!);
    const manifestPath = path.join(datasetRoot, 'manifest.json');
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, 'utf8'),
    ) as DatasetManifestV1;
    const relativePath = manifest.cases[0]!;
    const casePath = path.join(datasetRoot, relativePath);
    const invalid = (await fs.readFile(casePath, 'utf8')).replace(
      'id: examples/hello-file',
      'id: examples/Hello_file',
    );
    await fs.writeFile(casePath, invalid);
    const entry = manifest.files.find(({ path }) => path === relativePath)!;
    entry.size = Buffer.byteLength(invalid);
    entry.sha256 = createHash('sha256').update(invalid).digest('hex');
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const result = await checkRepositoryCases({ root, loadDataset });
    assert.equal(result.datasets, 3);
    assert.equal(result.cases, 2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /^test\/fixtures\/one-shot\/dataset:/);
    assert.match(result.errors[0]!, /id|identifier/i);
  });

  it('reports missing explicit roots in their declared order', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-case-check-'));
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const result = await checkRepositoryCases({ root, loadDataset });
    assert.equal(result.datasets, 3);
    assert.equal(result.cases, 0);
    assert.deepEqual(
      result.errors.map((error) => error.split(':')[0]),
      REPOSITORY_DATASET_ROOTS,
    );
  });

  it('uses the public loader and exits unsuccessfully for invalid repository cases', async (context) => {
    const root = await fixture();
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'dist'));
    const entry = path.join(root, 'scripts', 'check-cases.mjs');
    await fs.copyFile(scriptPath, entry);
    // Load the real source entry point through tsx without a package build.
    await fs.symlink(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      path.join(root, 'dist', 'index.js'),
    );
    const invoke = () =>
      spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), entry],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
    const valid = invoke();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, 'cases: checked 3 datasets and 3 cases\n');
    assert.equal(valid.stderr, '');

    await fs.writeFile(
      path.join(root, REPOSITORY_DATASET_ROOTS[0]!, 'manifest.json'),
      '{}',
    );
    const invalid = invoke();
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /^cases: test\/fixtures\/one-shot\/dataset:/);
  });
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-case-check-'));
  for (const relativeRoot of REPOSITORY_DATASET_ROOTS) {
    await fs.cp(
      path.join(repositoryRoot, relativeRoot),
      path.join(root, relativeRoot),
      {
        recursive: true,
      },
    );
  }
  return root;
}
