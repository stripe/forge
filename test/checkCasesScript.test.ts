import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';
import type { DatasetManifestV1 } from '../src/index.ts';
import {
  loadDataset,
  MAX_DATASET_MANIFEST_BYTES,
  parseDatasetManifestJson,
} from '../src/index.ts';

const repositoryRoot = process.cwd();
const scriptPath = path.join(repositoryRoot, 'scripts', 'check-cases.mjs');
const {
  checkRepositoryCases,
  datasetVersionViolations,
  gitBaselineReader,
  REPOSITORY_DATASET_ROOTS,
} = (await import(pathToFileURL(scriptPath).href)) as {
  REPOSITORY_DATASET_ROOTS: readonly string[];
  gitBaselineReader(options: {
    root: string;
    baseRef: string;
    parseDatasetManifestJson: typeof parseDatasetManifestJson;
    maxManifestBytes: number;
  }): (relativeRoot: string) => DatasetManifestV1 | undefined;
  datasetVersionViolations(
    baseline: DatasetManifestV1,
    candidate: DatasetManifestV1,
  ): string[];
  checkRepositoryCases(options: {
    root: string;
    loadDataset: typeof loadDataset;
    readBaselineManifest(relativeRoot: string): DatasetManifestV1 | undefined;
  }): Promise<{
    datasets: number;
    cases: number;
    errors: string[];
  }>;
};

describe('repository case check', () => {
  it('validates the explicit checked-in snapshots and fixture datasets through the public loader', async () => {
    assert.deepEqual(
      await checkRepositoryCases({
        root: repositoryRoot,
        loadDataset,
        readBaselineManifest: noBaseline,
      }),
      {
        datasets: 3,
        cases: 3,
        errors: [],
      },
    );
  });

  it('lists every checked-in dataset for version checks', async () => {
    const datasets = await fs.readdir(path.join(repositoryRoot, 'datasets'), {
      withFileTypes: true,
    });
    for (const entry of datasets) {
      if (!entry.isDirectory()) continue;
      const root = `datasets/${entry.name}`;
      const tracked = spawnSync(
        'git',
        ['ls-files', '--error-unmatch', `${root}/manifest.json`],
        {
          cwd: repositoryRoot,
        },
      );
      const anyTracked = spawnSync('git', ['ls-files', root], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).stdout;
      if (anyTracked === '') continue; // untracked local datasets
      assert.equal(tracked.status, 0, `${root} needs a root manifest.json`);
      assert.ok(REPOSITORY_DATASET_ROOTS.includes(root), root);
    }
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

    assert.deepEqual(
      await checkRepositoryCases({
        root,
        loadDataset,
        readBaselineManifest: noBaseline,
      }),
      {
        datasets: 3,
        cases: 3,
        errors: [],
      },
    );
  });

  it('reports a malformed authored case and still validates the next dataset', async (context) => {
    const root = await fixture();
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const datasetRoot = path.join(root, REPOSITORY_DATASET_ROOTS[0]!);
    await rewriteCase(datasetRoot, (source) =>
      source.replace('id: examples/hello-file', 'id: examples/Hello_file'),
    );

    const result = await checkRepositoryCases({
      root,
      loadDataset,
      readBaselineManifest: noBaseline,
    });
    assert.equal(result.datasets, 3);
    assert.equal(result.cases, 2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /^test\/fixtures\/one-shot\/dataset:/);
    assert.match(result.errors[0]!, /id|identifier/i);
  });

  it('reports missing explicit roots in their declared order', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-case-check-'));
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const result = await checkRepositoryCases({
      root,
      loadDataset,
      readBaselineManifest: noBaseline,
    });
    assert.equal(result.datasets, 3);
    assert.equal(result.cases, 0);
    assert.deepEqual(
      result.errors.map((error) => error.split(':')[0]),
      REPOSITORY_DATASET_ROOTS,
    );
  });

  it('reads parser-valid baseline manifests larger than the default subprocess buffer', {
    timeout: 20_000,
  }, async (context) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-large-baseline-'),
    );
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const manifest: DatasetManifestV1 = {
      dataset: { id: 'large', version: '1' },
      cases: Array.from({ length: 4000 }, (_, index) => ({
        id: `large/task-${index}`,
        version: '1',
        path: `cases/${'a'.repeat(220)}/task-${index}.case.yaml`,
      })),
    };
    const source = JSON.stringify(manifest, null, 2);
    assert.ok(Buffer.byteLength(source) > 1024 * 1024);
    assert.deepEqual(parseDatasetManifestJson(source), manifest);
    await fs.mkdir(path.join(root, 'dataset'));
    await fs.writeFile(path.join(root, 'dataset/manifest.json'), source);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          root,
          '-c',
          'user.name=forge',
          '-c',
          'user.email=forge@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    git('init', '-q');
    git('add', 'dataset/manifest.json');
    git('commit', '-q', '-m', 'baseline');
    const read = gitBaselineReader({
      root,
      baseRef: 'HEAD',
      parseDatasetManifestJson,
      maxManifestBytes: MAX_DATASET_MANIFEST_BYTES,
    });
    assert.deepEqual(read('dataset'), manifest);
  });

  it('uses the public loader and enforces version bumps against a git base', {
    timeout: 20_000,
  }, async (context) => {
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
    const git = (...args: string[]) =>
      spawnSync(
        'git',
        [
          '-c',
          'user.name=forge',
          '-c',
          'user.email=forge@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: root, encoding: 'utf8' },
      );
    git('init', '-q', '-b', 'base');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const invoke = () =>
      spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), entry, '--base', 'base'],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      );
    const unchanged = invoke();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(
      unchanged.stdout,
      'cases: checked 3 datasets and 3 cases against base\n',
    );

    const datasetRoot = path.join(root, REPOSITORY_DATASET_ROOTS[0]!);
    await rewriteCase(datasetRoot, (source) =>
      source.replace('display_name: Hello file', 'display_name: Hello'),
    );
    // Case content is versioned by its owner; only version changes propagate.
    const caseEdited = invoke();
    assert.equal(caseEdited.status, 0, caseEdited.stderr);

    await rewriteCase(datasetRoot, (source) =>
      source.replace('version: 0.1.0', 'version: 0.1.1'),
    );
    const datasetNotBumped = invoke();
    assert.equal(datasetNotBumped.status, 1);
    assert.match(
      datasetNotBumped.stderr,
      /dataset version 0\.2\.0 must change/,
    );

    await rewriteManifest(datasetRoot, (manifest) => {
      manifest.dataset.version = '0.3.0';
    });
    const bumped = invoke();
    assert.equal(bumped.status, 0, bumped.stderr);

    await fs.writeFile(path.join(datasetRoot, 'manifest.json'), '{}');
    const invalid = invoke();
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /^cases: test\/fixtures\/one-shot\/dataset:/);
  });
});

