import { defaultForgeEngine } from '../engine.ts';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { it } from 'vitest';
import type { ForgeComposition } from '../contracts/composition.ts';
import { credentialReference } from '../contracts/credentials.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { createFakeRuntimeAdapter, createMemoryArtifactStore, createScriptedAgentAdapter, createMemoryRunInputProvider, createStaticCredentialResolver } from '../testing/index.ts';
import { executeEval, preflightEval } from './execute.ts';

function fixture() {
  const agent = createScriptedAgentAdapter({ id: 'claude-code' }).adapter;
  const runtime = createFakeRuntimeAdapter();
  const baseRuntime = createTestResolvedRunPlan().runtime;
  if ('config' in baseRuntime) throw new Error('Expected Docker');
  const plan = createTestResolvedRunPlan({
    agent: { adapter: agent.id, provider: 'anthropic', model: 'test' },
    runtime: { ...baseRuntime, network: 'host' }, treatmentSetup: [{ uses: 'forge/web-search', with: {} }],
  });
  const store = createMemoryArtifactStore();
  const resolutions: string[] = [];
  const composition: ForgeComposition = {
    agents: new Map([[agent.id, agent]]), runtime: runtime.adapter,
    credentialResolver: createStaticCredentialResolver({ 'test.search-key': 'host-only-search-secret' }, { onResolve(ref, purpose) { resolutions.push(`${ref}:${purpose}`); } }),
    inputProvider: createMemoryRunInputProvider(), artifactStore: store.store,
    webSearch: { baseUrl: 'http://127.0.0.1:1', credential: credentialReference('test.search-key') },
  };
  return { agent, runtime, plan, store, composition, resolutions };
}

it('keeps upstream authority out of runtime and workspace, and tears down after success', async () => {
  const test = fixture();
  let url = '';
  const agent = { ...test.agent, async openSession(context: Parameters<typeof test.agent.openSession>[0]) {
    const config = JSON.parse(Buffer.from(await context.runtime.workspace.readFile('.mcp.json')).toString());
    url = config.mcpServers.web_search.url;
    const env = test.runtime.runs[0]!.input.environment;
    assert.equal(JSON.stringify(env).includes('host-only-search-secret'), false);
    assert.deepEqual(env.credentials.FORGE_WEB_SEARCH_TOKEN?.scopes, ['agent']);
    assert.ok(env.credentials.FORGE_WEB_SEARCH_TOKEN?.value);
    assert.equal(JSON.stringify(config).includes(env.credentials.FORGE_WEB_SEARCH_TOKEN.value), false);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.credentials.FORGE_WEB_SEARCH_TOKEN.value}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(response.status, 200);
    return test.agent.openSession(context);
  } };
  const completed = await executeEval({ runId: 'search-success', plan: test.plan, composition: { ...test.composition, agents: new Map([[agent.id, agent]]) } });
  assert.equal(completed.result.evaluation.status, 'passed');
  assert.deepEqual(test.resolutions, ['test.search-key:web_search']);
  assert.ok(url);
  await assert.rejects(fetch(url));
  for (const artifact of test.store.runs.get('search-success')!.artifacts.values())
    assert.equal(Buffer.from(artifact.body).toString().includes('host-only-search-secret'), false);
});

it('tears down on interaction failure and rejects unsupported configuration before credential lookup', async () => {
  const test = fixture();
  let url = '';
  const agent = { ...test.agent, async openSession(context: Parameters<typeof test.agent.openSession>[0]) {
    url = JSON.parse(Buffer.from(await context.runtime.workspace.readFile('.mcp.json')).toString()).mcpServers.web_search.url;
    throw new Error('Intentional failure');
  } };
  await assert.rejects(executeEval({ runId: 'search-failure', plan: test.plan, composition: { ...test.composition, agents: new Map([[agent.id, agent]]) } }));
  assert.ok(url);
  await assert.rejects(fetch(url));
  const { webSearch: _, ...withoutSearch } = test.composition;
  const count = test.resolutions.length;
  assert.throws(() => preflightEval({ plan: test.plan, composition: withoutSearch }), { code: 'invalid_plan', phase: 'preflight' });
  assert.equal(test.resolutions.length, count);
});

it('closes readiness listeners even if later selected credentials fail', async () => {
  const test = fixture();
  const credentials = test.composition.credentialResolver;
  let lookups = 0;
  await assert.rejects(defaultForgeEngine.validateRuntime([
    { plan: test.plan, composition: { ...test.composition, credentialResolver: { resolve(ref, context) { if (++lookups === 2) throw new Error('Unavailable'); return credentials.resolve(ref, context); } } } },
    { plan: test.plan, composition: { ...test.composition, credentialResolver: { async resolve() { throw new Error('Unavailable'); } } } },
  ]));
  assert.equal(test.runtime.runs.length, 0);
});
