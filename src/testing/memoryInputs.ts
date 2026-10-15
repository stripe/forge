import {
  assertDatasetPath,
  type RunInputEntry,
  type RunInputListOptions,
  type RunInputProvider,
  type RunInputReadOptions,
} from '../contracts/inputs.js';
import type { TestFileContents } from './memoryWorkspace.js';

export interface MemoryRunInputProviderOptions {
  readonly maxBytes?: number;
}

/** Deterministic dataset input double backed by immutable in-memory bytes. */
export function createMemoryRunInputProvider(
  initialFiles: Readonly<Record<string, TestFileContents>> = {},
  options: MemoryRunInputProviderOptions = {},
): RunInputProvider {
  const files = new Map<string, Uint8Array>();
  const defaultLimit = positiveInteger(
    options.maxBytes ?? Number.MAX_SAFE_INTEGER,
    'maxBytes',
  );
  for (const [datasetPath, contents] of Object.entries(initialFiles)) {
    assertDatasetPath(datasetPath);
    files.set(
      datasetPath,
      typeof contents === 'string'
        ? Uint8Array.from(Buffer.from(contents, 'utf8'))
        : Uint8Array.from(contents),
    );
  }
  const allDirectories = directories(files);
  for (const filePath of files.keys()) {
    if (allDirectories.has(filePath)) {
      throw new TypeError(
        `Memory input cannot be both a file and directory: ${filePath}`,
      );
    }
  }

  const provider: RunInputProvider = {
    async inspect(datasetPath: string): Promise<RunInputEntry> {
      assertDatasetPath(datasetPath);
      const contents = files.get(datasetPath);
      if (contents !== undefined) {
        return Object.freeze({
          path: datasetPath,
          kind: 'file' as const,
          size: contents.byteLength,
        });
      }
      if (allDirectories.has(datasetPath)) {
        return Object.freeze({ path: datasetPath, kind: 'directory' as const });
      }
      throw new Error(`Memory dataset input does not exist: ${datasetPath}`);
    },
    async read(datasetPath: string, readOptions: RunInputReadOptions = {}) {
      readOptions.signal?.throwIfAborted();
      assertDatasetPath(datasetPath);
      const contents = files.get(datasetPath);
      if (contents === undefined) {
        throw new Error(`Memory dataset file does not exist: ${datasetPath}`);
      }
      const limit = positiveInteger(
        readOptions.maxBytes ?? defaultLimit,
        'maxBytes',
      );
      if (contents.byteLength > limit) {
        throw new Error(
          `Memory dataset file exceeds its ${limit} byte limit: ${datasetPath}`,
        );
      }
      return Uint8Array.from(contents);
    },
    async listFiles(
      datasetPath: string,
      listOptions: RunInputListOptions = {},
    ) {
      listOptions.signal?.throwIfAborted();
      assertDatasetPath(datasetPath);
      if (!allDirectories.has(datasetPath)) {
        throw new Error(
          `Memory dataset directory does not exist: ${datasetPath}`,
        );
      }
      const limit = positiveInteger(
        listOptions.maxEntries ?? Number.MAX_SAFE_INTEGER,
        'maxEntries',
      );
      const prefix = `${datasetPath}/`;
      const entries = [...files]
        .filter(([filePath]) => filePath.startsWith(prefix))
        .map(([filePath, contents]) =>
          Object.freeze({
            path: filePath,
            kind: 'file' as const,
            size: contents.byteLength,
          }),
        )
        .sort((left, right) => compareCodeUnits(left.path, right.path));
      if (entries.length > limit) {
        throw new Error(
          `Memory dataset tree exceeds its ${limit} entry limit.`,
        );
      }
      return Object.freeze(entries);
    },
  };
  return Object.freeze(provider);
}

function directories(files: ReadonlyMap<string, Uint8Array>): Set<string> {
  const output = new Set<string>();
  for (const datasetPath of files.keys()) {
    const segments = datasetPath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      output.add(segments.slice(0, index).join('/'));
    }
  }
  return output;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
