import assert from 'node:assert/strict';
import * as http from 'node:http';
import { it } from 'vitest';
import type { ForgeComposition } from '../contracts/composition.ts';
import { credentialReference } from '../contracts/credentials.ts';
import { defaultForgeEngine } from '../engine.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../testing/index.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { executeEval, preflightEval } from './execute.ts';

function fixture() {
  const agent = createScriptedAgentAdapter({ id: 'claude-code' }).adapter;
  const runtime = createFakeRuntimeAdapter();
  const baseRuntime = createTestResolvedRunPlan().runtime;
  if ('config' in baseRuntime) throw new Error('Expected Docker');
  const plan = createTestResolvedRunPlan({
    agent: { adapter: agent.id, provider: 'anthropic', model: 'test' },
    runtime: { ...baseRuntime, network: 'host' },
    treatmentSetup: [{ uses: 'forge/web-search', with: {} }],
  });
  const store = createMemoryArtifactStore();
  const resolutions: string[] = [];
  const composition: ForgeComposition = {
    agents: new Map([[agent.id, agent]]),
    runtime: runtime.adapter,
    credentialResolver: createStaticCredentialResolver(
      { 'test.search-key': 'host-only-search-secret' },
      {
        onResolve(ref, purpose) {
          resolutions.push(`${ref}:${purpose}`);
        },
      },
    ),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: store.store,
    webSearch: {
      baseUrl: 'http://127.0.0.1:1',
      credential: credentialReference('test.search-key'),
    },
  };
  return { agent, runtime, plan, store, composition, resolutions };
}

it('validates upstream transport in pure preflight before any credentials or runtime allocation', () => {
  const test = fixture();
  for (const baseUrl of [
    'http://search.example.com',
    'https://user:private@example.com',
    'https://search.example.com?private=value',
    'https://search.example.com#private',
    'invalid-private-url',
  ]) {
    assert.throws(
      () =>
        preflightEval({
          plan: test.plan,
          composition: {
            ...test.composition,
            webSearch: { ...test.composition.webSearch!, baseUrl },
          },
        }),
      { code: 'invalid_plan', phase: 'preflight' },
    );
  }
  for (const baseUrl of [
    'https://search.example.com',
    'http://localhost:1234',
    'http://127.0.0.2:1234',
    'http://[::1]:1234',
  ])
    preflightEval({
      plan: test.plan,
      composition: {
        ...test.composition,
        webSearch: { ...test.composition.webSearch!, baseUrl },
      },
    });
  assert.deepEqual(test.resolutions, []);
  assert.equal(test.runtime.runs.length, 0);
});

it('keeps upstream authority out of runtime and workspace, and tears down after success', async () => {
  const test = fixture();
  let url = '';
  const agent = {
    ...test.agent,
    async openSession(context: Parameters<typeof test.agent.openSession>[0]) {
      const config = JSON.parse(
        Buffer.from(
          await context.runtime.workspace.readFile('.mcp.json'),
        ).toString(),
      );
      url = config.mcpServers.web_search.url;
      const env = test.runtime.runs[0]!.input.environment;
      assert.equal(
        JSON.stringify(env).includes('host-only-search-secret'),
        false,
      );
      assert.deepEqual(env.credentials.FORGE_WEB_SEARCH_TOKEN?.scopes, [
        'agent',
      ]);
      assert.ok(env.credentials.FORGE_WEB_SEARCH_TOKEN?.value);
      assert.equal(
        JSON.stringify(config).includes(
          env.credentials.FORGE_WEB_SEARCH_TOKEN.value,
        ),
        false,
      );
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.credentials.FORGE_WEB_SEARCH_TOKEN.value}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(response.status, 200);
      return test.agent.openSession(context);
    },
  };
  const completed = await executeEval({
    runId: 'search-success',
    plan: test.plan,
    composition: { ...test.composition, agents: new Map([[agent.id, agent]]) },
  });
  assert.equal(completed.result.evaluation.status, 'passed');
  assert.deepEqual(test.resolutions, ['test.search-key:web_search']);
  assert.ok(url);
  await assert.rejects(fetch(url));
  for (const artifact of test.store.runs
    .get('search-success')!
    .artifacts.values())
    assert.equal(
      Buffer.from(artifact.body).toString().includes('host-only-search-secret'),
      false,
    );
});

it('tears down on interaction failure and rejects unsupported configuration before credential lookup', async () => {
  const test = fixture();
  let url = '';
  const agent = {
    ...test.agent,
    async openSession(context: Parameters<typeof test.agent.openSession>[0]) {
      url = JSON.parse(
        Buffer.from(
          await context.runtime.workspace.readFile('.mcp.json'),
        ).toString(),
      ).mcpServers.web_search.url;
      throw new Error('Intentional failure');
    },
  };
  await assert.rejects(
    executeEval({
      runId: 'search-failure',
      plan: test.plan,
      composition: {
        ...test.composition,
        agents: new Map([[agent.id, agent]]),
      },
    }),
  );
  assert.ok(url);
  await assert.rejects(fetch(url));
  const { webSearch: _, ...withoutSearch } = test.composition;
  const count = test.resolutions.length;
  assert.throws(
    () => preflightEval({ plan: test.plan, composition: withoutSearch }),
    { code: 'invalid_plan', phase: 'preflight' },
  );
  assert.equal(test.resolutions.length, count);
});

it('closes readiness listeners even if later selected credentials fail', async () => {
  const test = fixture();
  const credentials = test.composition.credentialResolver;
  let lookups = 0;
  await assert.rejects(
    defaultForgeEngine.validateRuntime([
      {
        plan: test.plan,
        composition: {
          ...test.composition,
          credentialResolver: {
            resolve(ref, context) {
              if (++lookups === 2) throw new Error('Unavailable');
              return credentials.resolve(ref, context);
            },
          },
        },
      },
      {
        plan: test.plan,
        composition: {
          ...test.composition,
          credentialResolver: {
            async resolve() {
              throw new Error('Unavailable');
            },
          },
        },
      },
    ]),
  );
  assert.equal(test.runtime.runs.length, 0);
});

