import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {sha256Hex} from '../model/hashes.js';
import {loadDataset} from '../model/loaders.js';
import type {LoadedDatasetV1} from '../model/types.js';
import {
  ManifestCaseFileError,
  resolveManifestCaseIdFromFile,
} from './caseFile.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) =>
      fs.rm(cleanupPath, {recursive: true, force: true}),
    ),
  );
});

describe('resolveManifestCaseIdFromFile', () => {
  it('selects only the exact manifest-backed case target', async () => {
    const {dataset, caseFile} = await createDataset();

    await expect(
      resolveManifestCaseIdFromFile(dataset, caseFile),
    ).resolves.toBe('sample/write');

    const alias = `${dataset.root}-case-alias`;
    cleanupPaths.push(alias);
    await fs.symlink(caseFile, alias);
    await expect(
      resolveManifestCaseIdFromFile(dataset, alias),
    ).resolves.toBe('sample/write');
  });

  it('rejects payload files, files outside the dataset, and non-files', async () => {
    const {dataset, fixtureFile} = await createDataset();
    await expectCode(
      resolveManifestCaseIdFromFile(dataset, fixtureFile),
      'case_file_not_in_manifest',
    );

    const outsideRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-case-file-outside-'),
    );
    cleanupPaths.push(outsideRoot);
    const outsideFile = path.join(outsideRoot, 'eval.yaml');
    await fs.writeFile(outsideFile, 'not part of the dataset');
    await expectCode(
      resolveManifestCaseIdFromFile(dataset, outsideFile),
      'case_file_outside_dataset',
    );
    await expectCode(
      resolveManifestCaseIdFromFile(dataset, dataset.root),
      'invalid_case_file',
    );
  });

  it('rejects ambiguous or inconsistent loaded-dataset indexes', async () => {
    const {dataset, caseFile, fixtureFile} = await createDataset();
    const duplicate: LoadedDatasetV1 = {
      ...dataset,
      manifest: {
        ...dataset.manifest,
        cases: [
          ...dataset.manifest.cases,
          {id: 'sample/duplicate', path: dataset.manifest.cases[0]!.path},
        ],
      },
    };
    await expectCode(
      resolveManifestCaseIdFromFile(duplicate, caseFile),
      'ambiguous_case_file',
    );

    const loadedCase = dataset.cases.get('sample/write')!;
    for (const cases of [
      new Map(),
      new Map([['sample/write', {
        ...loadedCase,
        definition: {...loadedCase.definition, id: 'sample/other'},
      }]]),
      new Map([['sample/write', {...loadedCase, path: fixtureFile}]]),
    ]) {
      await expectCode(
        resolveManifestCaseIdFromFile({...dataset, cases}, caseFile),
        'invalid_loaded_dataset',
      );
    }
  });

  it('requires a canonical dataset root even when the case target is valid', async () => {
    const {dataset, caseFile} = await createDataset();
    const rootAlias = `${dataset.root}-root-alias`;
    cleanupPaths.push(rootAlias);
    await fs.symlink(dataset.root, rootAlias, 'dir');
    await expectCode(
      resolveManifestCaseIdFromFile({...dataset, root: rootAlias}, caseFile),
      'invalid_loaded_dataset',
    );

    await expectCode(
      resolveManifestCaseIdFromFile({...dataset, root: caseFile}, caseFile),
      'invalid_loaded_dataset',
    );
  });

  it('fails closed if a verified manifest path is replaced by a symlink', async () => {
    const {dataset, caseFile} = await createDataset();
    const outsideRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-case-file-replacement-'),
    );
    cleanupPaths.push(outsideRoot);
    const replacement = path.join(outsideRoot, 'replacement.yaml');
    await fs.writeFile(replacement, 'replacement');
    await fs.rm(caseFile);
    await fs.symlink(replacement, caseFile);

    await expectCode(
      resolveManifestCaseIdFromFile(dataset, caseFile),
      'invalid_loaded_dataset',
    );
  });
});

async function createDataset(): Promise<{
  dataset: LoadedDatasetV1;
  caseFile: string;
  fixtureFile: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-case-file-'));
  cleanupPaths.push(root);
  const casePath = 'cases/sample/write/eval.yaml';
  const fixturePath = 'cases/sample/write/fixtures/input.txt';
  const caseFile = path.join(root, ...casePath.split('/'));
  const fixtureFile = path.join(root, ...fixturePath.split('/'));
  const caseBody = Buffer.from(
    [
      'schema_version: 1',
      'id: sample/write',
      'execution_mode: one_shot',
      'initial_prompt: Write a file.',
      '',
    ].join('\n'),
  );
  const fixtureBody = Buffer.from('fixture');
  await fs.mkdir(path.dirname(fixtureFile), {recursive: true});
  await fs.writeFile(caseFile, caseBody);
  await fs.writeFile(fixtureFile, fixtureBody);
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      dataset: {id: 'case-file-test', version: '1.0.0'},
      cases: [{id: 'sample/write', path: casePath}],
      files: [
        {
          path: casePath,
          size: caseBody.byteLength,
          sha256: sha256Hex(caseBody),
        },
        {
          path: fixturePath,
          size: fixtureBody.byteLength,
          sha256: sha256Hex(fixtureBody),
        },
      ],
    }),
  );
  return {dataset: await loadDataset(root), caseFile, fixtureFile};
}

async function expectCode(
  promise: Promise<unknown>,
  code: ManifestCaseFileError['code'],
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestCaseFileError);
    expect((error as ManifestCaseFileError).code).toBe(code);
  }
}
