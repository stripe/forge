import assert from 'node:assert/strict';
import {cp, mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';

import {
  FORGE_BUILD_IDENTITY,
  FORGE_VERSION,
  assertCompatibleForgeVersion,
  parseForgeBuildIdentity,
  type ForgeBuildIdentity,
} from './version.js';

describe('Forge package version', () => {
  it('uses the version of the current package', () => {
    const metadata = createRequire(import.meta.url)('@stripe/forge/package.json') as {
      version: string;
    };
    assert.equal(FORGE_VERSION, metadata.version);
    assert.equal(FORGE_BUILD_IDENTITY.version, metadata.version);
    assert.equal(Object.isFrozen(FORGE_BUILD_IDENTITY), true);
  });

  it('snapshots optional source provenance without making it a compatibility gate', () => {
    const source = {version: FORGE_VERSION, commit_sha: 'a'.repeat(40), dirty: false};
    const parsed = parseForgeBuildIdentity(source);
    source.commit_sha = 'b'.repeat(40);
    source.dirty = true;
    assert.deepEqual(parsed, {version: FORGE_VERSION, commit_sha: 'a'.repeat(40), dirty: false});
    assert.equal(Object.isFrozen(parsed), true);
    assert.doesNotThrow(() => assertCompatibleForgeVersion(parsed.version));
  });

  it('rejects unknown, missing, malformed, and non-JSON identity fields', () => {
    for (const input of [
      null, [], '1.0.0', {}, {version: ''}, {version: '1\nforged'},
      {version: 1}, {version: '1.0.0', source: 'private'},
      {version: '1.0.0', commit_sha: 'abc'},
      {version: '1.0.0', commit_sha: 'A'.repeat(40)},
      {version: '1.0.0', commit_sha: undefined},
      {version: '1.0.0', dirty: 'false'},
      {version: '1.0.0', dirty: undefined},
      {version: '1.0.0', [Symbol('hidden')]: true},
      Object.create({version: '1.0.0'}),
    ]) {
      assert.throws(() => parseForgeBuildIdentity(input), TypeError);
    }
    assert.deepEqual(parseForgeBuildIdentity({version: '1.0.0'}), {version: '1.0.0'});
  });

  it('requires official producer and reader versions to match exactly', async () => {
    const fixture = await versionModuleFixture('1.2.3');
    try {
      const version = await import(fixture.module.href) as typeof import('./version.js');
      assert.doesNotThrow(() => version.assertCompatibleForgeVersion('1.2.3'));
      for (const producer of ['1.2.4', '1.2.3-dev.1', '1.2.3-rc.1']) {
        assert.throws(() => version.assertCompatibleForgeVersion(producer), /official releases require an exact version match/);
      }
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('allows different explicit development snapshots but rejects other release identities', async () => {
    const fixture = await versionModuleFixture('1.2.3-dev.1');
    try {
      const version = await import(fixture.module.href) as typeof import('./version.js');
      assert.doesNotThrow(() => version.assertCompatibleForgeVersion('9.8.7-dev.42'));
      assert.doesNotThrow(() => version.assertCompatibleForgeVersion('1.2.3-dev.1'));
      for (const producer of ['1.2.3', '1.2.3-rc.1', '1.2.3-dev', '1.2.3-beta.1', '1']) {
        assert.throws(() => version.assertCompatibleForgeVersion(producer), /incompatible with installed Forge/);
      }
      assert.throws(() => version.assertCompatibleForgeVersion('bad\nversion'), /safe version/);
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('loads packaged source provenance independently of the consuming working directory', async () => {
    const identity = {version: '1.2.3-dev.1', commit_sha: 'c'.repeat(40), dirty: true};
    const fixture = await versionModuleFixture(identity.version, identity);
    try {
      const version = await import(fixture.module.href) as typeof import('./version.js');
      assert.deepEqual(version.FORGE_BUILD_IDENTITY, identity);
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('rejects packaged metadata from a different package version', async () => {
    const fixture = await versionModuleFixture('1.2.3', {version: '1.2.4'});
    try {
      await assert.rejects(import(fixture.module.href), /does not match the installed package version/);
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });
});

async function versionModuleFixture(version: string, identity?: ForgeBuildIdentity) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-version-'));
  await mkdir(path.join(root, 'model'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@stripe/forge', type: 'module', version,
    exports: {'./package.json': './package.json'},
  }));
  await cp(new URL('./version.js', import.meta.url), path.join(root, 'version.js'));
  await cp(new URL('./model/paths.js', import.meta.url), path.join(root, 'model', 'paths.js'));
  if (identity !== undefined) {
    await writeFile(path.join(root, 'build-info.json'), JSON.stringify(identity));
  }
  return {root, module: pathToFileURL(path.join(root, 'version.js'))};
}
