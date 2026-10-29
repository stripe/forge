import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { indexLoadedDatasetCases } from '../model/loaders.ts';
import {
  isCaseDefinitionPath,
  isSafeDatasetRelativePath,
} from '../model/paths.ts';
import type {
  CaseId,
  DatasetRelativePath,
  LoadedDatasetV1,
  LoadedEvalCaseV1,
} from '../model/types.ts';

export type ManifestCaseFileErrorCode =
  | 'invalid_case_file'
  | 'case_file_outside_dataset'
  | 'case_file_not_in_manifest'
  | 'ambiguous_case_file'
  | 'invalid_loaded_dataset';

/** Stable, path-safe failure from manifest-backed case-file selection. */
export class ManifestCaseFileError extends Error {
  constructor(
    readonly code: ManifestCaseFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManifestCaseFileError';
  }
}

/**
 * Resolve a filesystem path to the one case ID it identifies in a loaded
 * dataset manifest.
 *
 * Both the requested path and manifest target are resolved to canonical paths.
 * Payload files, escaped paths, replaced/symlinked manifest entries, and forged
 * LoadedDataset objects are rejected before a case ID is returned.
 */
export async function resolveManifestCaseIdFromFile(
  dataset: LoadedDatasetV1,
  caseFile: string,
): Promise<CaseId> {
  const root = await canonicalDatasetRoot(dataset);
  const manifestCases = validatedManifestCases(dataset);
  const candidate = await canonicalCaseFile(root, caseFile);
  if (!isWithin(root, candidate)) {
    throw new ManifestCaseFileError(
      'case_file_outside_dataset',
      'The selected case file is outside the loaded dataset.',
    );
  }

  const datasetPath = nativeRelativePathToPosix(path.relative(root, candidate));
  if (!isSafeDatasetRelativePath(datasetPath)) {
    throw new ManifestCaseFileError(
      'case_file_not_in_manifest',
      'The selected file is not a case declared by the dataset manifest.',
    );
  }
  const matches = manifestCases.filter((casePath) => casePath === datasetPath);
  if (matches.length === 0) {
    throw new ManifestCaseFileError(
      'case_file_not_in_manifest',
      'The selected file is not a case declared by the dataset manifest.',
    );
  }
  if (matches.length !== 1) {
    throw new ManifestCaseFileError(
      'ambiguous_case_file',
      'The selected file maps to more than one dataset manifest case.',
    );
  }

  const match = matches[0]!;
  const manifestTarget = await canonicalManifestTarget(root, match);
  if (manifestTarget !== candidate) {
    throw invalidLoadedDataset(
      'The selected manifest case no longer resolves to its verified file.',
    );
  }
  let loadedCase: LoadedEvalCaseV1 | undefined;
  try {
    loadedCase = indexLoadedDatasetCases(dataset).get(match);
  } catch (error) {
    throw invalidLoadedDataset('The loaded case index is unavailable.', error);
  }
  if (
    loadedCase === undefined ||
    path.resolve(loadedCase.path) !== path.resolve(root, ...match.split('/'))
  ) {
    throw invalidLoadedDataset(
      'The loaded case index does not match the dataset manifest.',
    );
  }
  const loadedTarget = await canonicalRegularFile(
    loadedCase.path,
    'The loaded case index references an unavailable file.',
    'invalid_loaded_dataset',
  );
  for (const casePath of manifestCases) {
    if (casePath !== match) await canonicalManifestTarget(root, casePath);
  }
  if (loadedTarget !== manifestTarget) {
    throw invalidLoadedDataset(
      'The loaded case index does not match the verified manifest file.',
    );
  }
  return loadedCase.definition.id;
}

async function canonicalDatasetRoot(dataset: LoadedDatasetV1): Promise<string> {
  if (
    dataset === null ||
    typeof dataset !== 'object' ||
    typeof dataset.root !== 'string' ||
    dataset.root.length === 0 ||
    dataset.root.includes('\0')
  ) {
    throw invalidLoadedDataset('The loaded dataset has an invalid root.');
  }
  const requestedRoot = path.resolve(dataset.root);
  if (requestedRoot === path.parse(requestedRoot).root) {
    throw invalidLoadedDataset(
      'The loaded dataset root cannot be a filesystem root.',
    );
  }
  try {
    const stat = await fs.lstat(requestedRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw invalidLoadedDataset(
        'The loaded dataset root must be a real directory.',
      );
    }
    const canonical = await fs.realpath(requestedRoot);
    if (canonical !== requestedRoot) {
      throw invalidLoadedDataset(
        'The loaded dataset root is not its canonical path.',
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof ManifestCaseFileError) throw error;
    throw invalidLoadedDataset(
      'The loaded dataset root is unavailable.',
      error,
    );
  }
}

function validatedManifestCases(
  dataset: LoadedDatasetV1,
): readonly DatasetRelativePath[] {
  if (
    dataset.manifest === null ||
    typeof dataset.manifest !== 'object' ||
    !Array.isArray(dataset.manifest.cases) ||
    dataset.cases === null ||
    typeof dataset.cases !== 'object' ||
    typeof dataset.cases.get !== 'function'
  ) {
    throw invalidLoadedDataset(
      'The loaded dataset does not contain a valid manifest case index.',
    );
  }
  for (const entry of dataset.manifest.cases) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      !isCaseDefinitionPath(entry.path)
    ) {
      throw invalidLoadedDataset(
        'The loaded dataset manifest contains an invalid case entry.',
      );
    }
  }
  return dataset.manifest.cases.map(({ path }) => path);
}

