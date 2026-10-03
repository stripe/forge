import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {sha256Digest, sha256Hex} from './hashes.js';
import {loadDataset, loadExperimentConfig} from './loaders.js';
import {MAX_BENCHMARK_YAML_BYTES, MAX_DATASET_MANIFEST_BYTES} from './parse.js';
import {expandExperiment, resolveRunPlan, serializeResolvedRunPlan} from '../planning/planner.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})),
  );
});

describe('benchmark filesystem loaders', () => {
  it('verifies a complete dataset and loads cases by stable ID', async () => {
    const fixture = await createDataset();
    const loaded = await loadDataset(fixture.root);

    expect(loaded.manifestSha256).toBe(sha256Digest(fixture.manifestRaw));
    expect(loaded.cases.get('smoke/write')?.definition.task).toBe(
      'Create greeting.txt',
    );
    expect('sha256' in loaded.cases.get('smoke/write')!).toBe(false);
  });

  it('fails closed for tampered, extra, and symlinked payloads', async () => {
    const tampered = await createDataset();
    await fs.appendFile(tampered.casePath, '\n# changed');
    await expect(loadDataset(tampered.root)).rejects.toMatchObject({
      code: 'dataset_integrity_mismatch',
    });

    const extra = await createDataset();
    await fs.writeFile(path.join(extra.root, 'extra.txt'), 'not declared');
    await expect(loadDataset(extra.root)).rejects.toMatchObject({
      code: 'dataset_integrity_mismatch',
    });

    const linked = await createDataset();
    await fs.symlink(linked.casePath, path.join(linked.root, 'linked.yaml'));
    await expect(loadDataset(linked.root)).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });

  it('checks hashes for same-size case and fixture corruption', async () => {
    const caseFixture = await createDataset();
    const changedCase = caseFixture.caseYaml.replace('greeting.txt', 'farewell.txt');
    expect(Buffer.byteLength(changedCase)).toBe(Buffer.byteLength(caseFixture.caseYaml));
    await fs.writeFile(caseFixture.casePath, changedCase);
    await expect(loadDataset(caseFixture.root)).rejects.toMatchObject({
      code: 'dataset_integrity_mismatch',
      message: expect.stringContaining('declared size or hash'),
    });

    const inputFixture = await createDataset();
    await fs.writeFile(path.join(inputFixture.root, 'fixtures', 'seed.txt'), 'reed');
    await expect(loadDataset(inputFixture.root)).rejects.toMatchObject({
      code: 'dataset_integrity_mismatch',
      message: expect.stringContaining('declared size or hash'),
    });
  });

  it('rejects a correctly hashed case with a different manifest ID', async () => {
    const fixture = await createDataset();
    const changedCase = fixture.caseYaml.replace('id: smoke/write', 'id: smoke/other');
    await replaceCasePayload(fixture, Buffer.from(changedCase));
    await expect(loadDataset(fixture.root)).rejects.toMatchObject({
      code: 'dataset_integrity_mismatch',
      message: expect.stringContaining('ID does not match'),
    });
  });

  it('rejects oversized documents before parsing their bytes', async () => {
    const fixture = await createDataset();
    await fs.truncate(path.join(fixture.root, 'manifest.json'), MAX_DATASET_MANIFEST_BYTES + 1);
    await expect(loadDataset(fixture.root)).rejects.toMatchObject({
      code: 'invalid_manifest', message: expect.stringContaining('byte limit'),
    });

    const experimentPath = path.join(await temporaryDirectory(), 'experiment.yaml');
    await fs.writeFile(experimentPath, '');
    await fs.truncate(experimentPath, MAX_BENCHMARK_YAML_BYTES + 1);
    await expect(loadExperimentConfig(experimentPath)).rejects.toMatchObject({
      code: 'invalid_yaml', message: expect.stringContaining('byte limit'),
    });
  });

  it('requires a present regular experiment file without following symlinks', async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, 'experiment.yaml');
    const link = path.join(root, 'linked.yaml');
    await fs.writeFile(target, experimentConfigYaml('a'.repeat(64)));
    await fs.symlink(target, link);
    await expect(loadExperimentConfig(link)).rejects.toMatchObject({code: 'unsafe_path'});
    await expect(loadExperimentConfig(path.join(root, 'missing.yaml')))
      .rejects.toMatchObject({code: 'unsafe_path'});
  });

  it('loads an experiment config without an unused source digest', async () => {
    const root = await temporaryDirectory();
    const experimentPath = path.join(root, 'default.yaml');
    const raw = experimentConfigYaml('a'.repeat(64));
    await fs.writeFile(experimentPath, raw);

    const loaded = await loadExperimentConfig(experimentPath);
    expect(loaded.raw).toBe(raw);
    expect('sha256' in loaded).toBe(false);
    expect(loaded.config.id).toBe('forge-smoke');
  });

  it('resolves the same selected plan after a comment-only experiment edit', async () => {
    const fixture = await createDataset();
    const dataset = await loadDataset(fixture.root);
    const experimentPath = path.join(await temporaryDirectory(), 'experiment.yaml');
    await fs.writeFile(experimentPath, experimentConfigYaml(dataset.manifestSha256.slice(7)));
    const original = await loadExperimentConfig(experimentPath);
    await fs.appendFile(experimentPath, '\n# Clarify the experiment without changing it.\n');
    const edited = await loadExperimentConfig(experimentPath);
    const selection = expandExperiment(original)[0]!;
    expect(serializeResolvedRunPlan(resolveRunPlan({dataset, experiment: edited, selection})))
      .toBe(serializeResolvedRunPlan(resolveRunPlan({dataset, experiment: original, selection})));
  });

  it('rejects malformed UTF-8 instead of replacing bytes before parsing', async () => {
    const fixture = await createDataset();
    await fs.writeFile(path.join(fixture.root, 'manifest.json'), Buffer.concat([
      Buffer.from(fixture.manifestRaw), Buffer.from([0x80]),
    ]));
    await expect(loadDataset(fixture.root)).rejects.toMatchObject({
      code: 'invalid_manifest', message: expect.stringContaining('valid UTF-8'),
    });

    const experimentPath = path.join(await temporaryDirectory(), 'experiment.yaml');
    await fs.writeFile(experimentPath, Buffer.concat([
      Buffer.from(`${experimentConfigYaml('a'.repeat(64))}\n# `),
      Buffer.from([0x80]), Buffer.from('\n'),
    ]));
    await expect(loadExperimentConfig(experimentPath)).rejects.toMatchObject({
      code: 'invalid_yaml', message: expect.stringContaining('valid UTF-8'),
    });

    const caseFixture = await createDataset();
    await replaceCasePayload(caseFixture, Buffer.concat([
      Buffer.from(`${caseFixture.caseYaml}\n# `), Buffer.from([0x80]), Buffer.from('\n'),
    ]));
    await expect(loadDataset(caseFixture.root)).rejects.toMatchObject({
      code: 'invalid_yaml', message: expect.stringContaining('valid UTF-8'),
    });
  });
});

