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
const step = {
  uses: 'forge/plugin',
  with: { plugin: 'stripe' },
};

describe('plugin MCP bearer authentication', () => {
  it('retains native endpoints, other servers and non-auth headers without mutating input', () => {
    const input = {
      mcpServers: {
        stripe: {
          type: 'http',
          url: 'https://mcp.stripe.com',
          headers: { authorization: 'old', Accept: 'application/json' },
        },
        other: { command: 'local' },
      },
      extra: true,
    };
    const claude = configurePluginMcpDocument(input, servers);
    assert.deepEqual(claude, {
      ...input,
      mcpServers: {
        ...input.mcpServers,
        stripe: {
          ...input.mcpServers.stripe,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer \${STRIPE_API_KEY}`,
          },
        },
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
    );
    assert.deepEqual(codex, {
      document: {
        mcpServers: { other: { command: 'local', enabled_tools: ['read'] } },
        extra: true,
      },
      declarations: {
        stripe: {
          url: 'https://mcp.stripe.com',
          bearer_token_env_var: 'STRIPE_API_KEY',
        },
      },
    });
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
          ),
        /absent|HTTP|auth/,
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
    );
    assert.deepEqual(relocation.declarations, {
      stripe: {
        url: 'https://mcp.stripe.com',
        bearer_token_env_var: 'STRIPE_API_KEY',
      },
    });
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
