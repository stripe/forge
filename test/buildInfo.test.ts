import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { ForgeBuildIdentity } from '../src/version.js';

interface BuildInfoModule {
  captureBuildIdentity(
    version: string,
    root: string,
    runGit?: (root: string, args: readonly string[]) => string,
  ): ForgeBuildIdentity;
  writeBuildInfo(root: string): Promise<ForgeBuildIdentity>;
}

const buildInfo = (await import(
  pathToFileURL(path.resolve('scripts/build-info.mjs')).href
)) as BuildInfoModule;

describe('package build provenance', () => {
  it('captures the commit and clean or dirty source status at build time', () => {
    for (const status of ['', ' M src/version.ts\n', '?? src/new.ts\n']) {
      const calls: string[][] = [];
      const identity = buildInfo.captureBuildIdentity(
        '1.2.3-dev.4',
        '/source/forge',
        (root, args) => {
          assert.equal(root, '/source/forge');
          calls.push([...args]);
          if (args[0] === 'ls-files') return 'package.json\n';
          return args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : status;
        },
      );
      assert.deepEqual(identity, {
        version: '1.2.3-dev.4',
        commit_sha: 'a'.repeat(40),
        dirty: status.length > 0,
      });
      assert.deepEqual(calls, [
        ['ls-files', '--error-unmatch', '--', 'package.json'],
        ['rev-parse', 'HEAD'],
        ['status', '--porcelain=v1', '--untracked-files=normal', '--', '.'],
      ]);
      assert.equal(Object.isFrozen(identity), true);
    }
  });

  it('omits unrelated enclosing-repository provenance for an untracked source archive', () => {
    const calls: string[][] = [];
    const identity = buildInfo.captureBuildIdentity(
      '1.2.3',
      '/consumer/vendor/forge',
      (root, args) => {
        assert.equal(root, '/consumer/vendor/forge');
        calls.push([...args]);
        if (args[0] === 'ls-files')
          throw new Error('package.json is not tracked');
        return args[0] === 'rev-parse' ? 'c'.repeat(40) : '';
      },
    );
    assert.deepEqual(identity, { version: '1.2.3' });
    assert.deepEqual(calls, [
      ['ls-files', '--error-unmatch', '--', 'package.json'],
    ]);
  });

  it('omits unavailable source fields without inventing clean status', () => {
    const noGit = () => {
      throw new Error('Git unavailable');
    };
    assert.deepEqual(
      buildInfo.captureBuildIdentity('1.2.3', '/archive', noGit),
      { version: '1.2.3' },
    );
    assert.deepEqual(
      buildInfo.captureBuildIdentity('1.2.3', '/archive', () => 'not-a-commit'),
      { version: '1.2.3' },
    );
    assert.deepEqual(
      buildInfo.captureBuildIdentity('1.2.3', '/archive', (_root, args) => {
        if (args[0] === 'status') throw new Error('status unavailable');
        return 'b'.repeat(40);
      }),
      { version: '1.2.3', commit_sha: 'b'.repeat(40) },
    );
  });

  it('writes packaged metadata for source archives without a Git checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-build-info-'));
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ version: '1.2.3-dev.4' }),
      );
      assert.deepEqual(await buildInfo.writeBuildInfo(root), {
        version: '1.2.3-dev.4',
      });
      assert.deepEqual(
        JSON.parse(
          await readFile(path.join(root, 'dist', 'build-info.json'), 'utf8'),
        ),
        { version: '1.2.3-dev.4' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
