#!/usr/bin/env node

import {cp, mkdir, mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import * as path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const buildParent = path.join(repositoryRoot, '.forge');
await mkdir(buildParent, {recursive: true});
const buildRoot = await mkdtemp(path.join(buildParent, 'test-build-'));
const tscEntrypoint = path.join(
  repositoryRoot,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

let exitCode = 1;
try {
  exitCode = await run(process.execPath, [
    tscEntrypoint,
    '-p',
    'tsconfig.test.json',
    '--outDir',
    buildRoot,
  ]);
  if (exitCode === 0) {
    await cp(
      path.join(repositoryRoot, 'src', 'runtime', 'docker', 'assets'),
      path.join(buildRoot, 'src', 'runtime', 'docker', 'assets'),
      {recursive: true},
    );

    const testArguments = process.argv.slice(2);
    const requested = testArguments[0] === '--'
      ? testArguments.slice(1)
      : testArguments;
    const testFiles = requested.length === 0
      ? await collectTestFiles(buildRoot)
      : await resolveRequestedTests(requested);
    if (testFiles.length === 0) {
      throw new Error('No compiled test files were found.');
    }
    exitCode = await run(process.execPath, ['--test', ...testFiles]);
  }
} finally {
  await rm(buildRoot, {recursive: true, force: true});
}
process.exitCode = exitCode;

async function resolveRequestedTests(values) {
  const resolved = [];
  for (const value of values) {
    if (!value.endsWith('.test.ts') || value.includes('\0')) {
      throw new TypeError('Focused tests must be repository-relative *.test.ts files.');
    }
    const source = path.resolve(repositoryRoot, value);
    const relative = path.relative(repositoryRoot, source);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      (!relative.startsWith(`src${path.sep}`) &&
        !relative.startsWith(`test${path.sep}`))
    ) {
      throw new TypeError('Focused tests must be below src/ or test/.');
    }
    const compiled = path.join(buildRoot, relative.replace(/\.ts$/, '.js'));
    const metadata = await stat(compiled).catch(() => undefined);
    if (!metadata?.isFile()) {
      throw new Error(`Focused test did not compile: ${value}`);
    }
    resolved.push(compiled);
  }
  return resolved;
}

async function collectTestFiles(root) {
  const results = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectTestFiles(target));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(target);
    }
  }
  return results.sort(compareCodeUnits);
}

async function run(executable, argv) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${path.basename(executable)} exited on ${signal}.`));
      } else {
        resolve(code);
      }
    });
  });
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
