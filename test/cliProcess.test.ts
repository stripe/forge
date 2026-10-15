import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORGE_VERSION } from '../src/version.js';

const cliFile = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function invoke(entry: string, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('CLI executable', () => {
  it('dispatches a direct executable entry point', () => {
    const result = invoke(cliFile, ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${FORGE_VERSION}\n`);
    assert.equal(result.stderr, '');
  });

  it('dispatches a symlink entry point like an npm-installed bin', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cli-process-'));
    try {
      const link = path.join(root, 'forge');
      await fs.symlink(cliFile, link);
      const result = invoke(link, ['--version']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${FORGE_VERSION}\n`);
      assert.equal(result.stderr, '');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps importing the CLI module free of executable side effects', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'await import(process.argv[1]);',
        pathToFileURL(cliFile).href,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('describes experiment run IDs in executable help', () => {
    const result = invoke(cliFile, ['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--resume <experiment-run-id>/);
    assert.match(result.stdout, /results\/experiments\/<experiment-run-id>/);
    assert.doesNotMatch(result.stdout, /campaign/i);
    assert.equal(result.stderr, '');
  });

  it('returns a usage error through the process exit code', () => {
    const result = invoke(cliFile, ['run', '--resume']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /resume/);
  });

  it('validates an experiment through the real process without runtime allocation', () => {
    const result = invoke(cliFile, [
      'validate',
      '--experiment',
      'test/fixtures/one-shot/experiment.yaml',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /valid/i);
    assert.equal(result.stderr, '');
  });
});
