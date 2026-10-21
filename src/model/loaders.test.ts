import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  expandExperiment,
  resolveRunPlan,
  serializeResolvedRunPlan,
} from '../planning/planner.ts';
import { sha256Digest, sha256Hex } from './hashes.ts';
import {
  indexLoadedDatasetCases,
  loadDataset,
  loadExperimentConfig,
} from './loaders.ts';
import {
  MAX_BENCHMARK_YAML_BYTES,
  MAX_DATASET_MANIFEST_BYTES,
} from './parse.ts';
import type { DatasetManifestV1 } from './types.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('benchmark filesystem loaders', () => {
  it('verifies a complete dataset and loads cases by stable ID', async () => {
    const fixture = await createDataset();
    const loaded = await loadDataset(fixture.root);

    assert.equal(loaded.manifestSha256, sha256Digest(fixture.manifestRaw));
    assert.equal(
      loaded.cases.get('smoke/write')?.definition.task,
      'Create greeting.txt',
    );
    assert.equal('sha256' in loaded.cases.get('smoke/write')!, false);
  });

  it('fails closed for tampered, extra, and symlinked payloads', async () => {
    const tampered = await createDataset();
    await fs.appendFile(tampered.casePath, '\n# changed');
    await assert.rejects(loadDataset(tampered.root), {
      code: 'dataset_integrity_mismatch',
    });

    const extra = await createDataset();
    await fs.writeFile(path.join(extra.root, 'extra.txt'), 'not declared');
    await assert.rejects(loadDataset(extra.root), {
      code: 'dataset_integrity_mismatch',
    });

    const linked = await createDataset();
    await fs.symlink(linked.casePath, path.join(linked.root, 'linked.yaml'));
    await assert.rejects(loadDataset(linked.root), { code: 'unsafe_path' });
  });

  it('checks hashes for same-size case and fixture corruption', async () => {
    const caseFixture = await createDataset();
    const changedCase = caseFixture.caseYaml.replace(
      'greeting.txt',
      'farewell.txt',
    );
    assert.equal(
      Buffer.byteLength(changedCase),
      Buffer.byteLength(caseFixture.caseYaml),
    );
    await fs.writeFile(caseFixture.casePath, changedCase);
    await assert.rejects(loadDataset(caseFixture.root), {
      code: 'dataset_integrity_mismatch',
      message: /declared size or hash/,
    });

    const inputFixture = await createDataset();
    await fs.writeFile(
      path.join(inputFixture.root, 'fixtures', 'seed.txt'),
      'reed',
    );
    await assert.rejects(loadDataset(inputFixture.root), {
      code: 'dataset_integrity_mismatch',
      message: /declared size or hash/,
    });
  });

  it('requires the definition ID and version to match the manifest entry, independent of filename', async () => {
    for (const [from, to] of [
      ['id: smoke/write', 'id: smoke/other'],
      ['version: 0.1.0', 'version: 0.2.0'],
    ] as const) {
      const fixture = await createDataset();
      const changedCase = fixture.caseYaml.replace(from, to);
      await replaceCasePayload(fixture, Buffer.from(changedCase));
      await assert.rejects(loadDataset(fixture.root), {
        code: 'dataset_integrity_mismatch',
        message: /but the manifest lists smoke\/write@0\.1\.0/,
      });
    }

    const renamed = await createDataset();
    const changedCase = renamed.caseYaml.replace(
      'id: smoke/write',
      'id: smoke/other',
    );
    await replaceCasePayload(renamed, Buffer.from(changedCase), {
      id: 'smoke/other',
    });
    const loaded = await loadDataset(renamed.root);
    assert.equal(loaded.cases.has('smoke/write'), false);
    assert.equal(loaded.cases.get('smoke/other')?.path, renamed.casePath);
  });

  it('rejects a host-supplied dataset whose manifest version disagrees with its case', async () => {
    const dataset = await loadDataset((await createDataset()).root);
    const [entry] = dataset.manifest.cases;
    const tampered = {
      ...dataset,
      manifest: {
        ...dataset.manifest,
        cases: [{ ...entry!, version: '0.2.0' }],
      },
    };
    assert.throws(() => indexLoadedDatasetCases(tampered), {
      code: 'dataset_integrity_mismatch',
      message: /declares smoke\/write@0\.1\.0/,
    });
    assert.throws(
      () =>
        indexLoadedDatasetCases({
          ...dataset,
          manifest: {
            ...dataset.manifest,
            cases: [{ ...entry!, files: [] }],
          },
        }),
      {
        code: 'dataset_integrity_mismatch',
        message: /must exactly match the fixtures it declares/,
      },
    );
    assert.equal(indexLoadedDatasetCases(dataset).size, 1);
  });

  it('requires manifest files to match the fixtures each case declares', async () => {
    // The manifest records a fixture the case does not declare.
    const undeclared = await createDataset();
    await replaceCasePayload(
      undeclared,
      Buffer.from(
        undeclared.caseYaml.replace('fixtures: [fixtures/seed.txt]\n', ''),
      ),
    );
    await assert.rejects(loadDataset(undeclared.root), {
      code: 'dataset_integrity_mismatch',
      message: /manifest files must exactly match the fixtures it declares/,
    });

    // The case declares a fixture the manifest does not record.
    const unrecorded = await createDataset();
    const unrecordedManifest = JSON.parse(
      unrecorded.manifestRaw,
    ) as DatasetManifestV1;
    unrecordedManifest.cases[0]!.files = [];
    await fs.rm(path.join(unrecorded.root, 'fixtures'), { recursive: true });
    await fs.writeFile(
      path.join(unrecorded.root, 'manifest.json'),
      JSON.stringify(unrecordedManifest),
    );
    await assert.rejects(loadDataset(unrecorded.root), {
      code: 'dataset_integrity_mismatch',
      message: /manifest files must exactly match the fixtures it declares/,
    });

    // Another case owns the fixture; this case reads it without declaring it.
    const borrowed = await createDataset();
    const borrowedManifest = JSON.parse(
      borrowed.manifestRaw,
    ) as DatasetManifestV1;
    const [owner] = borrowedManifest.cases;
    const ownerYaml = borrowed.caseYaml.replace(
      'fixtures: [fixtures/seed.txt]\n',
      '',
    );
    await fs.writeFile(borrowed.casePath, ownerYaml);
    const otherYaml =
      'id: smoke/other\nversion: 0.1.0\nfixtures: [fixtures/seed.txt]\nexecution_mode: one_shot\ninitial_prompt: Go.\n';
    await fs.writeFile(
      path.join(borrowed.root, 'cases', 'other.case.yaml'),
      otherYaml,
    );
    borrowedManifest.cases = [
      {
        ...owner!,
        size: Buffer.byteLength(ownerYaml),
        sha256: sha256Hex(ownerYaml),
        files: [],
      },
      {
        id: 'smoke/other',
        version: '0.1.0',
        path: 'cases/other.case.yaml',
        size: Buffer.byteLength(otherYaml),
        sha256: sha256Hex(otherYaml),
        files: owner!.files,
      },
    ];
    await fs.writeFile(
      path.join(borrowed.root, 'manifest.json'),
      JSON.stringify(borrowedManifest),
    );
    await assert.rejects(loadDataset(borrowed.root), {
      code: 'dataset_integrity_mismatch',
      message: /smoke\/write reads "fixtures\/seed.txt" without declaring it/,
    });

    // The case declares the fixture, but forge/write reads a different file.
    const unread = await createDataset();
    await fs.writeFile(
      path.join(unread.root, 'fixtures', 'other.txt'),
      'other',
    );
    const manifest = JSON.parse(unread.manifestRaw) as DatasetManifestV1;
    manifest.cases[0]!.files.push({
      path: 'fixtures/other.txt',
      size: 5,
      sha256: sha256Hex('other'),
    });
    await fs.writeFile(
      path.join(unread.root, 'manifest.json'),
      JSON.stringify(manifest),
    );
    await replaceCasePayload(
      { ...unread, manifestRaw: JSON.stringify(manifest) },
      Buffer.from(
        unread.caseYaml
          .replace(
            'fixtures: [fixtures/seed.txt]',
            'fixtures: [fixtures/seed.txt, fixtures/other.txt]',
          )
          .replace(
            '{dataset_path: fixtures/seed.txt}',
            '{dataset_path: fixtures/missing.txt}',
          ),
      ),
    );
    await assert.rejects(loadDataset(unread.root), {
      code: 'dataset_integrity_mismatch',
      message: /reads "fixtures\/missing.txt" without declaring it in fixtures/,
    });
  });

  it('rejects duplicate authored IDs across every case', async () => {
    const fixture = await createDataset();
    await appendCase(
      fixture.root,
      'other/case',
      'cases/unselected/first.case.yaml',
    );
    await appendCase(
      fixture.root,
      'other/case',
      'cases/unselected/second/case.yaml',
    );
    await assert.rejects(loadDataset(fixture.root), {
      code: 'invalid_manifest',
      message: /id values must be unique/,
    });
  });

  it('parses unselected definitions and rejects missing or invalid authored IDs', async () => {
    for (const id of ['invalid_case', '']) {
      const fixture = await createDataset();
      await appendCase(
        fixture.root,
        id,
        'cases/unselected.case.yaml',
        'unselected/case',
      );
      await assert.rejects(loadDataset(fixture.root), { code: 'invalid_case' });
    }
  });

  it('rejects oversized documents before parsing their bytes', async () => {
    const fixture = await createDataset();
    await fs.truncate(
      path.join(fixture.root, 'manifest.json'),
      MAX_DATASET_MANIFEST_BYTES + 1,
    );
    await assert.rejects(loadDataset(fixture.root), {
      code: 'invalid_manifest',
      message: /byte limit/,
    });

    const experimentPath = path.join(
      await temporaryDirectory(),
      'experiment.yaml',
    );
    await fs.writeFile(experimentPath, '');
    await fs.truncate(experimentPath, MAX_BENCHMARK_YAML_BYTES + 1);
    await assert.rejects(loadExperimentConfig(experimentPath), {
      code: 'invalid_yaml',
      message: /byte limit/,
    });
  });

  it('requires a present regular experiment file without following symlinks', async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, 'experiment.yaml');
    const link = path.join(root, 'linked.yaml');
    await fs.writeFile(target, experimentConfigYaml('a'.repeat(64)));
    await fs.symlink(target, link);
    await assert.rejects(loadExperimentConfig(link), { code: 'unsafe_path' });
    await assert.rejects(
      loadExperimentConfig(path.join(root, 'missing.yaml')),
      { code: 'unsafe_path' },
    );
  });

  it('loads an experiment config without an unused source digest', async () => {
    const root = await temporaryDirectory();
    const experimentPath = path.join(root, 'default.yaml');
    const raw = experimentConfigYaml('a'.repeat(64));
    await fs.writeFile(experimentPath, raw);

    const loaded = await loadExperimentConfig(experimentPath);
    assert.equal(loaded.raw, raw);
    assert.equal('sha256' in loaded, false);
    assert.equal(loaded.config.id, 'forge-smoke');
  });

  it('resolves the same selected plan after a comment-only experiment edit', async () => {
    const fixture = await createDataset();
    const dataset = await loadDataset(fixture.root);
    const experimentPath = path.join(
      await temporaryDirectory(),
      'experiment.yaml',
    );
    await fs.writeFile(
      experimentPath,
      experimentConfigYaml(dataset.manifestSha256.slice(7)),
    );
    const original = await loadExperimentConfig(experimentPath);
    await fs.appendFile(
      experimentPath,
      '\n# Clarify the experiment without changing it.\n',
    );
    const edited = await loadExperimentConfig(experimentPath);
    const selection = expandExperiment(original, dataset)[0]!;
    assert.equal(
      serializeResolvedRunPlan(
        resolveRunPlan({ dataset, experiment: edited, selection }),
      ),
      serializeResolvedRunPlan(
        resolveRunPlan({ dataset, experiment: original, selection }),
      ),
    );
  });

  it('rejects malformed UTF-8 instead of replacing bytes before parsing', async () => {
    const fixture = await createDataset();
    await fs.writeFile(
      path.join(fixture.root, 'manifest.json'),
      Buffer.concat([Buffer.from(fixture.manifestRaw), Buffer.from([0x80])]),
    );
    await assert.rejects(loadDataset(fixture.root), {
      code: 'invalid_manifest',
      message: /valid UTF-8/,
    });

    const experimentPath = path.join(
      await temporaryDirectory(),
      'experiment.yaml',
    );
    await fs.writeFile(
      experimentPath,
      Buffer.concat([
        Buffer.from(`${experimentConfigYaml('a'.repeat(64))}\n# `),
        Buffer.from([0x80]),
        Buffer.from('\n'),
      ]),
    );
    await assert.rejects(loadExperimentConfig(experimentPath), {
      code: 'invalid_yaml',
      message: /valid UTF-8/,
    });

    const caseFixture = await createDataset();
    await replaceCasePayload(
      caseFixture,
      Buffer.concat([
        Buffer.from(`${caseFixture.caseYaml}\n# `),
        Buffer.from([0x80]),
        Buffer.from('\n'),
      ]),
    );
    await assert.rejects(loadDataset(caseFixture.root), {
      code: 'invalid_yaml',
      message: /valid UTF-8/,
    });
  });
});

