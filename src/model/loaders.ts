import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  defaultSetupActionRegistry,
  type SetupActionRegistry,
} from '../setup/registry.ts';
import { BenchmarkModelError } from './errors.ts';
import { sha256Digest, sha256Hex } from './hashes.ts';
import {
  MAX_BENCHMARK_YAML_BYTES,
  MAX_DATASET_MANIFEST_BYTES,
  parseDatasetManifestJson,
  parseEvalCaseYamlWithSetupActions,
  parseExperimentConfigYamlWithSetupActions,
} from './parse.ts';
import {
  isAuthoredCaseId,
  isCaseDefinitionPath,
  isSafeDatasetRelativePath,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from './paths.ts';
import type {
  DatasetRelativePath,
  LoadedDatasetV1,
  LoadedEvalCaseV1,
  LoadedExperimentConfigV1,
  Sha256Hex,
} from './types.ts';

const MAX_DATASET_ENTRIES = 50_001; // payload files plus manifest.json
const MAX_DATASET_DEPTH = 64;
const MAX_DATASET_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** Load and verify every byte named by a dataset's manifest. */
export async function loadDataset(
  datasetRoot: string,
): Promise<LoadedDatasetV1> {
  return loadDatasetWithSetupActions(datasetRoot, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export async function loadDatasetWithSetupActions(
  datasetRoot: string,
  setupActions: SetupActionRegistry,
): Promise<LoadedDatasetV1> {
  const root = await resolveRealDirectory(datasetRoot, 'Dataset root');
  const manifestPath = path.join(root, 'manifest.json');
  const manifestBytes = await readBoundedRegularFile(
    manifestPath,
    MAX_DATASET_MANIFEST_BYTES,
    'Dataset manifest',
  );
  const manifestSha256 = sha256Digest(manifestBytes);
  const manifestRaw = decodeDocument(manifestBytes, 'Dataset manifest');
  const manifest = parseDatasetManifestJson(manifestRaw);

  if (
    manifest.files.some(({ path: filePath }) => filePath === 'manifest.json')
  ) {
    throw integrityError('manifest.json must not list or hash itself.');
  }

  const actualPayloadPaths = await collectPayloadFiles(root);
  const declaredPayloadPaths = new Set(
    manifest.files.map(({ path: filePath }) => filePath),
  );
  if (
    actualPayloadPaths.size !== declaredPayloadPaths.size ||
    [...actualPayloadPaths].some(
      (filePath) => !declaredPayloadPaths.has(filePath),
    )
  ) {
    throw integrityError(
      'Dataset payload files do not exactly match the manifest inventory.',
    );
  }

  let totalBytes = 0;
  const absoluteFiles = new Map<string, string>();
  const casePaths = new Set(manifest.cases);
  for (const file of manifest.files) {
    totalBytes += file.size;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_DATASET_TOTAL_BYTES
    ) {
      throw integrityError(
        `Dataset payload exceeds the ${MAX_DATASET_TOTAL_BYTES}-byte limit.`,
      );
    }
    const absolutePath = await resolveContainedRegularFile(root, file.path);
    if (!casePaths.has(file.path)) {
      const actual = await hashFile(absolutePath, file.size);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) {
        throw integrityError(
          'A dataset file does not match its declared size or hash.',
        );
      }
    }
    absoluteFiles.set(file.path, absolutePath);
  }

  const cases = new Map<string, LoadedEvalCaseV1>();
  const manifestFiles = new Map(
    manifest.files.map((file) => [file.path, file]),
  );
  for (const casePath of manifest.cases) {
    const file = manifestFiles.get(casePath)!;
    if (file.size > MAX_BENCHMARK_YAML_BYTES) {
      throw integrityError(
        'An eval case exceeds the benchmark YAML size limit.',
      );
    }
    const absolutePath = absoluteFiles.get(casePath)!;
    const bytes = await readBoundedRegularFile(
      absolutePath,
      MAX_BENCHMARK_YAML_BYTES,
      'Eval case',
    );
    if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
      throw integrityError(
        'An eval case does not match its declared size or hash.',
      );
    }
    const raw = decodeDocument(bytes, 'Eval case');
    const definition = parseEvalCaseYamlWithSetupActions(raw, setupActions);
    const previous = cases.get(definition.id);
    if (previous !== undefined) {
      throw integrityError(
        `Duplicate case ID ${JSON.stringify(definition.id)} in ` +
          `${JSON.stringify(path.relative(root, previous.path).split(path.sep).join('/'))} and ` +
          `${JSON.stringify(casePath)}.`,
      );
    }
    cases.set(definition.id, {
      definition,
      path: absolutePath,
    });
  }

  return {
    root,
    manifestPath,
    manifestRaw,
    manifestSha256,
    manifest,
    cases,
  };
}

