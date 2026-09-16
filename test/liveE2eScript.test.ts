import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, it} from 'node:test';

const repositoryRoot = process.cwd();
const liveScript = path.join(repositoryRoot, 'scripts', 'live-e2e.mjs');

describe('unified live end-to-end suite', () => {
  it('is the only live package command and has valid JavaScript syntax', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as {scripts?: Record<string, string>};
    const scripts = packageJson.scripts ?? {};

    assert.deepEqual(
      Object.keys(scripts).filter((name) => name.startsWith('test:live')),
      ['test:live'],
    );
    assert.equal(
      scripts['test:live'],
      'pnpm build && node scripts/live-e2e.mjs',
    );

    const syntax = spawnSync(process.execPath, ['--check', liveScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  });

  it('keeps live traffic explicitly opt-in', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    assert.match(source, /process\.env\.FORGE_LIVE !== '1'/);
    assert.match(source, /potentially billable model calls/);
    assert.doesNotMatch(source, /litellm\.corp\.stripe|certproxy/);
  });
});