async function canonicalCaseFile(
  root: string,
  caseFile: string,
): Promise<string> {
  if (
    typeof caseFile !== 'string' ||
    caseFile.length === 0 ||
    caseFile.includes('\0')
  ) {
    throw new ManifestCaseFileError(
      'invalid_case_file',
      'The selected case file path must be a non-empty string.',
    );
  }
  const requested = path.resolve(caseFile);
  try {
    if (isWithin(root, requested)) {
      await assertDatasetPathHasNoSymlinks(root, requested);
    }
    const canonicalParent = await fs.realpath(path.dirname(requested));
    const canonicalRequested = path.join(
      canonicalParent,
      path.basename(requested),
    );
    if (isWithin(root, canonicalRequested)) {
      await assertDatasetPathHasNoSymlinks(root, canonicalRequested);
    }
  } catch (error) {
    if (error instanceof ManifestCaseFileError) throw error;
    throw new ManifestCaseFileError(
      'invalid_case_file',
      'The selected case file is unavailable or is not a regular file.',
      { cause: error },
    );
  }
  return canonicalRegularFile(
    requested,
    'The selected case file is unavailable or is not a regular file.',
    'invalid_case_file',
  );
}

async function assertDatasetPathHasNoSymlinks(
  root: string,
  requested: string,
): Promise<void> {
  const relative = path.relative(root, requested);
  const segments = relative.split(path.sep);
  let current = root;
  try {
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw invalidLoadedDataset(
          'Selected paths inside the dataset cannot contain symbolic links.',
        );
      }
      const isFinal = index === segments.length - 1;
      if (!isFinal && !stat.isDirectory()) {
        throw new Error('An intermediate path is not a directory.');
      }
    }
  } catch (error) {
    if (error instanceof ManifestCaseFileError) throw error;
    throw new ManifestCaseFileError(
      'invalid_case_file',
      'The selected case file is unavailable or is not a regular file.',
      { cause: error },
    );
  }
}

async function canonicalManifestTarget(
  root: string,
  datasetPath: string,
): Promise<string> {
  if (!isSafeDatasetRelativePath(datasetPath)) {
    throw invalidLoadedDataset(
      'The dataset manifest contains an unsafe case path.',
    );
  }
  const segments = datasetPath.split('/');
  let current = root;
  try {
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw invalidLoadedDataset(
          'Dataset manifest case paths cannot contain symbolic links.',
        );
      }
      const isFinal = index === segments.length - 1;
      if ((isFinal && !stat.isFile()) || (!isFinal && !stat.isDirectory())) {
        throw invalidLoadedDataset(
          'A dataset manifest case path has an invalid file type.',
        );
      }
    }
    const canonical = await fs.realpath(current);
    if (!isWithin(root, canonical)) {
      throw invalidLoadedDataset(
        'A dataset manifest case path escapes the dataset root.',
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof ManifestCaseFileError) throw error;
    throw invalidLoadedDataset(
      'A dataset manifest case file is unavailable.',
      error,
    );
  }
}

async function canonicalRegularFile(
  filePath: string,
  message: string,
  code: 'invalid_case_file' | 'invalid_loaded_dataset',
): Promise<string> {
  try {
    const canonical = await fs.realpath(filePath);
    const stat = await fs.lstat(canonical);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Not a regular file.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof ManifestCaseFileError) throw error;
    throw new ManifestCaseFileError(code, message, { cause: error });
  }
}

function nativeRelativePathToPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function invalidLoadedDataset(
  message: string,
  cause?: unknown,
): ManifestCaseFileError {
  return new ManifestCaseFileError(
    'invalid_loaded_dataset',
    message,
    cause === undefined ? undefined : { cause },
  );
}
