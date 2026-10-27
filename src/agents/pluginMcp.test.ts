import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseSetupStep } from '../model/parse.ts';
import { createMemoryWorkspace } from '../testing/memoryWorkspace.ts';
import { configurePluginMcp, configurePluginMcpDocument } from './pluginMcp.ts';

const servers = ['stripe'] as const;
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
    const relays = {
      stripe: { url: 'http://127.0.0.1:12345/mcp', token: 'a'.repeat(64) },
    };
    for (const adapter of ['claude-code', 'codex'] as const) {
      const configured = configurePluginMcpDocument(
        input,
        adapter,
        servers,
        relays,
      );
      assert.deepEqual(configured, {
        mcpServers: {
          stripe: {
            type: 'http',
            url: relays.stripe.url,
            [adapter === 'claude-code' ? 'headers' : 'http_headers']: {
              Authorization: `Bearer ${relays.stripe.token}`,
            },
          },
          other: input.mcpServers.other,
        },
      });
      assert.ok(!JSON.stringify(configured).includes('STRIPE_API_KEY'));
      assert.ok(!JSON.stringify(configured).includes('env:'));
    }
    assert.equal(input.mcpServers.stripe.headers.authorization, 'old');
    assert.throws(
      () => configurePluginMcpDocument(input, 'codex', servers),
      /host credential relay/,
    );
    assert.throws(
      () =>
        configurePluginMcpDocument(
          { mcpServers: { stripe: { url: 'https://example.com' } } },
          'codex',
          servers,
          relays,
        ),
      /unsupported URL/,
    );
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
          configurePluginMcpDocument(
            { mcpServers: stripe ? { stripe } : {} },
            'codex',
            servers,
          ),
        /absent|HTTP|auth|URL/,
      );
    }
  });

  it('rejects manifest redirects instead of configuring an unused file', async () => {
    const state = createMemoryWorkspace();
    await state.mutable.writeFile(
      'plugin/.claude-plugin/plugin.json',
      Buffer.from('{"mcpServers":"custom.json"}'),
    );
    await assert.rejects(
      configurePluginMcp(state.mutable, 'plugin', 'claude-code', servers),
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
      configurePluginMcp(state.mutable, 'plugin', 'codex', servers),
      /Agent Plugins.*unsupported.*Claude-format/,
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
