import {
  type MutableWorkspace,
  type ReadonlyWorkspace,
  type WorkspaceEntry,
  WorkspaceEntryLimitError,
  type WorkspaceListOptions,
  type WorkspaceWriteOptions,
} from '../contracts/runtime.ts';
import { isSafeWorkspaceRelativePath } from '../model/paths.ts';
import {
  compareWorkspaceListingPaths,
  workspaceDirectoryExclusions,
} from '../runtime/workspaceListing.ts';

export type TestFileContents = string | Uint8Array;

export interface MemoryWorkspaceFixture {
  readonly mutable: MutableWorkspace;
  readonly readonly: ReadonlyWorkspace;
  /** Prevent every future mutation while preserving the read-only view. */
  seal(): void;
  /** Return an isolated snapshot of regular-file bytes. */
  snapshot(): ReadonlyMap<string, Uint8Array>;
}

/** Small, deterministic workspace double for adapter and lifecycle tests. */
export function createMemoryWorkspace(
  initialFiles: Readonly<Record<string, TestFileContents>> = {},
): MemoryWorkspaceFixture {
  const files = new Map<string, Uint8Array>();
  let sealed = false;

  for (const [relativePath, contents] of Object.entries(initialFiles)) {
    assertWorkspacePath(relativePath, false);
    files.set(relativePath, copyBytes(contents));
  }
  assertFilesystemShape(files);

  const inspect = async (relativePath: string): Promise<WorkspaceEntry> => {
    assertWorkspacePath(relativePath, true);
    const contents = files.get(relativePath);
    if (contents !== undefined) {
      return Object.freeze({
        path: relativePath,
        kind: 'file' as const,
        size: contents.byteLength,
      });
    }
    if (directories(files).has(relativePath)) {
      return Object.freeze({ path: relativePath, kind: 'directory' as const });
    }
    return Object.freeze({ path: relativePath, kind: 'absent' as const });
  };

  const readFile = async (
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<Uint8Array> => {
    assertWorkspacePath(relativePath, false);
    const contents = files.get(relativePath);
    if (contents === undefined) {
      throw new Error(`Memory workspace file does not exist: ${relativePath}`);
    }
    const limit = positiveInteger(
      options.maxBytes ?? Number.MAX_SAFE_INTEGER,
      'maxBytes',
    );
    if (contents.byteLength > limit) {
      throw new Error(
        `Memory workspace file exceeds its ${limit} byte limit: ${relativePath}`,
      );
    }
    return copyUint8Array(contents);
  };

  const listFiles = async (
    options: WorkspaceListOptions = {},
  ): Promise<readonly WorkspaceEntry[]> => {
    options.signal?.throwIfAborted();
    const under = options.under ?? '.';
    assertWorkspacePath(under, true);
    const excluded = workspaceDirectoryExclusions(
      options.excludeDirectoryNames,
    );
    const allDirectories = directories(files);
    if (!allDirectories.has(under)) {
      throw new Error(`Memory workspace directory does not exist: ${under}`);
    }
    const limit = positiveInteger(
      options.maxEntries ?? Number.MAX_SAFE_INTEGER,
      'maxEntries',
    );
    const prefix = under === '.' ? '' : `${under}/`;
    const isExcludedDirectory = (directory: string): boolean =>
      directory
        .split('/')
        .some((name) => name.length > 0 && excluded.has(name));
    const entries: WorkspaceEntry[] = [];
    for (const directory of allDirectories) {
      if (
        directory !== '.' &&
        directory !== under &&
        directory.startsWith(prefix) &&
        !isExcludedDirectory(directory)
      ) {
        entries.push(Object.freeze({ path: directory, kind: 'directory' }));
      }
    }
    for (const [relativePath, contents] of files) {
      const parent = relativePath.split('/').slice(0, -1).join('/');
      if (relativePath.startsWith(prefix) && !isExcludedDirectory(parent)) {
        entries.push(
          Object.freeze({
            path: relativePath,
            kind: 'file',
            size: contents.byteLength,
          }),
        );
      }
    }
    if (entries.length > limit) {
      entries.sort((left, right) =>
        compareWorkspaceListingPaths(left.path, right.path),
      );
      const retained = entries
        .slice(0, limit)
        .sort((left, right) => compareCodeUnits(left.path, right.path));
      throw new WorkspaceEntryLimitError(limit, retained);
    }
    entries.sort((left, right) => compareCodeUnits(left.path, right.path));
    return Object.freeze(entries);
  };

  const readonly: ReadonlyWorkspace = Object.freeze({
    inspect,
    readFile,
    listFiles,
  });
  const mutable: MutableWorkspace = Object.freeze({
    inspect,
    readFile,
    listFiles,
    async writeFile(
      relativePath: string,
      body: Uint8Array,
      options: WorkspaceWriteOptions = {},
    ): Promise<void> {
      if (sealed) throw new Error('Memory workspace is sealed.');
      assertWorkspacePath(relativePath, false);
      if (!(body instanceof Uint8Array)) {
        throw new TypeError(
          'Memory workspace writes require Uint8Array bytes.',
        );
      }
      const mode = options.mode ?? 0o644;
      if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
        throw new TypeError(
          'Workspace file mode must be between 0000 and 0777.',
        );
      }
      const parentSegments = relativePath.split('/');
      for (let index = 1; index < parentSegments.length; index += 1) {
        const parent = parentSegments.slice(0, index).join('/');
        if (files.has(parent)) {
          throw new Error(`Workspace parent is a regular file: ${parent}`);
        }
      }
      if (directories(files).has(relativePath)) {
        throw new Error(
          `Workspace path is an existing directory: ${relativePath}`,
        );
      }
      files.set(relativePath, copyUint8Array(body));
    },
  });

  return Object.freeze({
    mutable,
    readonly,
    seal(): void {
      sealed = true;
    },
    snapshot(): ReadonlyMap<string, Uint8Array> {
      return new Map(
        [...files].map(([relativePath, contents]) => [
          relativePath,
          copyUint8Array(contents),
        ]),
      );
    },
  });
}

function directories(files: ReadonlyMap<string, Uint8Array>): Set<string> {
  const output = new Set<string>(['.']);
  for (const relativePath of files.keys()) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      output.add(segments.slice(0, index).join('/'));
    }
  }
  return output;
}

function assertFilesystemShape(files: ReadonlyMap<string, Uint8Array>): void {
  const allDirectories = directories(files);
  for (const relativePath of files.keys()) {
    if (allDirectories.has(relativePath)) {
      throw new TypeError(
        `Memory workspace path cannot be both a file and directory: ${relativePath}`,
      );
    }
  }
}

function copyBytes(contents: TestFileContents): Uint8Array {
  return typeof contents === 'string'
    ? Uint8Array.from(Buffer.from(contents, 'utf8'))
    : copyUint8Array(contents);
}

function copyUint8Array(contents: Uint8Array): Uint8Array {
  return Uint8Array.from(contents);
}

function assertWorkspacePath(value: string, allowRoot: boolean): void {
  if (!isSafeWorkspaceRelativePath(value, { allowRoot })) {
    throw new TypeError(`Invalid workspace-relative path: ${String(value)}`);
  }
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
