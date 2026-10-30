import assert from 'node:assert/strict';
import { parse } from 'toml';
import { it } from 'vitest';
import { OPEN_CODE_MODEL_PROFILE } from '../../test/support/opencode.ts';
import { createClaudeCodeAdapter } from '../agents/claude-code/index.ts';
import {
  CODEX_HOME_STATE_ID,
  createCodexAdapter,
} from '../agents/codex/index.ts';
import { createOpenCodeAdapter } from '../agents/opencode/index.ts';
import { parseSetupStep } from '../model/parse.ts';
import { createMemoryRunInputProvider } from '../testing/memoryInputs.ts';
import { createMemoryWorkspace } from '../testing/memoryWorkspace.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { createSetupExecutor } from './executor.ts';
import {
  assertWebSearchConfiguration,
  WEB_SEARCH_RESOLUTION,
} from './forgeWebSearch.ts';

const baseRuntime = createTestResolvedRunPlan().runtime;
if ('config' in baseRuntime) throw new Error('Expected built-in runtime');
const step = { uses: 'forge/web-search', with: {} };
const url = 'http://127.0.0.1:12345/run/mcp/web-search';
for (const adapter of [
  createClaudeCodeAdapter(),
  createCodexAdapter(),
  createOpenCodeAdapter({ baseUrl: 'https://example.com/v1' }),
]) {
  it(`configures authenticated search for ${adapter.id}, preserving other servers`, async () => {
    const plan = createTestResolvedRunPlan({
      agent: {
        adapter: adapter.id,
        provider:
          adapter.id === 'claude-code'
            ? 'anthropic'
            : adapter.id === 'codex'
              ? 'openai'
              : 'openai-compatible',
        model: 'test',
        ...(adapter.id === 'opencode'
          ? { model_profile: OPEN_CODE_MODEL_PROFILE }
          : {}),
      },
      runtime: { ...baseRuntime, network: 'host' },
      treatmentSetup: [step],
    });
    const requirements = adapter.requirements(plan.agent);
    const prepared = createSetupExecutor().preflight(plan.setup, {
      selection: plan.agent,
      runtime: plan.runtime,
      agentStateDirectories: requirements.stateDirectories,
    });
    assert.deepEqual(prepared.requirements.credentials, {
      agent: {
        FORGE_WEB_SEARCH_TOKEN: { reference: 'forge.web-search-token' },
      },
    });
    const workspace = createMemoryWorkspace({
      '.mcp.json': JSON.stringify({
        mcpServers: { other: { type: 'http', url: 'https://example.com' } },
      }),
      'opencode.json': JSON.stringify({
        mcp: { other: { type: 'remote', url: 'https://example.com' } },
      }),
    });
    const home = createMemoryWorkspace({
      'config.toml':
        '[mcp_servers.other]\nurl="https://example.com"\nbearer_token_env_var="OTHER_TOKEN"\n',
    });
    const stateDirectories = new Map([[CODEX_HOME_STATE_ID, home.mutable]]);
    const applied = await prepared.apply({
      runId: 'test',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace: workspace.mutable,
      stateDirectories,
      webSearchUrl: url,
      inputs: createMemoryRunInputProvider(),
      signal: new AbortController().signal,
      commands: {
        uncredentialed: {
          async run() {
            throw new Error('No commands needed');
          },
        },
        setup() {
          throw new Error('No setup credentials');
        },
      },
    });
    assert.deepEqual(applied.steps[0]?.resolution, WEB_SEARCH_RESOLUTION);
    const config =
      adapter.id === 'codex'
        ? parse(
            Buffer.from(await home.mutable.readFile('config.toml')).toString(),
          )
        : JSON.parse(
            Buffer.from(
              await workspace.mutable.readFile(
                adapter.id === 'claude-code' ? '.mcp.json' : 'opencode.json',
              ),
            ).toString(),
          );
    const servers =
      config[
        adapter.id === 'codex'
          ? 'mcp_servers'
          : adapter.id === 'claude-code'
            ? 'mcpServers'
            : 'mcp'
      ];
    assert.equal(servers.other.url, 'https://example.com');
    assert.equal(servers.web_search.url, url);
    if (adapter.id === 'codex')
      assert.equal(
        servers.web_search.bearer_token_env_var,
        'FORGE_WEB_SEARCH_TOKEN',
      );
    else
      assert.equal(
        servers.web_search.headers.Authorization,
        adapter.id === 'claude-code'
          ? // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands ${VAR} in MCP headers itself.
            'Bearer ${FORGE_WEB_SEARCH_TOKEN}'
          : 'Bearer {env:FORGE_WEB_SEARCH_TOKEN}',
      );
    await assertWebSearchConfiguration(
      plan,
      { workspace: workspace.mutable, stateDirectories },
      url,
    );
    if (adapter.id === 'codex')
      await home.mutable.writeFile('config.toml', Buffer.from(''));
    else
      await workspace.mutable.writeFile(
        adapter.id === 'claude-code' ? '.mcp.json' : 'opencode.json',
        Buffer.from('{}'),
      );
    await assert.rejects(
      assertWebSearchConfiguration(
        plan,
        { workspace: workspace.mutable, stateDirectories },
        url,
      ),
      /changed/,
    );
  });
}

it('strictly rejects authored authority and requires explicit Docker host networking', () => {
  assert.throws(() =>
    parseSetupStep({
      uses: 'forge/web-search',
      with: { url: 'https://example.com' },
    }),
  );
  const plan = createTestResolvedRunPlan({
    agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
    treatmentSetup: [step],
  });
  assert.throws(
    () =>
      createSetupExecutor().preflight(plan.setup, {
        selection: plan.agent,
        runtime: plan.runtime,
      }),
    /network: host/,
  );
});
