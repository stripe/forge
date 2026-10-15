import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Git is consulted only while building the package, and may be unavailable. */
export function captureBuildIdentity(version, repositoryRoot, runGit = git) {
  if (typeof version !== 'string' || !version) {
    throw new TypeError('package.json must declare a version.');
  }
  const identity = { version };
  try {
    // Git can discover an unrelated enclosing checkout around a source archive.
    // Accept provenance only when this package belongs to that checkout.
    runGit(repositoryRoot, [
      'ls-files',
      '--error-unmatch',
      '--',
      'package.json',
    ]);
    const commit = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (!COMMIT_SHA.test(commit)) return Object.freeze(identity);
    identity.commit_sha = commit;
    try {
      identity.dirty =
        runGit(repositoryRoot, [
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
          '--',
          '.',
        ]).trim().length > 0;
    } catch {
      // A known commit remains useful even when working-tree inspection fails.
    }
  } catch {
    // Source archives and environments without Git still have package identity.
  }
  return Object.freeze(identity);
}

export async function writeBuildInfo(repositoryRoot) {
  const metadata = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const identity = captureBuildIdentity(metadata.version, repositoryRoot);
  const destination = path.join(repositoryRoot, 'dist', 'build-info.json');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

function git(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await writeBuildInfo(fileURLToPath(new URL('../', import.meta.url)));
}
