import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { assertNoCleanupWarnings, assertRuntimeCleanup } from './cleanup.mjs';
import {
  fixtureOpenCodeRuntime,
  openCodePluginFixtureSetup,
  startOpenCodeMcpFixture,
  verifyPublishedOpenCodePlugin,
} from './opencodePlugin.mjs';

export const OPENCODE_FIXTURE_MODEL = 'forge-fixture/chat-model';
export const OPENCODE_FIXTURE_CONFIG = {
  provider: {
    forge: {
      models: {
        [OPENCODE_FIXTURE_MODEL]: {
          limit: { context: 32000, output: 4000 },
          reasoning: false,
          temperature: true,
          attachment: false,
          tool_call: true,
        },
      },
    },
  },
};

/** Local-only model simulator. Never forwards requests or accepts an upstream key. */
export async function startOpenCodeFixtureEndpoint() {
  const credential = randomUUID();
  const requests = [];
  const failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${credential}`) {
        response.writeHead(401).end();
        return;
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 4 * 1024 * 1024, 'Fixture request exceeded bounds');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, OPENCODE_FIXTURE_MODEL);
      assert.ok(Array.isArray(body.messages));
      requests.push(body);
      const tools = body.tools ?? [];
      const lastUser = body.messages.findLastIndex(
        (message) => message.role === 'user',
      );
      const main = tools.length > 0;
      if (main) assert.ok(tools.some((tool) => tool.function?.name === 'bash'));
      const hasResult = body.messages
        .slice(lastUser + 1)
        .some((message) => message.role === 'tool');
      const mcpTool = tools.find((tool) =>
        tool.function?.name.endsWith('_fixture_echo'),
      )?.function.name;
      const called = new Set(
        body.messages
          .slice(lastUser + 1)
          .flatMap((message) => message.tool_calls ?? [])
          .map((tool) => tool.function.name),
      );
      const next = !main
        ? undefined
        : mcpTool
          ? ['skill', mcpTool, 'bash'].find((name) => !called.has(name))
          : hasResult
            ? undefined
            : 'bash';
      const call = next !== undefined;
      const toolCall = {
        id: `call_${requests.length}`,
        type: 'function',
        function: {
          name: next,
          arguments: JSON.stringify(
            next === 'skill'
              ? { name: 'stripe-test' }
              : next === mcpTool
                ? {}
                : {
                    command: "printf 'complete\\n' > answer.txt",
                    description: 'Create the evaluation output file',
                  },
          ),
        },
      };
      const message = call
        ? { role: 'assistant', content: null, tool_calls: [toolCall] }
        : {
            role: 'assistant',
            content: main
              ? 'Created answer.txt. Task complete.'
              : 'Fixture task',
          };
      const finish = call ? 'tool_calls' : 'stop';
      const base = {
        id: `chatcmpl_${requests.length}`,
        created: 1790000000,
        model: body.model,
      };
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = call
          ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
          : message;
        for (const item of [
          {
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: null }],
          },
          {
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
            usage,
          },
        ])
          response.write(`data: ${JSON.stringify(item)}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage,
          }),
        );
      }
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end('Fixture request failed');
    }
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    credential,
    requests,
    failures,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    agentBaseUrl: `http://host.docker.internal:${port}/v1`,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

