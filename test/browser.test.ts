import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/agents/claude-code/index.ts';
import { createCodexAdapter } from '../src/agents/codex/index.ts';
import { defaultForgeEngine as engine } from '../src/engine.ts';
import {
  collectBrowserArtifacts,
  MAX_BROWSER_CAPTURE_BYTES,
} from '../src/evidence/browser.ts';
import { sha256Digest } from '../src/model/hashes.ts';
import {
  parseExperimentConfig,
  parseResolvedRunPlan,
  parseSetupStep,
} from '../src/model/parse.ts';
import { expandExperiment } from '../src/planning/planner.ts';
import { createArtifactStore } from '../src/results/localStore.ts';
import { serializeCanonicalJson } from '../src/serialization.ts';
import {
  BROWSER_MCP_URL,
  BROWSER_STATE_ID,
} from '../src/setup/forgeBrowser.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createMemoryWorkspace,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../src/testing/index.ts';

const browser = {
  access: { agent: true, role_player: false },
  integration: { provider: 'local', controller: 'playwright-mcp' },
} as const;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

async function inputs() {
  const experiment = await engine.loadExperimentConfig(
    'test/fixtures/browser/experiment.yaml',
  );
  const dataset = await engine.loadDataset('test/fixtures/browser/dataset');
  const selection = expandExperiment(experiment, dataset)[0]!;
  const plan = engine.resolveRunPlan({
    dataset,
    experiment,
    selection,
    runtimePlatform: 'linux/amd64',
  });
  return { experiment, dataset, selection, plan };
}

