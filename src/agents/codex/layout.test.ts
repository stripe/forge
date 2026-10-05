import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {FORGE_VERSION} from '../../version.js';
import {createCodexAdapter, type CodexLayout} from './index.js';
import {assertCodexRuntimeLayout, resolveCodexLayout, usesDefaultCodexLayout} from './layout.js';

const layout: CodexLayout = {
  workspace: '/tmp/run/workspace', home: '/tmp/run/home', configDirectory: '/tmp/run/session',
};
const selection = {adapter: 'codex', provider: 'openai', model: 'gpt-test'};

describe('Codex runtime layout', () => {
  it('preserves default adapter identity for an explicitly supplied Docker layout', () => {
    const resolved = resolveCodexLayout(undefined);
    assert.ok(Object.isFrozen(resolved));
    assert.deepEqual(resolved, {
      workspace: '/workspace', home: '/home/forge', configDirectory: '/home/forge/.codex',
    });
    assert.ok(usesDefaultCodexLayout(resolved));
    const adapter = createCodexAdapter({layout: {...resolved}});
    assert.equal(adapter.version, FORGE_VERSION);
    assert.deepEqual(adapter.metadata, {endpoint_mode: 'default', layout_mode: 'default'});
    assert.deepEqual(adapter.requirements(selection).environment.variables, {CODEX_HOME: '/home/forge/.codex'});
  });

  it('snapshots caller-owned layout values and identifies custom runtime behavior', () => {
    const source = {...layout};
    const adapter = createCodexAdapter({layout: source});
    source.workspace = '/changed/workspace';
    source.home = '/changed/home';
    source.configDirectory = '/changed/config';
    assert.equal(adapter.version, FORGE_VERSION);
    assert.deepEqual(adapter.metadata, {endpoint_mode: 'default', layout_mode: 'custom'});
    assert.deepEqual(adapter.requirements(selection).environment.variables, {CODEX_HOME: layout.configDirectory});
    assert.deepEqual(adapter.requirements(selection).stateDirectories, [{
      id: 'codex-home', containerPath: layout.configDirectory,
    }]);
    assert.equal(createCodexAdapter({layout, baseUrl: 'https://gateway.example.test/v1'}).version,
      FORGE_VERSION);
    assert.equal(usesDefaultCodexLayout(resolveCodexLayout(layout)), false);
  });

  it('accepts a config root below home or separate from home without path coercion', () => {
    for (const configDirectory of ['/tmp/run/home/.codex', '/tmp/run/session', '/other/配置']) {
      const resolved = resolveCodexLayout({...layout, configDirectory});
      assert.equal(resolved.configDirectory, configDirectory);
      assert.ok(Object.isFrozen(resolved));
      assertCodexRuntimeLayout(resolved, {workspace: layout.workspace, home: layout.home});
    }
    assert.equal(resolveCodexLayout({...layout, workspace: '/tmp/run/space name.项目'}).workspace,
      '/tmp/run/space name.项目');
  });

  it('rejects incomplete, non-plain, or extra-field layouts', () => {
    const malformed: unknown[] = [null, [], {}, {...layout, extra: '/unexpected'},
      {...layout, [Symbol('extra')]: '/unexpected'}, Object.assign(new Date(), layout),
      {workspace: layout.workspace, home: layout.home},
    ];
    for (const candidate of malformed) {
      assert.throws(() => resolveCodexLayout(candidate as CodexLayout), /Codex layout/);
    }
  });

  it('rejects noncanonical or unbounded paths in every layout field', () => {
    const longCanonicalPath = `/${Array.from({length: 15}, () => 'x'.repeat(250)).join('/')}`;
    for (const field of ['workspace', 'home', 'configDirectory']) {
      for (const value of [undefined, 123, '', 'relative', '/', '/tmp/../workspace',
        '/tmp//workspace', '/tmp/workspace/', '/tmp/work\0space', '/tmp/work\nspace',
        '/tmp/work\\space', '/tmp/cafe\u0301', `/tmp/${'x'.repeat(256)}`, `/tmp/${'é'.repeat(128)}`,
        longCanonicalPath]) {
        assert.throws(() => resolveCodexLayout({...layout, [field]: value} as CodexLayout), /Codex paths/);
      }
    }
  });

  it('rejects overlapping workspace, home, and configuration roots', () => {
    for (const candidate of [
      {...layout, home: layout.workspace},
      {...layout, home: `${layout.workspace}/home`},
      {...layout, workspace: `${layout.home}/workspace`},
      {...layout, configDirectory: layout.workspace},
      {...layout, configDirectory: `${layout.workspace}/config`},
      {...layout, workspace: `${layout.configDirectory}/workspace`},
      {...layout, configDirectory: layout.home},
      {...layout, configDirectory: '/tmp/run'},
    ]) {
      assert.throws(() => resolveCodexLayout(candidate), /must be separate/);
    }
  });

  it('compares declared home and workspace exactly against runtime-visible paths', () => {
    for (const paths of [
      {workspace: '/other/workspace', home: layout.home},
      {workspace: layout.workspace, home: '/other/home'},
    ]) {
      assert.throws(() => assertCodexRuntimeLayout(layout, paths), /paths do not match/);
    }
  });
});