/** Real Docker/OpenCode, deterministic Chat Completions and host Ava, no model billing. */
export async function runOpenCodeIntegrationSuite(options) {
  const modules = await Promise.all([
    import('../../dist/index.js'),
    import('../../dist/agents/opencode/index.js'),
    import('../../dist/runtime/docker/index.js'),
    import('../../dist/testing/index.js'),
  ]);
  const forge = Object.assign({}, ...modules);
  const { signal, dockerExecutable, suiteId, resultsRoot, progress } = options;
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-live-opencode-'),
  );
  let endpoint;
  let mcp;
  try {
    const platform = await forge.detectDockerRuntimePlatform({
      dockerExecutable,
      signal,
    });
    endpoint = await startOpenCodeFixtureEndpoint();
    mcp = await startOpenCodeMcpFixture();
    const dockerRuntime = forge.createDockerRuntimeAdapter({
      dockerExecutable,
      temporaryRoot: runtimeRoot,
    });
    const runtime = fixtureOpenCodeRuntime(dockerRuntime, forge, mcp);
    const agent = forge.createOpenCodeAdapter({
      baseUrl: endpoint.agentBaseUrl,
    });
    const runs = [];
    let publishedPlugin;
    for (const treatment of ['no-plugin', 'stripe-plugin']) {
      for (const mode of ['one_shot', 'multi_turn']) {
        progress(
          `checking OpenCode ${treatment} ${mode} tools, exact-session export, and cleanup`,
        );
        const runId = `${suiteId}-opencode-${treatment}-${mode}`;
        const role = forge.createScriptedCompletionProvider({
          id: 'live-harness',
          responses: [
            JSON.stringify({
              user_needs: [
                {
                  description: 'Create and verify the output',
                  acceptance:
                    'The output file exists and its contents have been checked.',
                  status: 'remaining',
                },
              ],
              message: 'Create answer.txt containing complete.',
            }),
            JSON.stringify({
              remaining_need_ids: ['need_1'],
              message: 'Check answer.txt again.',
            }),
            JSON.stringify({ remaining_need_ids: [], message: '' }),
          ],
        });
        const fixturePlan = forge.createTestResolvedRunPlan({
          mode,
          prompt: 'Create answer.txt containing complete.',
          agent: {
            adapter: 'opencode',
            provider: 'openai-compatible',
            model: OPENCODE_FIXTURE_MODEL,
          },
          runtime: {
            adapter: 'docker',
            image: { kind: 'forge' },
            platform,
            resources: {
              memory_bytes: 4 * 1024 ** 3,
              cpu_count: 2,
              process_count: 512,
            },
          },
          ...(mode === 'multi_turn'
            ? {
                maxTurns: 3,
                rolePlayer: { provider: 'live-harness', model: 'scripted' },
              }
            : {}),
          treatment,
          treatmentSetup:
            treatment === 'stripe-plugin'
              ? [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }]
              : [],
          caseSetup: [
            ...openCodePluginFixtureSetup(mcp.url),
            {
              uses: 'forge/write',
              with: {
                target: 'opencode.json',
                source: { content: JSON.stringify(OPENCODE_FIXTURE_CONFIG) },
              },
            },
          ],
          checks: {
            files_created: ['answer.txt'],
            file_checks: [
              { file: 'answer.txt', exists: true, contains: '^complete\\n$' },
            ],
          },
        });
        const plan = forge.parseResolvedRunPlan({
          ...fixturePlan,
          limits: { run_timeout_ms: options.timeoutMs },
        });
        if (publishedPlugin === undefined) {
          progress(
            'checking published Stripe bundle installation and native skill discovery',
          );
          publishedPlugin = await verifyPublishedOpenCodePlugin(
            forge,
            dockerRuntime,
            plan,
            { ...options, runtimeRoot },
          );
        }
        try {
          const completed = await forge.executeEval({
            runId,
            plan,
            signal,
            composition: {
              runtime,
              agents: new Map([[agent.id, agent]]),
              completionProviders: new Map([[role.provider.id, role.provider]]),
              credentialResolver: forge.createStaticCredentialResolver({
                'opencode.api-key': endpoint.credential,
                'env:STRIPE_API_KEY': mcp.token,
              }),
              inputProvider: forge.createMemoryRunInputProvider(),
              artifactStore: forge.createArtifactStore({ root: resultsRoot }),
            },
          });
          const verified = await forge.verifyCompletedRun(completed.location);
          assert.equal(verified.result.evaluation.status, 'passed');
          assert.equal(verified.result.evidence.completeness, 'complete');
          assert.equal(
            verified.result.evidence.provenance.source.format,
            'opencode-session-json',
          );
          const native = verified.result.supplemental_artifacts.find(
            (item) => item.path === 'native/opencode/session.json',
          );
          assert.equal(native?.sensitivity, 'restricted');
          const exported = JSON.parse(
            await fs.readFile(
              path.join(completed.location, native.path),
              'utf8',
            ),
          );
          assert.equal(
            exported.messages.filter((message) => message.info.role === 'user')
              .length,
            mode === 'one_shot' ? 1 : 2,
          );
          assert.ok(
            exported.messages.some((message) =>
              message.parts.some(
                (part) =>
                  part.type === 'tool' && part.state.status === 'completed',
              ),
            ),
          );
          assertNoCleanupWarnings(verified.result, completed.location);
          assert.deepEqual(endpoint.failures, []);
          if (treatment === 'stripe-plugin') {
            assert.ok(mcp.observed.call > 0);
            for (const artifact of [
              'plan.json',
              'setup.json',
              'trajectory.json',
              'interaction.json',
              'result.json',
            ])
              assert.ok(
                !(
                  await fs.readFile(
                    path.join(completed.location, artifact),
                    'utf8',
                  )
                ).includes(mcp.token),
              );
          }
          runs.push({
            treatment,
            mode,
            location: completed.location,
            session_id: verified.result.agent.session_id,
          });
        } finally {
          await assertRuntimeCleanup({ dockerExecutable, runtimeRoot, runId });
        }
      }
    }
    assert.ok(endpoint.requests.length >= 6);
    return {
      verified: true,
      suite_id: suiteId,
      mode: 'setup',
      agent: 'opencode',
      published_plugin: publishedPlugin,
      mcp: mcp.observed,
      requests: endpoint.requests.length,
      runs,
    };
  } finally {
    await endpoint?.close();
    await mcp?.close();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}