describe('browser setup in a normal Forge run', () => {
  it('defaults authored grants off and rejects unknown fields and unsupported roles/integrations', async () => {
    const { experiment } = await inputs();
    assert.deepEqual(
      parseExperimentConfig({
        ...experiment.config,
        browser: { integration: browser.integration },
      }).browser?.access,
      { agent: false, role_player: false },
    );
    for (const config of [
      { ...browser, profile: 'default' },
      { ...browser, access: { agent: true, role_player: true } },
      {
        ...browser,
        integration: { provider: 'browserbase', controller: 'playwright-mcp' },
      },
      { ...browser, integration: { ...browser.integration, options: {} } },
    ])
      assert.throws(() =>
        parseExperimentConfig({ ...experiment.config, browser: config }),
      );
    assert.throws(() =>
      parseSetupStep({
        uses: 'forge/browser',
        with: { participants: ['agent'] },
      }),
    );
  });

  it('requires a grant, rejects duplicate requests, and clones and freezes the resolved configuration', async () => {
    const input = await inputs();
    assert.ok(Object.isFrozen(input.plan.browser?.access));
    assert.notEqual(input.plan.browser, input.experiment.config.browser);
    for (const config of [
      undefined,
      { ...browser, access: { agent: false, role_player: false } },
    ]) {
      assert.throws(
        () =>
          engine.resolveRunPlan({
            ...input,
            experiment: {
              ...input.experiment,
              config: engine.parseExperimentConfig({
                ...input.experiment.config,
                browser: config,
              }),
            },
            runtimePlatform: 'linux/amd64',
          }),
        /explicit browser.access.agent grant/,
      );
    }
    const duplicate = structuredClone(input.plan);
    duplicate.case.setup.push({ uses: 'forge/browser', with: {} });
    duplicate.setup = [...duplicate.case.setup];
    assert.throws(() => parseResolvedRunPlan(duplicate), /exactly one browser/);
    const noGrant = structuredClone(input.plan);
    delete noGrant.browser;
    assert.throws(() => parseResolvedRunPlan(noGrant), /exactly one browser/);
  });

  it('omits unused browser configuration from a selection with no setup request', async () => {
    const input = await inputs();
    const cases = new Map(
      [...input.dataset.cases].map(([id, loaded]) => [
        id,
        {
          ...loaded,
          definition: {
            ...loaded.definition,
            setup: loaded.definition.setup.filter(
              (step) => step.uses !== 'forge/browser',
            ),
          },
        },
      ]),
    );
    const plan = engine.resolveRunPlan({
      ...input,
      dataset: { ...input.dataset, cases },
      runtimePlatform: 'linux/amd64',
    });
    assert.equal(plan.browser, undefined);
    assert.equal(Object.hasOwn(plan, 'browser'), false);
  });

  it('fails unsupported agents in pure preflight before allocation or credential lookup', async () => {
    const { plan } = await inputs();
    const agent = createScriptedAgentAdapter({ id: plan.agent.adapter });
    let allocation = false;
    let credentialLookup = false;
    await assert.rejects(
      engine.executeEval({
        runId: 'unsupported-browser',
        plan,
        composition: {
          runtime: {
            ...createFakeRuntimeAdapter().adapter,
            async prepare() {
              allocation = true;
              throw new Error('allocated');
            },
          },
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: {
            async resolve() {
              credentialLookup = true;
              return 'secret';
            },
          },
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root: '/unused-browser-store' }),
        },
      }),
      /preflight/,
    );
    assert.equal(allocation, false);
    assert.equal(credentialLookup, false);
  });

  it('runs ordered setup, seals screenshots, commits them, and verifies exact session identity', async (context) => {
    const { plan } = await inputs();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-browser-test-'),
    );
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const runtime = createFakeRuntimeAdapter({
      stateFiles: { [BROWSER_STATE_ID]: { 'captures/screenshot.png': png } },
    });
    const scripted = createScriptedAgentAdapter({
      id: plan.agent.adapter,
      turns: [{ text: 'done', sessionId: 'browser-session', toolCalls: [] }],
    });
    const agent = { ...scripted.adapter, supportsBrowserMcp: true as const };
    const completed = await engine.executeEval({
      runId: 'browser-test',
      plan,
      composition: {
        credentialResolver: createStaticCredentialResolver(),
        runtime: runtime.adapter,
        agents: new Map([[agent.id, agent]]),
        inputProvider: createMemoryRunInputProvider({
          'fixtures/server.cjs': 'fixture',
        }),
        artifactStore: createArtifactStore({ root }),
      },
    });
    await engine.verifyCompletedRun(completed.location);
    const run = runtime.runs[0]!;
    assert.equal(run.commands.at(-1)?.argv[0], 'forge-browser');
    assert.equal(run.commands.at(-1)?.scope, 'uncredentialed');
    assert.ok(run.events.indexOf('quiesce') < run.events.indexOf('dispose'));
    assert.deepEqual(scripted.messages, [plan.interaction.effective_prompt]);
    const manifestPath = path.join(completed.location, 'browser/manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(manifest.session_id, 'browser-session');
    assert.equal(manifest.captures[0].sha256, sha256Digest(png));
    const resultPath = path.join(completed.location, 'result.json');
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    assert.ok(
      result.supplemental_artifacts
        .filter((item: { path: string }) => item.path.startsWith('browser/'))
        .every(
          (item: { sensitivity: string }) => item.sensitivity === 'restricted',
        ),
    );
    assert.equal(
      (await fs.stat(path.join(completed.location, 'browser/capture-000.png')))
        .mode & 0o777,
      0o600,
    );
    // Even with consistent byte hashes, a different session must not verify.
    manifest.session_id = 'other-session';
    const bytes = Buffer.from(serializeCanonicalJson(manifest));
    await fs.writeFile(manifestPath, bytes);
    const descriptor = result.supplemental_artifacts.find(
      (item: { path: string }) => item.path === 'browser/manifest.json',
    );
    descriptor.sha256 = sha256Digest(bytes);
    descriptor.size_bytes = bytes.length;
    await fs.writeFile(resultPath, serializeCanonicalJson(result));
    await assert.rejects(
      engine.verifyCompletedRun(completed.location),
      /Browser manifest does not match/,
    );
  });

  it('bounds retained screenshots and records omitted oversized captures', async () => {
    const { plan } = await inputs();
    const state = createMemoryWorkspace({
      'captures/large.png': Buffer.alloc(MAX_BROWSER_CAPTURE_BYTES + 1),
      'captures/ok.png': png,
    });
    const artifacts = await collectBrowserArtifacts({
      plan,
      runId: 'bounded',
      sessionId: 'session',
      signal: new AbortController().signal,
      runtime: {
        runtimeId: 'bounded',
        workspace: state.readonly,
        stateDirectories: new Map([[BROWSER_STATE_ID, state.readonly]]),
        paths: { workspace: '/workspace', home: '/home/forge' },
        metadata: {},
      },
    });
    const manifest = JSON.parse(Buffer.from(artifacts.at(-1)!.body).toString());
    assert.equal(manifest.omitted_captures, 1);
    assert.equal(manifest.captures.length, 1);
  });

  for (const adapter of [createClaudeCodeAdapter(), createCodexAdapter()]) {
    it(`registers browser MCP for ${adapter.id} on every turn without altering the prompt`, async () => {
      const { plan } = await inputs();
      const selection = {
        adapter: adapter.id,
        provider: adapter.id === 'codex' ? 'openai' : 'anthropic',
        model: 'test',
      };
      const states = new Map(
        adapter
          .requirements(selection)
          .stateDirectories.map((item) => [
            item.id,
            createMemoryWorkspace().mutable,
          ]),
      );
      const workspace = createMemoryWorkspace();
      const argvCalls: string[][] = [];
      const session = await adapter.openSession({
        runId: 'registration',
        plan: { ...plan, agent: selection },
        selection,
        inputs: createMemoryRunInputProvider(),
        signal: new AbortController().signal,
        runtime: {
          runtimeId: 'registration',
          workspace: workspace.mutable,
          paths: { workspace: '/workspace', home: '/home/forge' },
          stateDirectories: states,
          commands: {
            agent: {
              async run(argv) {
                argvCalls.push([...argv]);
                return {
                  exitCode: 0,
                  stderr: '',
                  durationMs: 0,
                  stdout:
                    adapter.id === 'codex'
                      ? [
                          {
                            type: 'thread.started',
                            thread_id: '11111111-1111-4111-8111-111111111111',
                          },
                          { type: 'turn.started' },
                          {
                            type: 'item.completed',
                            item: {
                              id: 'message',
                              type: 'agent_message',
                              text: 'done',
                            },
                          },
                          {
                            type: 'turn.completed',
                            usage: {
                              input_tokens: 1,
                              output_tokens: 1,
                              cached_input_tokens: 0,
                            },
                          },
                        ]
                          .map((x) => JSON.stringify(x))
                          .join('\n')
                      : JSON.stringify({
                          type: 'result',
                          result: 'done',
                          session_id: 'browser-session',
                        }),
                };
              },
            },
          },
        },
      });
      await session.send('original task', {
        signal: new AbortController().signal,
      });
      await session.send('continue', { signal: new AbortController().signal });
      if (adapter.id === 'claude-code') {
        for (const argv of argvCalls)
          assert.equal(
            argv[argv.indexOf('--mcp-config') + 1],
            '/home/forge/.forge-browser/mcp.json',
          );
        assert.equal(argvCalls[0]![2], 'original task');
      } else {
        const home = states.get('codex-home')!;
        assert.match(
          Buffer.from(await home.readFile('config.toml')).toString(),
          /\[mcp_servers.forge-browser\]/,
        );
        assert.match(
          Buffer.from(await home.readFile('config.toml')).toString(),
          new RegExp(BROWSER_MCP_URL.replace(/\./g, '\\.')),
        );
        assert.equal(argvCalls[0]!.at(-1), 'original task');
      }
    });
  }
});
