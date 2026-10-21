import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '../contracts/credentials.ts';
import { parseSetupStep } from '../model/parse.ts';
import { createMemoryWorkspace } from '../testing/memoryWorkspace.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import {
  configurePluginMcp,
  configurePluginMcpDocument,
  pluginMcpCredentials,
  pluginMcpEnvironmentBindings,
} from './pluginMcp.ts';

const servers = ['stripe'] as const;
const step = {
  uses: 'forge/plugin',
  with: {
    agents: { codex: { plugin: 'stripe@stripe', marketplace: 'stripe/ai' } },
  },
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
    const claude = configurePluginMcpDocument(input, 'claude-code', servers);
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
    const codex = configurePluginMcpDocument(
      {
        mcpServers: {
          stripe: {
            url: 'https://mcp.stripe.com',
            http_headers: { Authorization: 'old', Accept: 'application/json' },
          },
        },
      },
      'codex',
      servers,
    );
    assert.deepEqual(codex, {
      mcpServers: {
        stripe: {
          url: 'https://mcp.stripe.com',
          http_headers: { Accept: 'application/json' },
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
          configurePluginMcpDocument(
            { mcpServers: stripe ? { stripe } : {} },
            'codex',
            servers,
          ),
        /absent|HTTP|auth/,
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
      /Agent Plugins.*bearer auth.*stripe@claude-plugins-official/,
    );
  });

  it('declares opaque credentials under their registered names and binds only selected inputs', () => {
    assert.deepEqual(pluginMcpEnvironmentBindings([]), {});
    assert.deepEqual(pluginMcpCredentials(servers), {
      STRIPE_API_KEY: { reference: 'env:STRIPE_API_KEY' },
    });
    const plan = createTestResolvedRunPlan({
      agent: { adapter: 'codex', provider: 'openai', model: 'test' },
      treatmentSetup: [parseSetupStep(step)],
    });
    assert.deepEqual(pluginMcpEnvironmentBindings([plan]), {
      'env:STRIPE_API_KEY': 'STRIPE_API_KEY',
    });
    assert.throws(
      () =>
        pluginMcpEnvironmentBindings([plan], { 'env:STRIPE_API_KEY': 'OTHER' }),
      /must be bound/,
    );
  });

  it('binds only the selected adapter distribution, not other plugins or marketplaces', () => {
    for (const selected of [
      { plugin: 'formatter@example', marketplace: 'example/plugins' },
      { plugin: 'stripe@stripe', marketplace: 'example/stripe-mirror' },
      { plugin: 'other@stripe', marketplace: 'stripe/ai' },
    ]) {
      const plan = createTestResolvedRunPlan({
        agent: { adapter: 'codex', provider: 'openai', model: 'test' },
        treatmentSetup: [
          parseSetupStep({
            uses: 'forge/plugin',
            with: {
              agents: {
                codex: selected,
                'claude-code': {
                  plugin: 'stripe@claude-plugins-official',
                  marketplace: 'anthropics/claude-plugins-official',
                },
              },
            },
          }),
        ],
      });
      assert.deepEqual(pluginMcpEnvironmentBindings([plan]), {});
    }
  });

  it('requires the registered host key without accepting an alternate auth variable', async () => {
    const plan = createTestResolvedRunPlan({
      agent: { adapter: 'codex', provider: 'openai', model: 'test' },
      treatmentSetup: [parseSetupStep(step)],
    });
    const resolver = createEnvironmentCredentialResolver({
      bindings: pluginMcpEnvironmentBindings([plan]),
      environment: { OTHER_KEY: 'synthetic-key' },
    });
    await assert.rejects(
      resolver.resolve(credentialReference('env:STRIPE_API_KEY'), {
        runId: 'test',
        purpose: 'agent',
        signal: new AbortController().signal,
      }),
      /Set STRIPE_API_KEY/,
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
