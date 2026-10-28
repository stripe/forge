import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type MutableWorkspace,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  WorkspaceEntryLimitError,
  type WorkspaceListOptions,
  type WorkspaceWriteOptions,
} from '../contracts/runtime.ts';
import { isSafeWorkspaceRelativePath } from '../model/paths.ts';
import {
  compareWorkspaceListingPaths,
  workspaceDirectoryExclusions,
} from './workspaceListing.ts';

const DEFAULT_READ_LIMIT = 64 * 1024 * 1024;
const DEFAULT_ENTRY_LIMIT = 100_000;

export interface OwnedWorkspaceOptions {
  /**
   * Optional owner for files and directories created through this workspace.
   * Used only when a privileged host launches a non-root runtime user.
   */
  readonly writeOwner?: Readonly<{ uid: number; gid: number }>;
}

/** Host-backed workspace used only for a fresh, runtime-owned root. */
export async function createOwnedWorkspace(
  root: string,
  workspaceOptions: OwnedWorkspaceOptions = {},
): Promise<MutableWorkspace> {
  const canonicalRoot = await fs.realpath(root);
  const rootStat = await fs.lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TypeError('Runtime workspace root must be a real directory.');
  }

  const inspect = async (relativePath: string): Promise<WorkspaceEntry> => {
    assertWorkspacePath(relativePath, true);
    const candidate = resolveCandidate(canonicalRoot, relativePath);
    let stat: import('node:fs').Stats;
    try {
      if (candidate !== canonicalRoot) {
        await assertRealParentWithinRoot(canonicalRoot, candidate);
      }
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (isMissing(error))
        return Object.freeze({ path: relativePath, kind: 'absent' });
      throw error;
    }
    return Object.freeze({
      path: relativePath,
      kind: entryKind(stat),
      ...(stat.isFile() ? { size: stat.size } : {}),
    });
  };

  return Object.freeze({
    inspect,
    async readFile(relativePath: string, options: { maxBytes?: number } = {}) {
      assertWorkspacePath(relativePath, false);
      const candidate = resolveCandidate(canonicalRoot, relativePath);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Workspace reads do not follow symlinks: ${relativePath}`,
        );
      }
      if (!stat.isFile())
        throw new Error(`Workspace path is not a file: ${relativePath}`);
      const limit = positiveInteger(
        options.maxBytes ?? DEFAULT_READ_LIMIT,
        'maxBytes',
      );
      if (stat.size > limit) {
        throw new Error(
          `Workspace file exceeds its ${limit} byte limit: ${relativePath}`,
        );
      }
      await assertRealParentWithinRoot(canonicalRoot, candidate);
      const body = await fs.readFile(candidate);
      if (body.byteLength > limit) {
        throw new Error(
          `Workspace file exceeds its ${limit} byte limit: ${relativePath}`,
        );
      }
      return body;
    },
    async listFiles(options: WorkspaceListOptions = {}) {
      options.signal?.throwIfAborted();
      const under = options.under ?? '.';
      assertWorkspacePath(under, true);
      const limit = positiveInteger(
        options.maxEntries ?? DEFAULT_ENTRY_LIMIT,
        'maxEntries',
      );
      const excluded = workspaceDirectoryExclusions(
        options.excludeDirectoryNames,
      );
      const start = resolveCandidate(canonicalRoot, under);
      const startStat = await fs.lstat(start);
      if (startStat.isSymbolicLink()) {
        throw new Error(`Workspace listing does not follow symlinks: ${under}`);
      }
      if (!startStat.isDirectory()) {
        throw new Error(`Workspace listing root is not a directory: ${under}`);
      }
      await assertRealPathWithinRoot(canonicalRoot, start);

      if (
        under !== '.' &&
        under.split('/').some((name) => excluded.has(name))
      ) {
        return Object.freeze([]);
      }
      const entries: WorkspaceEntry[] = [];
      let pending = [under];
      while (pending.length > 0) {
        // A trailing slash orders directory prefixes like their child paths.
        pending.sort((left, right) =>
          compareWorkspaceListingPaths(`${left}/`, `${right}/`),
        );
        const nextDepth: string[] = [];
        for (const directory of pending) {
          options.signal?.throwIfAborted();
          const children = await fs.readdir(
            resolveCandidate(canonicalRoot, directory),
            { withFileTypes: true },
          );
          children.sort((left, right) => comparePaths(left.name, right.name));
          for (const child of children) {
            options.signal?.throwIfAborted();
            const childPath =
              directory === '.' ? child.name : `${directory}/${child.name}`;
            const childStat = await fs.lstat(
              resolveCandidate(canonicalRoot, childPath),
            );
            const kind = entryKind(childStat);
            if (kind === 'directory' && excluded.has(child.name)) continue;
            if (entries.length === limit) {
              entries.sort((left, right) =>
                comparePaths(left.path, right.path),
              );
              throw new WorkspaceEntryLimitError(limit, entries);
            }
            entries.push(
              Object.freeze({
                path: childPath,
                kind,
                ...(childStat.isFile() ? { size: childStat.size } : {}),
              }),
            );
            if (kind === 'directory') nextDepth.push(childPath);
          }
        }
        pending = nextDepth;
      }
      entries.sort((left, right) => comparePaths(left.path, right.path));
      return Object.freeze(entries);
    },
    async writeFile(
      relativePath: string,
      body: Uint8Array,
      options: WorkspaceWriteOptions = {},
    ) {
      assertWorkspacePath(relativePath, false);
      const mode = options.mode ?? 0o644;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
        throw new TypeError(
          'Workspace file mode must be between 0000 and 0777.',
        );
      }
      const candidate = resolveCandidate(canonicalRoot, relativePath);
      await ensureOwnedParents(
        canonicalRoot,
        path.dirname(candidate),
        workspaceOptions.writeOwner,
      );
      try {
        const existing = await fs.lstat(candidate);
        if (existing.isSymbolicLink() || existing.isDirectory()) {
          throw new Error(
            `Refusing to replace unsafe workspace path: ${relativePath}`,
          );
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const temporary = path.join(
        path.dirname(candidate),
        `.forge-write-${randomUUID()}`,
      );
      try {
        await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        if (workspaceOptions.writeOwner !== undefined) {
          await fs.chown(
            temporary,
            workspaceOptions.writeOwner.uid,
            workspaceOptions.writeOwner.gid,
          );
        }
        await fs.chmod(temporary, mode);
        await fs.rename(temporary, candidate);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  });
}

function assertWorkspacePath(value: string, allowRoot: boolean): void {
  if (!isSafeWorkspaceRelativePath(value, { allowRoot })) {
    throw new TypeError(`Invalid workspace-relative path: ${String(value)}`);
  }
}

function resolveCandidate(root: string, relativePath: string): string {
  return relativePath === '.'
    ? root
    : path.join(root, ...relativePath.split('/'));
}

async function ensureOwnedParents(
  root: string,
  parent: string,
  writeOwner: OwnedWorkspaceOptions['writeOwner'],
): Promise<void> {
  const relative = path.relative(root, parent);
  if (relative === '') return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Workspace parent is not a real directory: ${segment}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await fs.mkdir(current, { mode: 0o755 });
      if (writeOwner !== undefined) {
        await fs.chown(current, writeOwner.uid, writeOwner.gid);
      }
    }
  }
}

async function assertRealParentWithinRoot(
  root: string,
  candidate: string,
): Promise<void> {
  const realParent = await fs.realpath(path.dirname(candidate));
  assertWithinRoot(root, realParent);
}

async function assertRealPathWithinRoot(
  root: string,
  candidate: string,
): Promise<void> {
  const realPath = await fs.realpath(candidate);
  assertWithinRoot(root, realPath);
}

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Workspace path resolves outside its owned root.');
  }
}

function entryKind(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
): WorkspaceEntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
