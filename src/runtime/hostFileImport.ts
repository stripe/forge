import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HostFileImport } from '../contracts/runtime.js';
import { isSafeWorkspaceRelativePath } from '../model/paths.js';

/** Copy through bounded chunks, then hash the staged bytes before publishing. */
export async function importHostFileIntoState(
  root: string,
  stagingRoot: string,
  input: HostFileImport,
  signal?: AbortSignal,
  writeOwner?: Readonly<{ uid: number; gid: number }>,
): Promise<void> {
  validateImport(input);
  signal?.throwIfAborted();
  const canonicalRoot = await fs.realpath(root);
  const destination = path.join(canonicalRoot, input.relativePath);
  await rejectUnsafeDestination(destination);
  // This directory is outside every container mount, so setup commands cannot
  // replace the staged file while the host is hashing or chmod-ing it.
  const staged = path.join(stagingRoot, `.forge-import-${randomUUID()}`);
  const source = await fs.open(
    input.sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > input.maxBytes) {
      throw new Error('Host import source must be a bounded regular file.');
    }
    const target = await fs.open(staged, 'wx', 0o600);
    try {
      let copied = 0;
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted();
        copied += chunk.byteLength;
        if (copied > input.maxBytes) {
          throw new Error('Host import source exceeded its byte limit.');
        }
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await target.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            null,
          );
          if (result.bytesWritten === 0)
            throw new Error('Host import copy made no progress.');
          offset += result.bytesWritten;
        }
      }
    } finally {
      await target.close();
    }
    if (
      (await hashRegularFile(staged, input.maxBytes, signal)) !== input.sha256
    ) {
      throw new Error(
        'Imported host file does not match its expected SHA-256.',
      );
    }
    signal?.throwIfAborted();
    if (writeOwner !== undefined) {
      await fs.chown(staged, writeOwner.uid, writeOwner.gid);
    }
    await fs.chmod(staged, input.mode ?? 0o644);
    await rejectUnsafeDestination(destination);
    await fs.rename(staged, destination);
  } finally {
    await source.close();
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

/** Recheck an imported file after setup without loading it into Node memory. */
export async function hashStateFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!isSafeFilename(relativePath)) {
    throw new TypeError('Invalid imported state file path.');
  }
  const canonicalRoot = await fs.realpath(root);
  const candidate = path.join(canonicalRoot, relativePath);
  return hashRegularFile(candidate, maxBytes, signal);
}

function validateImport(input: HostFileImport): void {
  if (
    !input ||
    typeof input.sourcePath !== 'string' ||
    !path.isAbsolute(input.sourcePath) ||
    input.sourcePath.includes('\0') ||
    typeof input.stateDirectoryId !== 'string' ||
    !isSafeFilename(input.relativePath) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(input.sha256) ||
    (input.mode !== undefined &&
      (!Number.isInteger(input.mode) ||
        input.mode < 0 ||
        input.mode > 0o777)) ||
    (input.verifyAfterSetup !== undefined &&
      typeof input.verifyAfterSetup !== 'boolean')
  ) {
    throw new TypeError('Invalid host file import.');
  }
}

async function hashRegularFile(
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error('Imported state file is not a bounded regular file.');
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > maxBytes)
        throw new Error('Imported state file exceeded its byte limit.');
      hash.update(chunk);
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isSafeWorkspaceRelativePath(value, { allowRoot: false }) &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

async function rejectUnsafeDestination(destination: string): Promise<void> {
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Host import refuses to replace an unsafe destination.');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
