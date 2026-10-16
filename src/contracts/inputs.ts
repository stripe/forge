import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sha256Hex } from '../model/hashes.ts';
import { parseDatasetManifest } from '../model/parse.ts';
import type { DatasetManifestV1 } from '../model/types.ts';

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
  /** Verified dataset inventory to enforce again when payloads are consumed. */
  readonly manifest?: DatasetManifestV1;
}

/** A traversal- and symlink-safe provider rooted at one dataset directory. */
export async function createDirectoryRunInputProvider(
  root: string,
  options: DirectoryRunInputProviderOptions = {},
): Promise<RunInputProvider> {
  const canonicalRoot = await fs.realpath(root);
  const stat = await fs.stat(canonicalRoot);
  if (!stat.isDirectory())
    throw new TypeError('Run input root must be a directory.');
  const defaultLimit = positiveLimit(options.maxBytes ?? 64 * 1024 * 1024);
  const manifestFiles =
    options.manifest === undefined
      ? undefined
      : new Map(
          parseDatasetManifest(options.manifest).files.map((file) => [
            file.path,
            file,
          ]),
        );

  function assertDeclaredFile(datasetPath: string, size: number) {
    if (manifestFiles === undefined) return undefined;
    const file = manifestFiles.get(datasetPath);
    if (!file || file.size !== size) {
      throw new Error(
        `Dataset input does not match its manifest inventory: ${datasetPath}`,
      );
    }
    return file;
  }

  function assertDeclaredDirectory(datasetPath: string) {
    if (manifestFiles?.has(datasetPath)) {
      throw new Error(
        `Dataset input no longer has its manifest file type: ${datasetPath}`,
      );
    }
  }

  return {
    async inspect(datasetPath) {
      const { canonicalPath, stat: inputStat } = await resolveSafeInput(
        canonicalRoot,
        datasetPath,
      );
      void canonicalPath;
      if (!inputStat.isFile() && !inputStat.isDirectory()) {
        throw new Error(
          `Dataset input is not a regular file or directory: ${datasetPath}`,
        );
      }
      if (inputStat.isFile())
        assertDeclaredFile(datasetPath, Number(inputStat.size));
      else assertDeclaredDirectory(datasetPath);
      return Object.freeze({
        path: datasetPath,
        kind: inputStat.isFile() ? 'file' : 'directory',
        ...(inputStat.isFile() ? { size: Number(inputStat.size) } : {}),
      });
    },
    async read(datasetPath, readOptions = {}) {
      readOptions.signal?.throwIfAborted();
      const { canonicalPath, stat: inputStat } = await resolveSafeInput(
        canonicalRoot,
        datasetPath,
      );
      if (!inputStat.isFile()) {
        throw new Error(`Dataset input is not a regular file: ${datasetPath}`);
      }
      const limit = positiveLimit(readOptions.maxBytes ?? defaultLimit);
      if (inputStat.size > limit) {
        throw new Error(
          `Dataset input exceeds its ${limit} byte limit: ${datasetPath}`,
        );
      }
      const file = assertDeclaredFile(datasetPath, Number(inputStat.size));
      const body = await readBoundedInput(
        canonicalPath,
        inputStat,
        () => resolveSafeInput(canonicalRoot, datasetPath),
        limit,
        readOptions.signal,
      );
      if (
        file &&
        (body.byteLength !== file.size || sha256Hex(body) !== file.sha256)
      ) {
        throw new Error(
          `Dataset input does not match its manifest size or SHA-256: ${datasetPath}`,
        );
      }
      return body;
    },
    async listFiles(datasetPath, listOptions = {}) {
      const { canonicalPath, stat: inputStat } = await resolveSafeInput(
        canonicalRoot,
        datasetPath,
      );
      if (!inputStat.isDirectory()) {
        throw new Error(`Dataset input is not a directory: ${datasetPath}`);
      }
      assertDeclaredDirectory(datasetPath);
      const limit = positiveLimit(listOptions.maxEntries ?? 100_000);
      const entries: RunInputEntry[] = [];
      const pending: Array<{ absolute: string; relative: string }> = [
        { absolute: canonicalPath, relative: datasetPath },
      ];
      while (pending.length > 0) {
        listOptions.signal?.throwIfAborted();
        const current = pending.pop()!;
        const children = await fs.readdir(current.absolute, {
          withFileTypes: true,
        });
        children.sort((left, right) => compareStrings(left.name, right.name));
        for (const child of children) {
          const childPath = `${current.relative}/${child.name}`;
          const childAbsolute = path.join(current.absolute, child.name);
          const childStat = await fs.lstat(childAbsolute);
          if (childStat.isSymbolicLink()) {
            throw new Error(
              `Dataset input trees may not contain symlinks: ${childPath}`,
            );
          }
          if (childStat.isDirectory()) {
            assertDeclaredDirectory(childPath);
            pending.push({ absolute: childAbsolute, relative: childPath });
          } else if (childStat.isFile()) {
            assertDeclaredFile(childPath, childStat.size);
            entries.push(
              Object.freeze({
                path: childPath,
                kind: 'file',
                size: Number(childStat.size),
              }),
            );
            if (entries.length > limit) {
              throw new Error(
                `Dataset input tree exceeds its ${limit} entry limit.`,
              );
            }
          } else {
            throw new Error(
              `Dataset input tree contains a special file: ${childPath}`,
            );
          }
        }
      }
      entries.sort((left, right) => compareStrings(left.path, right.path));
      if (manifestFiles !== undefined) {
        const expected = [...manifestFiles.keys()].filter((filePath) =>
          filePath.startsWith(`${datasetPath}/`),
        );
        if (expected.length !== entries.length) {
          throw new Error(
            `Dataset input tree does not match its manifest inventory: ${datasetPath}`,
          );
        }
      }
      return Object.freeze(entries);
    },
  };
}

async function readBoundedInput(
  filePath: string,
  expectedStat: Awaited<ReturnType<typeof fs.lstat>>,
  revalidate: () => Promise<unknown>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(
        `Dataset input is not a regular file within its ${maxBytes} byte limit.`,
      );
    }
    if (stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) {
      throw new Error('Dataset input changed while opening its verified file.');
    }
    await revalidate();
    signal?.throwIfAborted();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      ...(signal === undefined ? {} : { signal }),
    })) {
      signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > maxBytes)
        throw new Error(`Dataset input exceeds its ${maxBytes} byte limit.`);
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

async function resolveSafeInput(
  root: string,
  datasetPath: string,
): Promise<{
  canonicalPath: string;
  stat: Awaited<ReturnType<typeof fs.lstat>>;
}> {
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
    throw new Error(
      `Dataset input does not exist or is unsafe: ${datasetPath}`,
      {
        cause: error,
      },
    );
  }
  const canonicalPath = await fs.realpath(current);
  if (!isWithin(root, canonicalPath)) {
    throw new Error(`Dataset input resolves outside its root: ${datasetPath}`);
  }
  return { canonicalPath, stat: await fs.lstat(canonicalPath) };
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
        !segment ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment) > 255,
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new TypeError(`Invalid dataset-relative path: ${value}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Run input byte limits must be positive integers.');
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
