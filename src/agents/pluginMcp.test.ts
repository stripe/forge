import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseSetupStep } from '../model/parse.ts';
import { createMemoryWorkspace } from '../testing/memoryWorkspace.ts';
import {
  configurePluginMcp,
  configurePluginMcpDocument,
  prepareCodexPluginMcpRelocation,
  relocateCodexPluginMcp,
  writeRelocatedPluginMcp,
} from './pluginMcp.ts';

const servers = ['stripe'] as const;
const relays = {
  stripe: { url: 'http://127.0.0.1:12345/mcp', token: 'a'.repeat(64) },
};
const step = {
  uses: 'forge/plugin',
  with: { plugin: 'stripe' },
};

describe('plugin MCP bearer authentication', () => {
  it('replaces upstream auth and endpoints with relay capabilities without mutating input', () => {
    const input = {
      mcpServers: {
        stripe: {
          type: 'http',
          url: 'https://mcp.stripe.com',
          headers: { authorization: 'old' },
          bearer_token_env_var: 'STRIPE_API_KEY',
        },
        other: { command: 'local' },
      },
    };
    const claude = configurePluginMcpDocument(input, servers, relays);
    assert.deepEqual(claude, {
      mcpServers: {
        stripe: {
          type: 'http',
          url: relays.stripe.url,
          headers: { Authorization: `Bearer ${relays.stripe.token}` },
        },
        other: input.mcpServers.other,
      },
    });
    assert.equal(input.mcpServers.stripe.headers.authorization, 'old');
    const codex = relocateCodexPluginMcp(
      {
        mcpServers: {
          stripe: {
            url: 'https://mcp.stripe.com',
            bearer_token_env_var: 'OLD_KEY',
          },
          other: { command: 'local', enabled_tools: ['read'] },
        },
        extra: true,
      },
      servers,
      relays,
    );
    assert.deepEqual(codex, {
      document: {
        mcpServers: { other: { command: 'local', enabled_tools: ['read'] } },
        extra: true,
      },
      upstream: { stripe: 'https://mcp.stripe.com' },
      declarations: {
        stripe: {
          url: relays.stripe.url,
          bearer_token_env_var: 'FORGE_STRIPE_MCP_RELAY_TOKEN',
        },
      },
    });
    for (const configured of [claude, codex])
      assert.ok(!JSON.stringify(configured).includes('STRIPE_API_KEY'));
    assert.ok(!JSON.stringify(codex).includes(relays.stripe.token));
    assert.throws(
      () => configurePluginMcpDocument(input, servers),
      /host credential relay/,
    );
    assert.throws(
      () => relocateCodexPluginMcp(input, servers),
      /host credential relay/,
    );
    for (const document of [
      { mcpServers: { stripe: { type: 'http', url: 'https://example.com' } } },
    ]) {
      assert.throws(
        () => configurePluginMcpDocument(document, servers, relays),
        /unsupported URL/,
      );
      assert.throws(
        () => relocateCodexPluginMcp(document, servers, relays),
        /unsupported URL/,
      );
    }
  });

  it('fails on absent servers, unsupported transport and competing auth sources', () => {
    for (const stripe of [
      undefined,
      { type: 'stdio', command: 'x' },
      { type: 'sse', url: 'https://example.com' },
      { url: 'https://example.com', oauth: {} },
      {
        type: 'http',
        url: 'https://example.com',
        headersHelper: 'node auth.js',
      },
    ]) {
      assert.throws(
        () =>
          relocateCodexPluginMcp(
            { mcpServers: stripe ? { stripe } : {} },
            servers,
            relays,
          ),
        /absent|HTTP|auth|URL/,
      );
    }
  });

  it('rejects bundled settings the Codex relocation would drop, URL credential carriers and header auth', () => {
    const base = { type: 'http', url: 'https://mcp.stripe.com' };
    for (const extra of [
      { enabled: false },
      { enabled_tools: ['read'] },
      { disabled_tools: ['write'] },
      { startup_timeout_sec: 60 },
      { tool_timeout_sec: 120 },
      { required: true },
      { http_headers: { Accept: 'application/json' } },
      { http_headers: { 'X-API-Key': 'synthetic-secret' } },
      { http_headers: { Authorization: 'synthetic-secret' } },
      { env_http_headers: { 'X-Other': 'SOME_ENV' } },
      { headers: { Authorization: 'synthetic-secret' } },
      { bearer_token: 'synthetic-secret' },
      { bearer_token_env_var: 7 },
      { url: 'https://mcp.stripe.com?api_key=synthetic-secret' },
      { url: 'https://mcp.stripe.com#synthetic-secret' },
      { url: 'https://mcp.stripe.com?' },
      { url: 'https://user:synthetic-secret@mcp.stripe.com' },
    ]) {
      assert.throws(
        () =>
          relocateCodexPluginMcp(
            { mcpServers: { stripe: { ...base, ...extra } } },
            servers,
            relays,
          ),
        /not carry|auth|URL/,
        JSON.stringify(extra),
      );
    }
  });

  it('moves Codex connections out of the bundle, which Codex re-materializes after startup', async () => {
    const state = createMemoryWorkspace();
    await state.mutable.writeFile(
      'plugin/.mcp.json',
      Buffer.from(
        '{"mcpServers":{"stripe":{"type":"http","url":"https://mcp.stripe.com"}}}',
      ),
    );
    const relocation = await prepareCodexPluginMcpRelocation(
      state.mutable,
      'plugin',
      servers,
      relays,
    );
    assert.deepEqual(relocation.declarations, {
      stripe: {
        url: relays.stripe.url,
        bearer_token_env_var: 'FORGE_STRIPE_MCP_RELAY_TOKEN',
      },
    });
    assert.deepEqual(relocation.upstream, { stripe: 'https://mcp.stripe.com' });
    // Preparing the move changes nothing until it is written.
    assert.deepEqual(
      JSON.parse(
        Buffer.from(await state.mutable.readFile('plugin/.mcp.json')).toString(
          'utf8',
        ),
      ),
      {
        mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } },
      },
    );
    await writeRelocatedPluginMcp(state.mutable, relocation);
    assert.deepEqual(
      JSON.parse(
        Buffer.from(await state.mutable.readFile('plugin/.mcp.json')).toString(
          'utf8',
        ),
      ),
      { mcpServers: {} },
    );
  });

  it('rejects manifest redirects instead of configuring an unused file', async () => {
    const state = createMemoryWorkspace();
    await state.mutable.writeFile(
      'plugin/.claude-plugin/plugin.json',
      Buffer.from('{"mcpServers":"custom.json"}'),
    );
    await assert.rejects(
      configurePluginMcp(state.mutable, 'plugin', servers),
      /manifest MCP overrides/,
    );
  });

  it('rejects root manifests whose native format loads mcp.json instead', async () => {
    const state = createMemoryWorkspace();
    await state.mutable.writeFile(
      'plugin/plugin.json',
      Buffer.from('{"name":"fixture","version":"1.0.0"}'),
    );
    await assert.rejects(
      prepareCodexPluginMcpRelocation(state.mutable, 'plugin', servers),
      /Agent Plugins.*bearer auth.*Claude-format/,
    );
  });

  it('accepts plugin selection alone and rejects authored MCP configuration', () => {
    assert.deepEqual(parseSetupStep(step), step);
    for (const mcp_servers of [
      ['stripe'],
      [],
      ['unknown'],
      ['stripe', 'stripe'],
      [{ server: 'stripe', bearer_token: 'secret' }],
      { stripe: {} },
      { stripe: { bearer_token: { env: 'STRIPE_API_KEY' } } },
      { stripe: { bearer_token: { env: 'KEY', value: 'secret' } } },
      { stripe: { url: 'https://other.test', bearer_token: { env: 'KEY' } } },
    ]) {
      assert.throws(() =>
        parseSetupStep({ ...step, with: { ...step.with, mcp_servers } }),
      );
    }
  });
});