/** @internal Derive an index while rejecting inconsistent host-supplied datasets. */
export function indexLoadedDatasetCases(
  dataset: LoadedDatasetV1,
): ReadonlyMap<DatasetRelativePath, LoadedEvalCaseV1> {
  try {
    if (
      dataset === null ||
      typeof dataset !== 'object' ||
      typeof dataset.root !== 'string' ||
      dataset.root.length === 0 ||
      dataset.root.includes('\0') ||
      !path.isAbsolute(dataset.root) ||
      path.resolve(dataset.root) !== dataset.root ||
      dataset.root === path.parse(dataset.root).root ||
      dataset.manifest === null ||
      typeof dataset.manifest !== 'object' ||
      dataset.manifest.dataset === null ||
      typeof dataset.manifest.dataset !== 'object' ||
      typeof dataset.manifest.dataset.id !== 'string' ||
      !isSafeSimpleIdentifier(dataset.manifest.dataset.id) ||
      typeof dataset.manifest.dataset.version !== 'string' ||
      !isSafeVersion(dataset.manifest.dataset.version) ||
      !Array.isArray(dataset.manifest.cases) ||
      dataset.manifest.cases.length === 0 ||
      dataset.manifest.cases.length > 10_000 ||
      dataset.cases === null ||
      typeof dataset.cases !== 'object' ||
      typeof dataset.cases.get !== 'function' ||
      typeof dataset.cases[Symbol.iterator] !== 'function' ||
      !Number.isSafeInteger(dataset.cases.size) ||
      dataset.cases.size < 0 ||
      dataset.cases.size > 10_000
    ) {
      throw integrityError('The loaded dataset has an invalid case index.');
    }
    const manifestPaths = new Set<string>();
    for (const casePath of dataset.manifest.cases) {
      if (
        typeof casePath !== 'string' ||
        !isCaseDefinitionPath(casePath) ||
        manifestPaths.has(casePath)
      ) {
        throw integrityError(
          'The loaded dataset manifest has an invalid or duplicate case path.',
        );
      }
      manifestPaths.add(casePath);
    }
    const byPath = new Map<DatasetRelativePath, LoadedEvalCaseV1>();
    const ids = new Set<string>();
    let visited = 0;
    for (const entry of dataset.cases) {
      visited += 1;
      if (
        visited > manifestPaths.size ||
        !Array.isArray(entry) ||
        entry.length !== 2
      ) {
        throw integrityError(
          'The loaded case index exceeds or does not match the manifest case inventory.',
        );
      }
      const [id, loadedCase] = entry;
      if (
        typeof id !== 'string' ||
        !isAuthoredCaseId(id) ||
        ids.has(id) ||
        loadedCase === null ||
        typeof loadedCase !== 'object' ||
        loadedCase.definition === null ||
        typeof loadedCase.definition !== 'object' ||
        loadedCase.definition.id !== id ||
        typeof loadedCase.path !== 'string' ||
        loadedCase.path.includes('\0') ||
        !path.isAbsolute(loadedCase.path) ||
        path.resolve(loadedCase.path) !== loadedCase.path ||
        dataset.cases.get(id) !== loadedCase
      ) {
        throw integrityError(
          'The loaded case index contains an invalid definition or path.',
        );
      }
      ids.add(id);
      const casePath = path
        .relative(dataset.root, loadedCase.path)
        .split(path.sep)
        .join('/');
      if (
        !manifestPaths.has(casePath) ||
        loadedCase.path !== path.join(dataset.root, ...casePath.split('/')) ||
        byPath.has(casePath)
      ) {
        throw integrityError(
          'The loaded case index does not match the dataset manifest.',
        );
      }
      byPath.set(casePath, loadedCase);
    }
    if (
      byPath.size !== manifestPaths.size ||
      dataset.cases.size !== byPath.size
    ) {
      throw integrityError(
        'The loaded case index does not match the dataset manifest.',
      );
    }
    return byPath;
  } catch (error) {
    if (error instanceof BenchmarkModelError) throw error;
    throw new BenchmarkModelError(
      'dataset_integrity_mismatch',
      'The loaded dataset case index is unavailable.',
      { cause: error },
    );
  }
}

/** Load a strict experiment config. */
export async function loadExperimentConfig(
  experimentPath: string,
): Promise<LoadedExperimentConfigV1> {
  return loadExperimentConfigWithSetupActions(
    experimentPath,
    defaultSetupActionRegistry,
  );
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export async function loadExperimentConfigWithSetupActions(
  experimentPath: string,
  setupActions: SetupActionRegistry,
): Promise<LoadedExperimentConfigV1> {
  const absolutePath = path.resolve(experimentPath);
  const stat = await lstatOrModelError(absolutePath, 'Experiment config');
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BenchmarkModelError(
      'unsafe_path',
      'Experiment config must be a regular, non-symbolic-link file.',
    );
  }
  const bytes = await readBoundedRegularFile(
    absolutePath,
    MAX_BENCHMARK_YAML_BYTES,
    'Experiment config',
  );
  const raw = decodeDocument(bytes, 'Experiment config');
  const config = parseExperimentConfigYamlWithSetupActions(raw, setupActions);
  return {
    path: absolutePath,
    root: path.dirname(absolutePath),
    raw,
    config,
  };
}

