import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { sha256Hex } from '../model/hashes.ts';
import { loadDataset } from '../model/loaders.ts';
import type { LoadedDatasetV1 } from '../model/types.ts';
import {
  ManifestCaseFileError,
  resolveManifestCaseIdFromFile,
} from './caseFile.ts';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((cleanupPath) =>
        fs.rm(cleanupPath, { recursive: true, force: true }),
      ),
  );
});

describe('resolveManifestCaseIdFromFile', () => {
  it('selects only the exact manifest-backed case target', async () => {
    const { dataset, caseFile } = await createDataset();

    assert.equal(
      await resolveManifestCaseIdFromFile(dataset, caseFile),
      'sample/write',
    );

    const alias = `${dataset.root}-case-alias`;
    cleanupPaths.push(alias);
    await fs.symlink(caseFile, alias);
    assert.equal(
      await resolveManifestCaseIdFromFile(dataset, alias),
      'sample/write',
    );
  });

  it('rejects payload files, files outside the dataset, and non-files', async () => {
    const { dataset, fixtureFile } = await createDataset();
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

  it('rejects a lexical path through a symlinked parent inside the dataset', async () => {
    const { dataset, caseFile } = await createDataset();
    const alias = path.join(dataset.root, 'inside-alias');
    await fs.symlink(path.dirname(caseFile), alias, 'dir');
    await expectCode(
      resolveManifestCaseIdFromFile(
        dataset,
        path.join(alias, path.basename(caseFile)),
      ),
      'invalid_loaded_dataset',
    );
  });

  it('rejects ambiguous or inconsistent loaded-dataset indexes', async () => {
    const { dataset, caseFile, fixtureFile } = await createDataset();
    const duplicate: LoadedDatasetV1 = {
      ...dataset,
      manifest: {
        ...dataset.manifest,
        cases: [...dataset.manifest.cases, dataset.manifest.cases[0]!],
      },
    };
    await expectCode(
      resolveManifestCaseIdFromFile(duplicate, caseFile),
      'ambiguous_case_file',
    );

    const loadedCase = dataset.cases.get('sample/write')!;
    for (const cases of [
      new Map(),
      new Map([
        [
          'sample/write',
          {
            ...loadedCase,
            definition: { ...loadedCase.definition, id: 'sample/other' },
          },
        ],
      ]),
      new Map([['sample/write', { ...loadedCase, path: fixtureFile }]]),
    ]) {
      await expectCode(
        resolveManifestCaseIdFromFile({ ...dataset, cases }, caseFile),
        'invalid_loaded_dataset',
      );
    }
  });

  it('requires a canonical dataset root even when the case target is valid', async () => {
    const { dataset, caseFile } = await createDataset();
    const rootAlias = `${dataset.root}-root-alias`;
    cleanupPaths.push(rootAlias);
    await fs.symlink(dataset.root, rootAlias, 'dir');
    await expectCode(
      resolveManifestCaseIdFromFile({ ...dataset, root: rootAlias }, caseFile),
      'invalid_loaded_dataset',
    );

    await expectCode(
      resolveManifestCaseIdFromFile({ ...dataset, root: caseFile }, caseFile),
      'invalid_loaded_dataset',
    );
  });

  it('rejects forged unselected cases and replaced unselected manifest targets', async () => {
    const { dataset, caseFile, otherCaseFile } = await createDataset();
    const selectedCase = dataset.cases.get('sample/write')!;
    const otherCase = dataset.cases.get('unselected')!;
    for (const changed of [
      {
        ...otherCase,
        definition: { ...otherCase.definition, id: 'sample/write' },
      },
      { ...otherCase, path: caseFile },
      { ...otherCase, path: '/outside/other.case.yaml' },
    ]) {
      await expectCode(
        resolveManifestCaseIdFromFile(
          {
            ...dataset,
            cases: new Map([
              ['sample/write', selectedCase],
              ['unselected', changed],
            ]),
          },
          caseFile,
        ),
        'invalid_loaded_dataset',
      );
    }
    const extra = {
      ...otherCase,
      definition: { ...otherCase.definition, id: 'extra' },
    };
    await expectCode(
      resolveManifestCaseIdFromFile(
        { ...dataset, cases: new Map([...dataset.cases, ['extra', extra]]) },
        caseFile,
      ),
      'invalid_loaded_dataset',
    );
    await fs.rm(otherCaseFile);
    await fs.symlink(caseFile, otherCaseFile);
    await expectCode(
      resolveManifestCaseIdFromFile(dataset, caseFile),
      'invalid_loaded_dataset',
    );
  });

  it('fails closed if a verified manifest path is replaced by a symlink', async () => {
    const { dataset, caseFile } = await createDataset();
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
  otherCaseFile: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-case-file-'));
  cleanupPaths.push(root);
  const casePath = 'cases/sample/write/case.yaml';
  const fixturePath = 'cases/sample/write/fixtures/input.txt';
  const otherCasePath = 'cases/unselected/other.case.yaml';
  const caseFile = path.join(root, ...casePath.split('/'));
  const fixtureFile = path.join(root, ...fixturePath.split('/'));
  const otherCaseFile = path.join(root, ...otherCasePath.split('/'));
  const caseBody = Buffer.from(
    [
      'id: sample/write',
      'version: 0.1.0',
      `fixtures: [${fixturePath}]`,
      'execution_mode: one_shot',
      'initial_prompt: Write a file.',
      '',
    ].join('\n'),
  );
  const fixtureBody = Buffer.from('fixture');
  const otherCaseBody = Buffer.from(
    'id: unselected\nversion: 0.1.0\nexecution_mode: one_shot\ninitial_prompt: Another task.\n',
  );
  await fs.mkdir(path.dirname(fixtureFile), { recursive: true });
  await fs.writeFile(caseFile, caseBody);
  await fs.writeFile(fixtureFile, fixtureBody);
  await fs.mkdir(path.dirname(otherCaseFile), { recursive: true });
  await fs.writeFile(otherCaseFile, otherCaseBody);
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      dataset: { id: 'case-file-test', version: '1.0.0' },
      cases: [
        {
          id: 'sample/write',
          version: '0.1.0',
          path: casePath,
          size: caseBody.byteLength,
          sha256: sha256Hex(caseBody),
          files: [
            {
              path: fixturePath,
              size: fixtureBody.byteLength,
              sha256: sha256Hex(fixtureBody),
            },
          ],
        },
        {
          id: 'unselected',
          version: '0.1.0',
          path: otherCasePath,
          size: otherCaseBody.byteLength,
          sha256: sha256Hex(otherCaseBody),
        },
      ],
    }),
  );
  return {
    dataset: await loadDataset(root),
    caseFile,
    fixtureFile,
    otherCaseFile,
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: ManifestCaseFileError['code'],
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    assert.ok(error instanceof ManifestCaseFileError);
    assert.equal((error as ManifestCaseFileError).code, code);
  }
}
