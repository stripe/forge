import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {parse} from '@iarna/toml';

import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';
import {prepareCodexPluginConfiguration} from './pluginConfig.js';

describe('Codex run-owned plugin configuration', () => {
  it('retains native plugin and project/hook state while removing provider settings', async () => {
    const state = createMemoryWorkspace({'config.toml': `
[marketplaces.test]
source_type = "git"
source = "https://github.com/example/plugins.git"
[plugins."fixture@test"]
enabled = false
[model_providers.forge]
base_url = "https://wrong.example.test"
experimental_bearer_token = "synthetic-secret"
http_headers = { "X-Wrong" = "synthetic-secret" }
env_http_headers = { "X-Wrong" = "WRONG_ENV" }
query_params = { wrong = "true" }
[projects."/workspace"]
trust_level = "trusted"
[hooks.state."/workspace/.codex/hooks.json:SessionStart:0"]
enabled = false
trusted_hash = "sha256:${'a'.repeat(64)}"
`});
    await prepareCodexPluginConfiguration(state.mutable);
    const first = Buffer.from(await state.readonly.readFile('config.toml')).toString();
    assert.deepEqual(JSON.parse(JSON.stringify(parse(first))), {
      marketplaces: {test: {source_type: 'git', source: 'https://github.com/example/plugins.git'}},
      plugins: {'fixture@test': {enabled: false}},
      projects: {'/workspace': {trust_level: 'trusted'}},
      hooks: {state: {'/workspace/.codex/hooks.json:SessionStart:0': {enabled: false, trusted_hash: `sha256:${'a'.repeat(64)}`}}},
    });
    assert.doesNotMatch(first, /synthetic-secret|wrong|model_providers/);
    await prepareCodexPluginConfiguration(state.mutable);
    assert.equal(Buffer.from(await state.readonly.readFile('config.toml')).toString(), first);
  });

  it('allows an absent config and canonical local marketplace paths', async () => {
    const absent = createMemoryWorkspace();
    await prepareCodexPluginConfiguration(absent.mutable);
    assert.equal(absent.snapshot().size, 0);
    const local = createMemoryWorkspace({'config.toml': `
[marketplaces.test]
source_type="local"
source="/workspace/plugin fixtures"
[plugins."fixture@test"]
enabled=true
`});
    await prepareCodexPluginConfiguration(local.mutable);
    assert.equal((parse(Buffer.from(await local.readonly.readFile('config.toml')).toString()).plugins as Record<string, {enabled: boolean}>)['fixture@test']?.enabled, true);
  });

  it('rejects unsupported native state, unsafe sources and malformed TOML without exposing source text', async () => {
    for (const config of [
      '[plugins."fixture@test"]\nenabled="synthetic-secret"',
      '[plugins."fixture@test"]\nenabled=true\nextra="synthetic-secret"',
      '[plugins."../fixture@test"]\nenabled=true',
      '[marketplaces.test]\nsource_type="local"\nsource="/workspace/../escape"',
      '[marketplaces.test]\nsource_type="git"\nsource="https://user:synthetic-secret@example.test/repo"',
      '[marketplaces.test]\nsource_type="npm"\nsource="synthetic-secret"',
      '[marketplaces.test]\nsource_type="git"\nsource="https://example.test/repo?synthetic-secret"',
      '[projects."/workspace/../escape"]\ntrust_level="trusted"',
      '[projects."/workspace"]\ntrust_level="synthetic-secret"',
      '[hooks.state.test]\nenabled="synthetic-secret"',
      '[hooks.state.test]\ntrusted_hash="synthetic-secret"',
      'token = "synthetic-secret\n', 'token = "' + 'x'.repeat(1024 * 1024) + '"',
      'token = ' + '['.repeat(65) + '"synthetic-secret"' + ']'.repeat(65),
      '[plugins.__proto__]\nenabled=true',
    ]) {
      const state = createMemoryWorkspace({'config.toml': config});
      await assert.rejects(prepareCodexPluginConfiguration(state.mutable), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic-secret|x{100}/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(Buffer.from(state.snapshot().get('config.toml')!).toString(), config);
    }
  });

  it('rejects configuration symlinks before reading or writing', async () => {
    const home = createMemoryWorkspace().mutable;
    await assert.rejects(prepareCodexPluginConfiguration({...home,
      async inspect(path) { return {path, kind: 'symlink'}; },
      async readFile() { throw new Error('must not read'); },
      async writeFile() { throw new Error('must not write'); },
    }), /regular file/);
  });

  it('rejects unsafe keys even in settings that would be discarded', async () => {
    for (const config of [
      '__proto__ = "synthetic-secret"',
      'constructor = "synthetic-secret"',
      '[model_providers.forge]\nconstructor = "synthetic-secret"',
      'discarded = { nested = { "__proto__" = "synthetic-secret" } }',
      'discarded = [{ nested = { constructor = "synthetic-secret" } }]',
    ]) {
      const state = createMemoryWorkspace({'config.toml': config});
      await assert.rejects(prepareCodexPluginConfiguration(state.mutable), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic-secret/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(Buffer.from(state.snapshot().get('config.toml')!).toString(), config);
    }
  });

  it('bounds nested arrays and tables without changing rejected configuration', async () => {
    const atLimit = 'discarded = ' + '['.repeat(64) + '"synthetic-secret"' + ']'.repeat(64);
    const valid = createMemoryWorkspace({'config.toml': atLimit});
    await prepareCodexPluginConfiguration(valid.mutable);
    assert.doesNotMatch(Buffer.from(valid.snapshot().get('config.toml')!).toString(), /synthetic-secret/);

    for (const config of [
      'discarded = ' + '['.repeat(65) + '"synthetic-secret"' + ']'.repeat(65),
      '[' + Array.from({length: 65}, (_, index) => `level${index}`).join('.') + ']\nvalue = "synthetic-secret"',
    ]) {
      const state = createMemoryWorkspace({'config.toml': config});
      await assert.rejects(prepareCodexPluginConfiguration(state.mutable), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic-secret/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(Buffer.from(state.snapshot().get('config.toml')!).toString(), config);
    }
  });
});