describe('dataset version propagation', () => {
  const manifest = (
    datasetVersion: string,
    ...cases: Array<[id: string, version: string]>
  ): DatasetManifestV1 => ({
    dataset: { id: 'd', version: datasetVersion },
    cases: cases.map(([id, version]) => ({
      id,
      version,
      path: `cases/${id}.case.yaml`,
    })),
  });

  it('rejects a changed dataset ID', () => {
    const base = manifest('1.0.0', ['d/a', '1.0.0']);
    const renamed = structuredClone(base);
    renamed.dataset.id = 'e';
    assert.match(
      datasetVersionViolations(base, renamed)[0]!,
      /dataset ID changed/,
    );
  });

  it('accepts unchanged datasets and fully propagated bumps', () => {
    const base = manifest('1.0.0', ['d/a', '1.0.0']);
    assert.deepEqual(datasetVersionViolations(base, base), []);
    assert.deepEqual(
      datasetVersionViolations(base, manifest('1.1.0', ['d/a', '1.1.0'])),
      [],
    );
  });

  it('requires a dataset bump for case version or membership changes', () => {
    const base = manifest('1.0.0', ['d/a', '1.0.0']);
    const message =
      'case versions or membership changed, so dataset version 1.0.0 must change.';
    for (const candidate of [
      manifest('1.0.0', ['d/a', '1.0.1']),
      manifest('1.0.0', ['d/a', '1.0.0'], ['d/b', '1.0.0']),
      manifest('1.0.0', ['d/b', '1.0.0']),
    ]) {
      assert.deepEqual(datasetVersionViolations(base, candidate), [message]);
    }
  });
});

function noBaseline(): undefined {
  return undefined;
}

async function rewriteCase(
  datasetRoot: string,
  edit: (source: string) => string,
): Promise<void> {
  await rewriteManifest(datasetRoot, async (manifest) => {
    const entry = manifest.cases[0]!;
    const casePath = path.join(datasetRoot, entry.path);
    const source = edit(await fs.readFile(casePath, 'utf8'));
    await fs.writeFile(casePath, source);
    entry.version = /^version: (.*)$/m.exec(source)?.[1] ?? entry.version;
  });
}

async function rewriteManifest(
  datasetRoot: string,
  edit: (manifest: DatasetManifestV1) => void | Promise<void>,
): Promise<void> {
  const manifestPath = path.join(datasetRoot, 'manifest.json');
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, 'utf8'),
  ) as DatasetManifestV1;
  await edit(manifest);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
}

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
