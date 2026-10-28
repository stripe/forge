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
  it('loads cases by stable ID', async () => {
    const fixture = await createDataset();
    const loaded = await loadDataset(fixture.root);

    assert.equal(loaded.manifestRaw, fixture.manifestRaw);
    assert.equal(
      loaded.cases.get('smoke/write')?.definition.task,
      'Create greeting.txt',
    );
  });

  it('requires the manifest to list exactly the case definitions present', async () => {
    const missing = await createDataset();
    await fs.rm(missing.casePath);
    await assert.rejects(loadDataset(missing.root), {
      code: 'dataset_integrity_mismatch',
      message: /listed in the manifest but absent/,
    });

    const unlisted = await createDataset();
    await fs.writeFile(
      path.join(unlisted.root, 'cases', 'extra.case.yaml'),
      'id: smoke/extra\n',
    );
    await assert.rejects(loadDataset(unlisted.root), {
      code: 'dataset_integrity_mismatch',
      message: /"cases\/extra.case.yaml" is absent from the manifest/,
    });

    const fixture = await createDataset();
    await fs.writeFile(path.join(fixture.root, 'fixtures', 'more.txt'), 'm');
    assert.equal((await loadDataset(fixture.root)).cases.size, 1);

    const linked = await createDataset();
    await fs.symlink(linked.casePath, path.join(linked.root, 'linked.yaml'));
    await assert.rejects(loadDataset(linked.root), { code: 'unsafe_path' });
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
    assert.equal(indexLoadedDatasetCases(dataset).size, 1);
  });

  it('requires case forge/write sources to name a dataset file or directory', async () => {
    const directory = await createDataset();
    await replaceCasePayload(
      directory,
      Buffer.from(
        directory.caseYaml.replace(
          '{dataset_path: fixtures/seed.txt}',
          '{dataset_path: fixtures}',
        ),
      ),
    );
    assert.equal((await loadDataset(directory.root)).cases.size, 1);

    for (const missingPath of ['fixtures/missing.txt', 'fixtures/seed']) {
      const missing = await createDataset();
      await replaceCasePayload(
        missing,
        Buffer.from(
          missing.caseYaml.replace('fixtures/seed.txt}', `${missingPath}}`),
        ),
      );
      await assert.rejects(loadDataset(missing.root), {
        code: 'dataset_integrity_mismatch',
        message: new RegExp(`reads "${missingPath}", which is absent`),
      });
    }

    for (const casePath of ['cases/smoke/write/case.yaml', 'cases']) {
      const exposed = await createDataset();
      await replaceCasePayload(
        exposed,
        Buffer.from(
          exposed.caseYaml.replace('fixtures/seed.txt}', `${casePath}}`),
        ),
      );
      await assert.rejects(loadDataset(exposed.root), {
        code: 'dataset_integrity_mismatch',
        message: /which contains case definitions/,
      });
    }
  });

  it('supplies discovered fixture paths to pure treatment planning', async () => {
    const fixture = await createDataset();
    const dataset = await loadDataset(fixture.root);
    const experimentPath = path.join(
      await temporaryDirectory(),
      'experiment.yaml',
    );
    await fs.writeFile(experimentPath, experimentConfigYaml());
    const experiment = await loadExperimentConfig(experimentPath);
    const selection = expandExperiment(experiment, dataset)[0]!;
    for (const source of ['fixtures', 'fixtures/missing.txt']) {
      experiment.config.treatments.baseline = {
        setup: [
          {
            uses: 'forge/write',
            with: { target: 'app', source: { dataset_path: source } },
          },
        ],
      };
      const plan = () => resolveRunPlan({ dataset, experiment, selection });
      if (source === 'fixtures') {
        assert.equal(plan().setup.length, 2);
      } else {
        assert.throws(plan, {
          code: 'invalid_dataset_input',
          message: /absent from the dataset/,
        });
      }
    }
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
    await fs.writeFile(target, experimentConfigYaml());
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
    const raw = experimentConfigYaml();
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
    await fs.writeFile(experimentPath, experimentConfigYaml());
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
        Buffer.from(`${experimentConfigYaml()}\n# `),
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

function experimentConfigYaml(): string {
  return `
id: forge-smoke
version: 2026.09.0
dataset:
  id: forge-smoke
  version: 2026.09.0
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
