import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AttemptDiagnosticsStore } from '../contracts/attemptDiagnostics.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  type AttemptDiagnosticsIdentity,
  type AttemptDiagnosticsRecord,
  assertAttemptDiagnosticsIdentity,
  attemptDiagnosticsIdentitySchema,
  MAX_ATTEMPT_DIAGNOSTICS_BYTES,
  parseAttemptDiagnostics,
  serializeAttemptDiagnostics,
} from './model.ts';

const writers = new Map<string, Promise<unknown>>();

/** One host process owns a root; experiment scheduling supplies its process lock. */
export function createAttemptDiagnosticsStore(options: {
  root: string;
}): AttemptDiagnosticsStore {
  if (!options.root || options.root.includes('\0'))
    throw new TypeError('Attempt diagnostics root must be a non-empty path.');
  const root = path.resolve(options.root);
  if (root === path.parse(root).root)
    throw new TypeError(
      'Attempt diagnostics root must not be a filesystem root.',
    );
  let canonicalRoot: Promise<string> | undefined;
  function resolveRoot(create: boolean): Promise<string> {
    canonicalRoot ??= (async () => {
      if (create)
        await fs
          .mkdir(root, { mode: 0o700 })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
      const resolved = await fs.realpath(root);
      if (resolved === path.parse(resolved).root)
        throw new Error(
          'Attempt diagnostics root must not be a filesystem root.',
        );
      return resolved;
    })().catch((error) => {
      canonicalRoot = undefined;
      throw error;
    });
    return canonicalRoot;
  }
  async function directory(
    identity: AttemptDiagnosticsIdentity,
    create: boolean,
  ): Promise<string> {
    attemptDiagnosticsIdentitySchema.parse(identity);
    const resolved = await resolveRoot(create);
    const target = path.join(resolved, 'diagnostics', identity.run_id);
    for (const current of [
      resolved,
      path.join(resolved, 'diagnostics'),
      target,
    ]) {
      if (create && current !== resolved)
        await fs
          .mkdir(current, { mode: 0o700 })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe attempt diagnostics directory.');
      if (
        current !== resolved &&
        ((stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid()))
      )
        throw new Error('Attempt diagnostics directory must be owner-only.');
    }
    return target;
  }
  async function read(
    identity: AttemptDiagnosticsIdentity,
    signal: AbortSignal,
  ): Promise<AttemptDiagnosticsRecord | undefined> {
    signal.throwIfAborted();
    let handle: fs.FileHandle | undefined;
    try {
      const target = await directory(identity, false);
      handle = await fs.open(
        path.join(target, 'attempt.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_ATTEMPT_DIAGNOSTICS_BYTES ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('Unsafe attempt diagnostics file.');
      const buffer = Buffer.alloc(MAX_ATTEMPT_DIAGNOSTICS_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_ATTEMPT_DIAGNOSTICS_BYTES)
        throw new Error('Attempt diagnostics exceed the byte limit.');
      signal.throwIfAborted();
      const record = parseAttemptDiagnostics(
        JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')),
      );
      assertAttemptDiagnosticsIdentity(record.identity, identity);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  return {
    read,
    async write(snapshot, signal) {
      // Snapshot caller-owned data before waiting for another writer.
      const candidate = parseAttemptDiagnostics({ ...snapshot, revision: 1 });
      const key = path.join(
        await resolveRoot(true),
        'diagnostics',
        candidate.identity.run_id,
      );
      const operation = (writers.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          signal.throwIfAborted();
          const target = await directory(candidate.identity, true);
          const previous = await read(candidate.identity, signal);
          if (previous?.timing.finished_at !== undefined) {
            if (
              serializeCanonicalJson({ ...previous, revision: 1 }) !==
              serializeCanonicalJson(candidate)
            )
              throw new Error(
                'Terminal attempt diagnostics cannot be replaced.',
              );
            return previous;
          }
          if (previous?.state === 'running' && candidate.state === 'reserved')
            throw new Error(
              'Attempt diagnostics cannot return to reservation.',
            );
          const record = parseAttemptDiagnostics({
            ...candidate,
            revision: (previous?.revision ?? 0) + 1,
          });
          const temporary = path.join(target, 'attempt.pending');
          // Unlink the fixed staging name left by an interrupted writer, never follow it.
          await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          const file = await fs.open(
            temporary,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(serializeAttemptDiagnostics(record), {
              signal,
            });
            await file.sync();
            await file.close();
            signal.throwIfAborted();
            // Check the published entry as well; rename must not hide an unsafe file.
            const existing = await fs
              .lstat(path.join(target, 'attempt.json'))
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
                return undefined;
              });
            if (
              existing &&
              (!existing.isFile() ||
                existing.isSymbolicLink() ||
                existing.nlink !== 1)
            )
              throw new Error('Unsafe attempt diagnostics file.');
            signal.throwIfAborted();
            await fs.rename(temporary, path.join(target, 'attempt.json'));
            const parent = await fs.open(
              target,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              await parent.sync();
            } finally {
              await parent.close();
            }
            return record;
          } finally {
            await file.close().catch(() => undefined);
            await fs.unlink(temporary).catch(() => undefined);
          }
        });
      writers.set(key, operation);
      void operation
        .finally(() => {
          if (writers.get(key) === operation) writers.delete(key);
        })
        .catch(() => undefined);
      return operation;
    },
  };
}
