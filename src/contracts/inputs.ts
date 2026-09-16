import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface RunInputReadOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

export interface RunInputEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly size?: number;
}

export interface RunInputListOptions {
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
}

/** Read-only access to dataset payloads selected by the resolved plan. */
export interface RunInputProvider {
  inspect(datasetPath: string): Promise<RunInputEntry>;
  read(datasetPath: string, options?: RunInputReadOptions): Promise<Uint8Array>;
  /** Recursively lists files in stable lexical order; symlinks are rejected. */
  listFiles(
    datasetPath: string,
    options?: RunInputListOptions,
  ): Promise<readonly RunInputEntry[]>;
}

export interface DirectoryRunInputProviderOptions {
  readonly maxBytes?: number;
}

/** A traversal- and symlink-safe provider rooted at one dataset directory. */
export async function createDirectoryRunInputProvider(
  root: string,
  options: DirectoryRunInputProviderOptions = {},
): Promise<RunInputProvider> {
  const canonicalRoot = await fs.realpath(root);
  const stat = await fs.stat(canonicalRoot);
  if (!stat.isDirectory()) throw new TypeError('Run input root must be a directory.');
  const defaultLimit = positiveLimit(options.maxBytes ?? 64 * 1024 * 1024);

  return {
    async inspect(datasetPath) {
      const {canonicalPath, stat: inputStat} = await resolveSafeInput(
        canonicalRoot,
        datasetPath,
      );
      void canonicalPath;
      if (!inputStat.isFile() && !inputStat.isDirectory()) {
        throw new Error(`Dataset input is not a regular file or directory: ${datasetPath}`);
      }
      return Object.freeze({
        path: datasetPath,
        kind: inputStat.isFile() ? 'file' : 'directory',
        ...(inputStat.isFile() ? {size: Number(inputStat.size)} : {}),
      });
    },
    async read(datasetPath, readOptions = {}) {
      readOptions.signal?.throwIfAborted();
      const {canonicalPath, stat: inputStat} = await resolveSafeInput(
        canonicalRoot,
        datasetPath,
      );
      if (!inputStat.isFile()) {
        throw new Error(`Dataset input is not a regular file: ${datasetPath}`);
      }
      const limit = positiveLimit(readOptions.maxBytes ?? defaultLimit);
      if (inputStat.size > limit) {
        throw new Error(`Dataset input exceeds its ${limit} byte limit: ${datasetPath}`);
      }
      const body = await fs.readFile(canonicalPath, {signal: readOptions.signal});
      if (body.byteLength > limit) {
        throw new Error(`Dataset input exceeds its ${limit} byte limit: ${datasetPath}`);
      }
      return body;
    },
    async listFiles(datasetPath, listOptions = {}) {
      const {canonicalPath, stat: inputStat} = await resolveSafeInput(
        canonicalRoot,
        datasetPath,
      );
      if (!inputStat.isDirectory()) {
        throw new Error(`Dataset input is not a directory: ${datasetPath}`);
      }
      const limit = positiveLimit(listOptions.maxEntries ?? 100_000);
      const entries: RunInputEntry[] = [];
      const pending: Array<{absolute: string; relative: string}> = [
        {absolute: canonicalPath, relative: datasetPath},
      ];
      while (pending.length > 0) {
        listOptions.signal?.throwIfAborted();
        const current = pending.pop()!;
        const children = await fs.readdir(current.absolute, {withFileTypes: true});
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          const childPath = `${current.relative}/${child.name}`;
          const childAbsolute = path.join(current.absolute, child.name);
          const childStat = await fs.lstat(childAbsolute);
          if (childStat.isSymbolicLink()) {
            throw new Error(`Dataset input trees may not contain symlinks: ${childPath}`);
          }
          if (childStat.isDirectory()) {
            pending.push({absolute: childAbsolute, relative: childPath});
          } else if (childStat.isFile()) {
            entries.push(
              Object.freeze({path: childPath, kind: 'file', size: Number(childStat.size)}),
            );
            if (entries.length > limit) {
              throw new Error(`Dataset input tree exceeds its ${limit} entry limit.`);
            }
          } else {
            throw new Error(`Dataset input tree contains a special file: ${childPath}`);
          }
        }
      }
      entries.sort((left, right) => left.path.localeCompare(right.path));
      return Object.freeze(entries);
    },
  };
}

async function resolveSafeInput(
  root: string,
  datasetPath: string,
): Promise<{canonicalPath: string; stat: Awaited<ReturnType<typeof fs.lstat>>}> {
  assertDatasetPath(datasetPath);
  let current = root;
  try {
    for (const segment of datasetPath.split('/')) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Dataset inputs may not use symlinks: ${datasetPath}`);
      }
    }
  } catch (error) {
    throw new Error(`Dataset input does not exist or is unsafe: ${datasetPath}`, {
      cause: error,
    });
  }
  const canonicalPath = await fs.realpath(current);
  if (!isWithin(root, canonicalPath)) {
    throw new Error(`Dataset input resolves outside its root: ${datasetPath}`);
  }
  return {canonicalPath, stat: await fs.lstat(canonicalPath)};
}

export function assertDatasetPath(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new TypeError(`Invalid dataset-relative path: ${String(value)}`);
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || Buffer.byteLength(segment) > 255,
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new TypeError(`Invalid dataset-relative path: ${value}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Run input byte limits must be positive integers.');
  }
  return value;
}
