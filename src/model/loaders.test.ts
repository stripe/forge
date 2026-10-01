import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {sha256Digest, sha256Hex} from './hashes.js';
import {loadDataset, loadExperimentConfig} from './loaders.js';

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
    expect(loaded.cases.get('smoke/write')?.sha256).toBe(
      sha256Digest(fixture.caseYaml),
    );
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

  it('loads an experiment config with an exact source digest', async () => {
    const root = await temporaryDirectory();
    const experimentPath = path.join(root, 'default.yaml');
    const raw = experimentConfigYaml('a'.repeat(64));
    await fs.writeFile(experimentPath, raw);

    const loaded = await loadExperimentConfig(experimentPath);
    expect(loaded.sha256).toBe(sha256Digest(raw));
    expect(loaded.config.id).toBe('forge-smoke');
  });
});

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