async function resolveRealDirectory(
  value: string,
  label: string,
): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new BenchmarkModelError(
      'unsafe_path',
      `${label} must be a safe path.`,
    );
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new BenchmarkModelError(
      'unsafe_path',
      `${label} must not be a filesystem root.`,
    );
  }
  const stat = await lstatOrModelError(resolved, label);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BenchmarkModelError(
      'unsafe_path',
      `${label} must be a real directory.`,
    );
  }
  return fs.realpath(resolved);
}

async function resolveContainedRegularFile(
  root: string,
  relativePath: string,
): Promise<string> {
  if (!isSafeDatasetRelativePath(relativePath)) {
    throw new BenchmarkModelError(
      'unsafe_path',
      'Dataset file path is not a canonical relative POSIX path.',
    );
  }
  const segments = relativePath.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstatOrModelError(current, 'Dataset payload');
    if (stat.isSymbolicLink()) {
      throw new BenchmarkModelError(
        'unsafe_path',
        'Dataset payload paths must not contain symbolic links.',
      );
    }
    const final = index === segments.length - 1;
    if ((final && !stat.isFile()) || (!final && !stat.isDirectory())) {
      throw new BenchmarkModelError(
        'unsafe_path',
        'Dataset payload path has an invalid file type.',
      );
    }
  }
  const real = await fs.realpath(current);
  if (!isWithin(root, real)) {
    throw new BenchmarkModelError(
      'unsafe_path',
      'Dataset payload path leaves the dataset root.',
    );
  }
  return current;
}

async function collectPayloadFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  let entriesVisited = 0;
  const visit = async (directory: string, relative: string, depth: number) => {
    if (depth > MAX_DATASET_DEPTH) {
      throw integrityError('Dataset directory depth exceeds its limit.');
    }
    const handle = await fs.opendir(directory);
    try {
      for await (const entry of handle) {
        entriesVisited += 1;
        if (entriesVisited > MAX_DATASET_ENTRIES) {
          throw integrityError('Dataset entry count exceeds its limit.');
        }
        const relativePath = relative
          ? `${relative}/${entry.name}`
          : entry.name;
        const absolutePath = path.join(directory, entry.name);
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new BenchmarkModelError(
            'unsafe_path',
            'Dataset trees must not contain symbolic links.',
          );
        }
        if (stat.isDirectory()) {
          await visit(absolutePath, relativePath, depth + 1);
        } else if (stat.isFile()) {
          if (relativePath !== 'manifest.json') files.add(relativePath);
        } else {
          throw new BenchmarkModelError(
            'unsafe_path',
            'Dataset trees may contain only regular files and directories.',
          );
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  await visit(root, '', 0);
  return files;
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const stat = await lstatOrModelError(filePath, label);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BenchmarkModelError(
      'unsafe_path',
      `${label} must be a regular, non-symbolic-link file.`,
    );
  }
  if (stat.size > maximumBytes) {
    throw new BenchmarkModelError(
      label === 'Dataset manifest' ? 'invalid_manifest' : 'invalid_yaml',
      `${label} exceeds the ${maximumBytes}-byte limit.`,
    );
  }
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > maximumBytes) {
      throw new BenchmarkModelError(
        'unsafe_path',
        `${label} changed while it was being opened.`,
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength;
      if (size > maximumBytes) {
        throw new BenchmarkModelError(
          label === 'Dataset manifest' ? 'invalid_manifest' : 'invalid_yaml',
          `${label} exceeds the ${maximumBytes}-byte limit.`,
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

function decodeDocument(body: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      body,
    );
  } catch (error) {
    throw new BenchmarkModelError(
      label === 'Dataset manifest' ? 'invalid_manifest' : 'invalid_yaml',
      `${label} must contain valid UTF-8.`,
      { cause: error },
    );
  }
}

async function hashFile(
  filePath: string,
  maximumBytes: number,
): Promise<{ size: number; sha256: Sha256Hex }> {
  const hash = createHash('sha256');
  let size = 0;
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0),
  );
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.byteLength;
      if (size > maximumBytes) {
        throw integrityError('A dataset file grew beyond its declared size.');
      }
      hash.update(bytes);
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest('hex') };
}

async function lstatOrModelError(
  filePath: string,
  label: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    throw new BenchmarkModelError('unsafe_path', `${label} is unavailable.`, {
      cause: error,
    });
  }
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

function integrityError(message: string): BenchmarkModelError {
  return new BenchmarkModelError('dataset_integrity_mismatch', message);
}