async function replaceCasePayload(
  fixture: {root: string; casePath: string; manifestRaw: string},
  body: Buffer,
): Promise<void> {
  const manifest = JSON.parse(fixture.manifestRaw) as {
    files: {path: string; size: number; sha256: string}[];
  };
  const entry = manifest.files.find(({path: relative}) => relative === 'cases/smoke/write/eval.yaml')!;
  entry.size = body.byteLength;
  entry.sha256 = sha256Hex(body);
  await fs.writeFile(fixture.casePath, body);
  await fs.writeFile(path.join(fixture.root, 'manifest.json'), JSON.stringify(manifest));
}

async function createDataset(): Promise<{
  root: string;
  casePath: string;
  caseYaml: string;
  manifestRaw: string;
}> {
  const root = await temporaryDirectory();
  const casePath = path.join(root, 'cases', 'smoke', 'write', 'eval.yaml');
  const inputPath = path.join(root, 'fixtures', 'seed.txt');
  const caseYaml = `
schema_version: 1
id: smoke/write
execution_mode: one_shot
task: Create greeting.txt
setup:
  - uses: forge/write
    with:
      target: seed.txt
      source: {dataset_path: fixtures/seed.txt}
`;
  const input = 'seed';
  await fs.mkdir(path.dirname(casePath), {recursive: true});
  await fs.mkdir(path.dirname(inputPath), {recursive: true});
  await fs.writeFile(casePath, caseYaml);
  await fs.writeFile(inputPath, input);
  const manifestRaw = `${JSON.stringify({
    schema_version: 1,
    dataset: {id: 'forge-smoke', version: '2026.09.0'},
    cases: [{id: 'smoke/write', path: 'cases/smoke/write/eval.yaml'}],
    files: [
      {
        path: 'cases/smoke/write/eval.yaml',
        size: Buffer.byteLength(caseYaml),
        sha256: sha256Hex(caseYaml),
      },
      {
        path: 'fixtures/seed.txt',
        size: Buffer.byteLength(input),
        sha256: sha256Hex(input),
      },
    ],
  })}\n`;
  await fs.writeFile(path.join(root, 'manifest.json'), manifestRaw);
  return {root, casePath, caseYaml, manifestRaw};
}

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-model-test-'));
  temporaryRoots.push(root);
  return root;
}

function experimentConfigYaml(manifestHash: string): string {
  return `
schema_version: 1
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
  cases: [smoke/write]
  treatments: [baseline]
  agents:
    - {adapter: claude-code, provider: anthropic, model: claude-sonnet-4-6}
`;
}
