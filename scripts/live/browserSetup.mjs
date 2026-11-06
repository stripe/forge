import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '../../dist/agents/claude-code/index.js';
import { createCodexAdapter } from '../../dist/agents/codex/index.js';
import {
  createArtifactStore,
  createDirectoryRunInputProvider,
  defaultForgeEngine as engine,
  expandExperiment,
} from '../../dist/index.js';
import { createDockerRuntimeAdapter } from '../../dist/runtime/docker/index.js';
import { assertNoCleanupWarnings, assertRuntimeCleanup } from './cleanup.mjs';

/** Real YAML → plan → setup → native adapter registration → sealing → verified commit. */
export async function runBrowserSetupIntegration({
  dockerExecutable,
  resultsRoot,
  suiteId,
  signal,
  progress,
  platform,
  liveAgent,
}) {
  const fixture = fileURLToPath(
    new URL('../../test/fixtures/browser/', import.meta.url),
  );
  const dataset = await engine.loadDataset(path.join(fixture, 'dataset'));
  const loadedExperiment = await engine.loadExperimentConfig(
    path.join(fixture, 'experiment.yaml'),
  );
  const codex = liveAgent === 'codex';
  const selection = {
    adapter: liveAgent,
    provider: codex ? 'openai' : 'anthropic',
    model: 'setup-probe',
  };
  const experiment = {
    ...loadedExperiment,
    config: engine.parseExperimentConfig({
      ...loadedExperiment.config,
      matrix: { ...loadedExperiment.config.matrix, agents: [selection] },
    }),
  };
  const plan = engine.resolveRunPlan({
    dataset,
    experiment,
    selection: expandExperiment(experiment, dataset)[0],
    runtimePlatform: platform,
  });
  const native = codex ? createCodexAdapter() : createClaudeCodeAdapter();
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-browser-setup-'),
  );
  const runId = `${suiteId}-setup-browser`;
  const probe = await fs.readFile(
    new URL('./browserProbe.mjs', import.meta.url),
  );
  const agent = {
    ...native,
    requirements(selection) {
      const requirements = native.requirements(selection);
      return {
        ...requirements,
        environment: { variables: requirements.environment.variables ?? {} },
      };
    },
    async openSession(context) {
      await context.runtime.workspace.writeFile(
        'index.html',
        Buffer.from(
          `<!doctype html><html lang="en"><head><title>Greeting</title></head><body><h1>Greeting</h1><label>Name <input></label><button onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('input').value">Greet</button><p id="result"></p></body></html>`,
        ),
      );
      await context.runtime.workspace.writeFile('browser-probe.mjs', probe);
      // Exercise the native adapter's config/argv path, replacing only its model invocation.
      return native.openSession({
        ...context,
        runtime: {
          ...context.runtime,
          commands: {
            agent: {
              async run(argv, options) {
                if (codex) {
                  assert.equal(argv[0], 'codex');
                  assert.equal(argv[1], 'exec');
                  const listed = await context.runtime.commands.agent.run(
                    ['codex', 'mcp', 'get', 'forge-browser'],
                    options,
                  );
                  assert.equal(listed.exitCode, 0);
                  assert.match(
                    listed.stdout,
                    /127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp/,
                  );
                } else {
                  assert.equal(argv[0], 'claude');
                  const index = argv.indexOf('--mcp-config');
                  assert.ok(index >= 0);
                  assert.equal(
                    argv[index + 1],
                    '/home/forge/.forge-browser/mcp.json',
                  );
                  const state =
                    context.runtime.stateDirectories.get('forge-browser');
                  const document = JSON.parse(
                    Buffer.from(await state.readFile('mcp.json')).toString(),
                  );
                  const endpoint = document.mcpServers['forge-browser'].url;
                  assert.match(
                    endpoint,
                    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/,
                  );
                  // `mcp list` excludes invocation-only --mcp-config connections.
                  // Independently exercise native registration support, then remove it.
                  const added = await context.runtime.commands.agent.run(
                    [
                      'claude',
                      'mcp',
                      'add',
                      '--scope',
                      'user',
                      '--transport',
                      'http',
                      'forge-browser',
                      endpoint,
                    ],
                    options,
                  );
                  assert.equal(added.exitCode, 0, added.stderr);
                  const listed = await context.runtime.commands.agent.run(
                    ['claude', 'mcp', 'get', 'forge-browser'],
                    options,
                  );
                  assert.equal(listed.exitCode, 0, listed.stderr);
                  assert.match(
                    listed.stdout,
                    /127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp/,
                  );
                  const removed = await context.runtime.commands.agent.run(
                    [
                      'claude',
                      'mcp',
                      'remove',
                      '--scope',
                      'user',
                      'forge-browser',
                    ],
                    options,
                  );
                  assert.equal(removed.exitCode, 0, removed.stderr);
                }
                const probed = await context.runtime.commands.agent.run(
                  ['node', '/workspace/browser-probe.mjs'],
                  options,
                );
                assert.equal(probed.exitCode, 0, probed.stderr);
                const sessionId = codex
                  ? '11111111-1111-4111-8111-111111111111'
                  : argv[argv.indexOf('--session-id') + 1];
                const stdout = codex
                  ? [
                      { type: 'thread.started', thread_id: sessionId },
                      { type: 'turn.started' },
                      {
                        type: 'item.completed',
                        item: {
                          id: 'message',
                          type: 'agent_message',
                          text: 'Browser verified.',
                        },
                      },
                      {
                        type: 'turn.completed',
                        usage: {
                          input_tokens: 0,
                          output_tokens: 0,
                          cached_input_tokens: 0,
                        },
                      },
                    ]
                      .map((value) => JSON.stringify(value))
                      .join('\n')
                  : JSON.stringify({
                      type: 'result',
                      result: 'Browser verified.',
                      session_id: sessionId,
                    });
                return { exitCode: 0, stdout, stderr: '', durationMs: 0 };
              },
            },
          },
        },
      });
    },
    collectNativeArtifact: undefined,
    async collectEvidence() {
      return {
        kind: 'unavailable',
        reason: {
          code: 'source_unavailable',
          message: 'Model-free browser setup probe.',
        },
      };
    },
  };
  try {
    progress(
      `checking forge/browser through ${liveAgent} setup and committed artifacts`,
    );
    const completed = await engine.executeEval({
      runId,
      plan,
      signal,
      composition: {
        credentialResolver: {
          async resolve() {
            throw new Error(
              'Browser setup probe must not request credentials.',
            );
          },
        },
        runtime: createDockerRuntimeAdapter({
          dockerExecutable,
          temporaryRoot: runtimeRoot,
        }),
        agents: new Map([[liveAgent, agent]]),
        inputProvider: await createDirectoryRunInputProvider(dataset.root),
        artifactStore: createArtifactStore({ root: resultsRoot }),
      },
    });
    const verified = await engine.verifyCompletedRun(completed.location);
    assert.equal(verified.result.evaluation.status, 'passed');
    assert.equal(verified.result.completion_calls.length, 0);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(completed.location, 'browser/manifest.json'),
        'utf8',
      ),
    );
    assert.equal(manifest.run_id, runId);
    assert.equal(manifest.session_id, verified.result.agent.session_id);
    assert.equal(manifest.captures.length, 1);
    assert.equal(manifest.omitted_captures, 0);
    assertNoCleanupWarnings(verified.result, completed.location);
    return {
      verified: true,
      model_calls: 0,
      run_id: runId,
      location: completed.location,
      captures: manifest.captures.length,
    };
  } finally {
    await assertRuntimeCleanup({ dockerExecutable, runtimeRoot, runId });
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}
