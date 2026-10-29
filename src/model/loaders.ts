import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  defaultSetupActionRegistry,
  type SetupActionRegistry,
} from '../setup/registry.ts';
import { BenchmarkModelError } from './errors.ts';
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
  DatasetManifestCaseV1,
  DatasetRelativePath,
  EvalCaseV1,
  LoadedDatasetV1,
  LoadedEvalCaseV1,
  LoadedExperimentConfigV1,
  SetupStepV1,
  WriteSetupStepV1,
} from './types.ts';

const MAX_DATASET_ENTRIES = 50_001; // payload files plus manifest.json
const MAX_DATASET_DEPTH = 64;
const MAX_DATASET_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** Load a dataset manifest and its cases, checking the tree's case inventory. */
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
  const manifestRaw = decodeDocument(manifestBytes, 'Dataset manifest');
  const manifest = parseDatasetManifestJson(manifestRaw);

  const payloadFiles = await collectPayloadFiles(root);
  const casePaths = new Set(manifest.cases.map(({ path }) => path));
  for (const casePath of casePaths) {
    if (!payloadFiles.has(casePath)) {
      throw integrityError(
        `Case ${JSON.stringify(casePath)} is listed in the manifest but absent from the dataset.`,
      );
    }
  }
  for (const filePath of payloadFiles.keys()) {
    if (isCaseDefinitionPath(filePath) && !casePaths.has(filePath)) {
      throw integrityError(
        `Case ${JSON.stringify(filePath)} is absent from the manifest.`,
      );
    }
  }
  let totalBytes = 0;
  for (const size of payloadFiles.values()) {
    totalBytes += size;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_DATASET_TOTAL_BYTES
    ) {
      throw integrityError(
        `Dataset payload exceeds the ${MAX_DATASET_TOTAL_BYTES}-byte limit.`,
      );
    }
  }

  const inputPaths = new Set([
    ...payloadFiles.keys(),
    ...ancestorDirectories(payloadFiles.keys()),
  ]);
  const caseDirectories = ancestorDirectories(casePaths);
  const cases = new Map<string, LoadedEvalCaseV1>();
  for (const entry of manifest.cases) {
    const absolutePath = await resolveContainedRegularFile(root, entry.path);
    const bytes = await readBoundedRegularFile(
      absolutePath,
      MAX_BENCHMARK_YAML_BYTES,
      'Eval case',
    );
    const raw = decodeDocument(bytes, 'Eval case');
    const definition = parseEvalCaseYamlWithSetupActions(raw, setupActions);
    assertManifestCaseIdentity(entry, definition);
    assertDatasetSetupInputs(
      definition.setup,
      caseDirectories,
      inputPaths,
      `Case ${definition.id}`,
    );
    cases.set(definition.id, {
      definition,
      path: absolutePath,
    });
  }

  return {
    root,
    manifestPath,
    manifestRaw,
    manifest,
    cases,
    inputPaths,
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
    const manifestPaths = new Map<string, DatasetManifestCaseV1>();
    for (const entry of dataset.manifest.cases) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof entry.path !== 'string' ||
        !isCaseDefinitionPath(entry.path) ||
        manifestPaths.has(entry.path)
      ) {
        throw integrityError(
          'The loaded dataset manifest has an invalid or duplicate case path.',
        );
      }
      manifestPaths.set(entry.path, entry);
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
      assertManifestCaseIdentity(
        manifestPaths.get(casePath)!,
        loadedCase.definition,
      );
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

/** Walk the dataset tree, returning each payload file's lstat size by path. */
async function collectPayloadFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
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
          if (relativePath === 'manifest.json') continue;
          if (!isSafeDatasetRelativePath(relativePath)) {
            throw new BenchmarkModelError(
              'unsafe_path',
              'Dataset file paths must be canonical relative POSIX paths.',
            );
          }
          files.set(relativePath, stat.size);
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

function assertManifestCaseIdentity(
  entry: DatasetManifestCaseV1,
  definition: EvalCaseV1,
): void {
  if (entry.id !== definition.id || entry.version !== definition.version) {
    throw integrityError(
      `Case ${JSON.stringify(entry.path)} declares ${definition.id}@${definition.version}, ` +
        `but the manifest lists ${entry.id}@${entry.version}.`,
    );
  }
}

/** @internal Every proper ancestor directory of dataset-relative paths. */
export function ancestorDirectories(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>();
  for (const filePath of paths) {
    for (let end = filePath.indexOf('/'); end !== -1; ) {
      directories.add(filePath.slice(0, end));
      end = filePath.indexOf('/', end + 1);
    }
  }
  return directories;
}

/**
 * @internal Built-in write sources must name fixtures, excluding case
 * definitions and their ancestors. Existence checks use the loader's index
 * when available; programmatic hosts may instead own those checks.
 */
export function assertDatasetSetupInputs(
  setup: readonly SetupStepV1[],
  caseDirectories: ReadonlySet<string>,
  inputPaths: ReadonlySet<string> | undefined,
  owner: string,
): void {
  for (const step of setup) {
    if (step.uses !== 'forge/write') continue;
    const { source } = (step as WriteSetupStepV1).with;
    if (!('dataset_path' in source)) continue;
    const datasetPath = source.dataset_path;
    if (inputPaths !== undefined && !inputPaths.has(datasetPath)) {
      throw integrityError(
        `${owner} reads ${JSON.stringify(datasetPath)}, which is absent from the dataset.`,
      );
    }
    if (isCaseDefinitionPath(datasetPath) || caseDirectories.has(datasetPath)) {
      throw integrityError(
        `${owner} reads ${JSON.stringify(datasetPath)}, which contains case definitions.`,
      );
    }
  }
}
