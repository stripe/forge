import assert from 'node:assert/strict';
import { parse } from 'toml';
import { describe, it } from 'vitest';

import { createMemoryWorkspace } from '../../testing/memoryWorkspace.ts';
import {
  declareCodexMcpServers,
  prepareCodexPluginConfiguration,
} from './pluginConfig.ts';

describe('Codex run-owned plugin configuration', () => {
  it('retains native plugin and project/hook state while removing provider settings', async () => {
    const state = createMemoryWorkspace({
      'config.toml': `
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
`,
    });
    await prepareCodexPluginConfiguration(state.mutable);
    const first = Buffer.from(
      await state.readonly.readFile('config.toml'),
    ).toString();
    assert.deepEqual(JSON.parse(JSON.stringify(parse(first))), {
      marketplaces: {
        test: {
          source_type: 'git',
          source: 'https://github.com/example/plugins.git',
        },
      },
      plugins: { 'fixture@test': { enabled: false } },
      projects: { '/workspace': { trust_level: 'trusted' } },
      hooks: {
        state: {
          '/workspace/.codex/hooks.json:SessionStart:0': {
            enabled: false,
            trusted_hash: `sha256:${'a'.repeat(64)}`,
          },
        },
      },
    });
    assert.doesNotMatch(first, /synthetic-secret|wrong|model_providers/);
    await prepareCodexPluginConfiguration(state.mutable);
    assert.equal(
      Buffer.from(await state.readonly.readFile('config.toml')).toString(),
      first,
    );
  });

  it('declares Forge MCP connections and preserves them through later preparation', async () => {
    const state = createMemoryWorkspace({
      'config.toml': '[plugins."fixture@test"]\nenabled=true\n',
    });
    await declareCodexMcpServers(state.mutable, {
      stripe: {
        url: 'https://mcp.stripe.com',
        bearer_token_env_var: 'STRIPE_API_KEY',
      },
    });
    await prepareCodexPluginConfiguration(state.mutable);
    const config = JSON.parse(
      JSON.stringify(
        parse(
          Buffer.from(await state.readonly.readFile('config.toml')).toString(),
        ),
      ),
    );
    assert.deepEqual(config, {
      marketplaces: {},
      plugins: { 'fixture@test': { enabled: true } },
      mcp_servers: {
        stripe: {
          url: 'https://mcp.stripe.com',
          bearer_token_env_var: 'STRIPE_API_KEY',
        },
      },
    });
  });

  it('allows an identical repeated declaration and rejects a conflicting one before writing', async () => {
    const server = {
      url: 'https://mcp.stripe.com',
      bearer_token_env_var: 'STRIPE_API_KEY',
    };
    const state = createMemoryWorkspace();
    await declareCodexMcpServers(state.mutable, { stripe: server });
    await declareCodexMcpServers(state.mutable, { stripe: { ...server } });
    const before = Buffer.from(await state.readonly.readFile('config.toml'));
    for (const conflict of [
      { ...server, url: 'https://other.example.test' },
      { ...server, bearer_token_env_var: 'OTHER_KEY' },
    ]) {
      await assert.rejects(
        declareCodexMcpServers(state.mutable, { stripe: conflict }),
        /conflicts/,
      );
      assert.deepEqual(
        Buffer.from(await state.readonly.readFile('config.toml')),
        before,
      );
    }
  });

  it('rejects a merged configuration its next read would refuse, leaving prior bytes intact', async () => {
    const url = `https://mcp.example.test/${'a'.repeat(4_000)}`;
    const server = (index: number) =>
      `[mcp_servers.s${index}]\nurl = "${url}"\nbearer_token_env_var = "KEY"\n`;
    const state = createMemoryWorkspace({
      'config.toml': Array.from({ length: 256 }, (_, i) => server(i)).join(''),
    });
    await prepareCodexPluginConfiguration(state.mutable);
    const before = Buffer.from(await state.readonly.readFile('config.toml'));
    assert.ok(before.byteLength < 1024 * 1024);
    await assert.rejects(
      declareCodexMcpServers(state.mutable, {
        stripe: { url, bearer_token_env_var: 'KEY' },
      }),
      /unsupported or malformed/,
    );
    assert.deepEqual(
      Buffer.from(await state.readonly.readFile('config.toml')),
      before,
    );

    const full = createMemoryWorkspace({
      'config.toml': Array.from(
        { length: 10_000 },
        (_, i) =>
          `[mcp_servers.s${i}]\nurl = "https://a.test"\nbearer_token_env_var = "K"\n`,
      ).join(''),
    });
    await prepareCodexPluginConfiguration(full.mutable);
    const fullBefore = Buffer.from(await full.readonly.readFile('config.toml'));
    await assert.rejects(
      declareCodexMcpServers(full.mutable, {
        stripe: { url: 'https://a.test', bearer_token_env_var: 'K' },
      }),
      /unsupported or malformed/,
    );
    assert.deepEqual(
      Buffer.from(await full.readonly.readFile('config.toml')),
      fullBefore,
    );
  });

  it('allows an absent config and canonical local marketplace paths', async () => {
    const absent = createMemoryWorkspace();
    await prepareCodexPluginConfiguration(absent.mutable);
    assert.equal(absent.snapshot().size, 0);
    const local = createMemoryWorkspace({
      'config.toml': `
[marketplaces.test]
source_type="local"
source="/workspace/plugin fixtures"
[plugins."fixture@test"]
enabled=true
`,
    });
    await prepareCodexPluginConfiguration(local.mutable);
    assert.equal(
      (
        parse(
          Buffer.from(await local.readonly.readFile('config.toml')).toString(),
        ).plugins as Record<string, { enabled: boolean }>
      )['fixture@test']?.enabled,
      true,
    );
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
      'token = "synthetic-secret\n',
      `token = "${'x'.repeat(1024 * 1024)}"`,
      `token = ${'['.repeat(65)}"synthetic-secret"${']'.repeat(65)}`,
      '[plugins.__proto__]\nenabled=true',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token="synthetic-secret"',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token_env_var="KEY"\ncommand="synthetic-secret"',
      '[mcp_servers.stripe]\nurl="https://user:synthetic-secret@mcp.stripe.com"\nbearer_token_env_var="KEY"',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token_env_var="synthetic-secret value"',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token_env_var="KEY"\nhttp_headers={Authorization="synthetic-secret"}',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token_env_var="KEY"\nhttp_headers={"X-API-Key"="synthetic-secret"}',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token_env_var="KEY"\nenv_http_headers={"X-Other"="synthetic-secret value"}',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com?api_key=synthetic-secret"\nbearer_token_env_var="KEY"',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com#synthetic-secret"\nbearer_token_env_var="KEY"',
      '[mcp_servers.stripe]\nurl="https://mcp.stripe.com"\nbearer_token_env_var="KEY"\nenabled_tools=["read"]',
    ]) {
      const state = createMemoryWorkspace({ 'config.toml': config });
      await assert.rejects(
        prepareCodexPluginConfiguration(state.mutable),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /synthetic-secret|x{100}/);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(
        Buffer.from(state.snapshot().get('config.toml')!).toString(),
        config,
      );
    }
  });

  it('rejects configuration symlinks before reading or writing', async () => {
    const home = createMemoryWorkspace().mutable;
    await assert.rejects(
      prepareCodexPluginConfiguration({
        ...home,
        async inspect(path) {
          return { path, kind: 'symlink' };
        },
        async readFile() {
          throw new Error('must not read');
        },
        async writeFile() {
          throw new Error('must not write');
        },
      }),
      /regular file/,
    );
  });

  it('rejects unsafe keys even in settings that would be discarded', async () => {
    for (const config of [
      '__proto__ = "synthetic-secret"',
      'constructor = "synthetic-secret"',
      '[model_providers.forge]\nconstructor = "synthetic-secret"',
      'discarded = { nested = { "__proto__" = "synthetic-secret" } }',
      'discarded = [{ nested = { constructor = "synthetic-secret" } }]',
    ]) {
      const state = createMemoryWorkspace({ 'config.toml': config });
      await assert.rejects(
        prepareCodexPluginConfiguration(state.mutable),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /synthetic-secret/);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(
        Buffer.from(state.snapshot().get('config.toml')!).toString(),
        config,
      );
    }
  });

  it('bounds nested arrays and tables without changing rejected configuration', async () => {
    const atLimit = `discarded = ${'['.repeat(64)}"synthetic-secret"${']'.repeat(64)}`;
    const valid = createMemoryWorkspace({ 'config.toml': atLimit });
    await prepareCodexPluginConfiguration(valid.mutable);
    assert.doesNotMatch(
      Buffer.from(valid.snapshot().get('config.toml')!).toString(),
      /synthetic-secret/,
    );
    const tableAtLimit = createMemoryWorkspace({
      'config.toml':
        '[' +
        Array.from({ length: 64 }, (_, index) => `level${index}`).join('.') +
        ']\nvalue = "synthetic-secret"',
    });
    await prepareCodexPluginConfiguration(tableAtLimit.mutable);

    for (const config of [
      `discarded = ${'['.repeat(65)}"synthetic-secret"${']'.repeat(65)}`,
      '[' +
        Array.from({ length: 65 }, (_, index) => `level${index}`).join('.') +
        ']\nvalue = "synthetic-secret"',
      'discarded = ' +
        '['.repeat(100_000) +
        '"synthetic-secret"' +
        ']'.repeat(100_000),
      '[' +
        Array.from({ length: 100_000 }, () => 'a').join('.') +
        ']\nvalue = "synthetic-secret"',
      Array.from({ length: 100_000 }, () => 'a').join('.') +
        ' = "synthetic-secret"',
    ]) {
      const state = createMemoryWorkspace({ 'config.toml': config });
      await assert.rejects(
        prepareCodexPluginConfiguration(state.mutable),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /synthetic-secret/);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(
        Buffer.from(state.snapshot().get('config.toml')!).toString(),
        config,
      );
    }
  });

  it('accepts mixed arrays and lossless integers in discarded TOML settings', async () => {
    const state = createMemoryWorkspace({
      'config.toml': `
discarded = [1, "synthetic-secret", true, { nested = [2, "two"] }]
large_integer = 9223372036854775807
[plugins."fixture@test"]
enabled = true
`,
    });
    await prepareCodexPluginConfiguration(state.mutable);
    const source = Buffer.from(
      await state.readonly.readFile('config.toml'),
    ).toString();
    assert.equal(parse(source).plugins['fixture@test'].enabled, true);
    assert.doesNotMatch(source, /discarded|large_integer|synthetic-secret/);
  });

  it('ignores dots in comments, quoted keys, and single or multiline strings', async () => {
    const dots = '.'.repeat(100);
    const state = createMemoryWorkspace({
      'config.toml': `
# ${dots}
"${dots}" = "${dots}"
literal = '${dots}'
multiline_basic = """${dots}\n${dots}"""
multiline_literal = '''${dots}\n${dots}'''
escaped = "a\\"${dots}"
[plugins."fixture@test"]
enabled = true
`,
    });
    await prepareCodexPluginConfiguration(state.mutable);
    assert.equal(
      parse(
        Buffer.from(await state.readonly.readFile('config.toml')).toString(),
      ).plugins['fixture@test'].enabled,
      true,
    );
  });
});