async function appendCase(
  root: string,
  id: string,
  casePath: string,
  manifestId = id,
): Promise<void> {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, 'utf8'),
  ) as DatasetManifestV1;
  const body = `${id === '' ? '' : `id: ${id}\n`}version: 0.1.0\nexecution_mode: one_shot\ninitial_prompt: Complete the task.\n`;
  const absolutePath = path.join(root, ...casePath.split('/'));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body);
  manifest.cases.push({
    id: manifestId,
    version: '0.1.0',
    path: casePath,
    size: Buffer.byteLength(body),
    sha256: sha256Hex(body),
    files: [],
  });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
}

async function replaceCasePayload(
  fixture: { root: string; casePath: string; manifestRaw: string },
  body: Buffer,
  identity: { id?: string } = {},
): Promise<void> {
  const manifest = JSON.parse(fixture.manifestRaw) as DatasetManifestV1;
  const entry = manifest.cases[0]!;
  if (identity.id !== undefined) entry.id = identity.id;
  entry.size = body.byteLength;
  entry.sha256 = sha256Hex(body);
  await fs.writeFile(fixture.casePath, body);
  await fs.writeFile(
    path.join(fixture.root, 'manifest.json'),
    JSON.stringify(manifest),
  );
}

async function createDataset(): Promise<{
  root: string;
  casePath: string;
  caseYaml: string;
  manifestRaw: string;
}> {
  const root = await temporaryDirectory();
  const casePath = path.join(root, 'cases', 'smoke', 'write', 'case.yaml');
  const inputPath = path.join(root, 'fixtures', 'seed.txt');
  const caseYaml = `
id: smoke/write
version: 0.1.0
fixtures: [fixtures/seed.txt]
execution_mode: one_shot
task: Create greeting.txt
setup:
  - uses: forge/write
    with:
      target: seed.txt
      source: {dataset_path: fixtures/seed.txt}
`;
  const input = 'seed';
  await fs.mkdir(path.dirname(casePath), { recursive: true });
  await fs.mkdir(path.dirname(inputPath), { recursive: true });
  await fs.writeFile(casePath, caseYaml);
  await fs.writeFile(inputPath, input);
  const manifestRaw = `${JSON.stringify({
    dataset: { id: 'forge-smoke', version: '2026.09.0' },
    cases: [
      {
        id: 'smoke/write',
        version: '0.1.0',
        path: 'cases/smoke/write/case.yaml',
        size: Buffer.byteLength(caseYaml),
        sha256: sha256Hex(caseYaml),
        files: [
          {
            path: 'fixtures/seed.txt',
            size: Buffer.byteLength(input),
            sha256: sha256Hex(input),
          },
        ],
      },
    ],
  })}\n`;
  await fs.writeFile(path.join(root, 'manifest.json'), manifestRaw);
  return { root, casePath, caseYaml, manifestRaw };
}

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-model-test-'));
  temporaryRoots.push(root);
  return root;
}

function experimentConfigYaml(manifestHash: string): string {
  return `
id: forge-smoke
version: 2026.09.0
dataset:
  id: forge-smoke
  version: 2026.09.0
  manifest_sha256: sha256:${manifestHash}
runtime:
  adapter: docker
  image: {kind: forge}
  platform: linux/amd64
matrix:
  cases: [cases/smoke/write/case.yaml]
  treatments: [baseline]
  agents:
    - {adapter: claude-code, provider: anthropic, model: claude-sonnet-4-6}
`;
}