for (const responseKind of [
  'valid',
  'malformed-usage',
  'malformed-response',
] as const) {
  it(`records the search condition and nullable usage for ${responseKind} without affecting scoring`, async () => {
    const test = fixture();
    const upstream = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          responseKind === 'malformed-response'
            ? { error: { message: 'private-upstream-text' } }
            : {
                output: [
                  {
                    type: 'web_search_call',
                    action: {
                      sources: [
                        { url: 'https://example.com', title: 'Example' },
                      ],
                    },
                  },
                  { type: 'web_search_call' },
                ],
                usage:
                  responseKind === 'malformed-usage'
                    ? { input_tokens: 'invalid' }
                    : {
                        input_tokens: 10,
                        output_tokens: 4,
                        total_tokens: 14,
                        input_tokens_details: { cached_tokens: 2 },
                        output_tokens_details: { reasoning_tokens: 1 },
                      },
              },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const agent = {
      ...test.agent,
      async openSession(context: Parameters<typeof test.agent.openSession>[0]) {
        const config = JSON.parse(
          Buffer.from(
            await context.runtime.workspace.readFile('.mcp.json'),
          ).toString(),
        );
        const token =
          test.runtime.runs[0]!.input.environment.credentials
            .FORGE_WEB_SEARCH_TOKEN!.value;
        for (let i = 0; i < 2; i++) {
          const result = await fetch(config.mcpServers.web_search.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i,
              method: 'tools/call',
              params: {
                name: 'call_web_search',
                arguments: { query: 'test query' },
              },
            }),
          });
          assert.equal(result.status, 200);
          assert.equal(
            (await result.text()).includes('private-upstream-text'),
            false,
          );
        }
        return test.agent.openSession(context);
      },
    };
    try {
      const completed = await executeEval({
        runId: `usage-${responseKind}`,
        plan: test.plan,
        composition: {
          ...test.composition,
          webSearch: {
            ...test.composition.webSearch!,
            baseUrl: `http://127.0.0.1:${address.port}`,
          },
          agents: new Map([[agent.id, agent]]),
        },
      });
      assert.equal(completed.result.evaluation.status, 'passed');
      assert.deepEqual(completed.result.web_search, {
        provider: 'forge/web-search',
        native_search: 'disabled',
        usage: {
          tool_calls: 2,
          search_count: responseKind === 'malformed-response' ? null : 4,
          input_tokens: responseKind === 'valid' ? 20 : null,
          output_tokens: responseKind === 'valid' ? 8 : null,
          total_tokens: responseKind === 'valid' ? 28 : null,
          cached_input_tokens: responseKind === 'valid' ? 4 : null,
          reasoning_tokens: responseKind === 'valid' ? 2 : null,
        },
      });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
}

it('leaves results and credential lookup unchanged without the action', async () => {
  const test = fixture();
  const plan = createTestResolvedRunPlan({ agent: test.plan.agent });
  const completed = await executeEval({
    runId: 'no-search',
    plan,
    composition: {
      ...test.composition,
      webSearch: {
        ...test.composition.webSearch!,
        baseUrl: 'invalid-unused-endpoint',
      },
    },
  });
  assert.equal(completed.result.web_search, undefined);
  assert.deepEqual(test.resolutions, []);
});

it('verifies the saved condition against its plan and rejects forged result fields', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createArtifactStore, verifyCompletedRun, parseRunResult } =
    await import('../results/index.ts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-search-result-'));
  const test = fixture();
  try {
    const completed = await executeEval({
      runId: 'verified-search',
      plan: test.plan,
      composition: {
        ...test.composition,
        artifactStore: createArtifactStore({ root }),
      },
    });
    await verifyCompletedRun(completed.location);
    const condition = completed.result.web_search!;
    assert.throws(() =>
      parseRunResult({
        ...completed.result,
        web_search: { ...condition, native_search: 'enabled' },
      }),
    );
    assert.throws(() =>
      parseRunResult({
        ...completed.result,
        web_search: { ...condition, extra: true },
      }),
    );
    assert.throws(() =>
      parseRunResult({
        ...completed.result,
        web_search: {
          ...condition,
          usage: { ...condition.usage, input_tokens: -1 },
        },
      }),
    );
    const { web_search: _, ...withoutCondition } = completed.result;
    await fs.writeFile(
      path.join(completed.location, 'result.json'),
      JSON.stringify(withoutCondition),
    );
    await assert.rejects(
      verifyCompletedRun(completed.location),
      /web search condition/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('closes the per-run listener when the caller cancels interaction', async () => {
  const test = fixture();
  const controller = new AbortController();
  let url = '';
  const agent = {
    ...test.agent,
    async openSession(context: Parameters<typeof test.agent.openSession>[0]) {
      url = JSON.parse(
        Buffer.from(
          await context.runtime.workspace.readFile('.mcp.json'),
        ).toString(),
      ).mcpServers.web_search.url;
      controller.abort(new Error('Cancelled'));
      context.signal.throwIfAborted();
      return test.agent.openSession(context);
    },
  };
  await assert.rejects(
    executeEval({
      runId: 'cancelled-search',
      plan: test.plan,
      signal: controller.signal,
      composition: {
        ...test.composition,
        agents: new Map([[agent.id, agent]]),
      },
    }),
    { code: 'aborted' },
  );
  assert.ok(url);
  await assert.rejects(fetch(url));
});
