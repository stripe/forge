import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, it} from 'node:test';
import {runInNewContext} from 'node:vm';

import {FORGE_CODEX_VERSION} from '../src/runtime/docker/assets.js';

const repositoryRoot = process.cwd();
const liveScript = path.join(repositoryRoot, 'scripts', 'live-e2e.mjs');

describe('unified live end-to-end suite', () => {
  it('is the only live package command and has valid JavaScript syntax', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as {scripts?: Record<string, string>};
    const scripts = packageJson.scripts ?? {};

    assert.deepEqual(
      Object.keys(scripts).filter((name) => name.startsWith('test:live')),
      ['test:live'],
    );
    assert.equal(
      scripts['test:live'],
      'pnpm build && node scripts/live-e2e.mjs',
    );

    const syntax = spawnSync(process.execPath, ['--check', liveScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  });

  it('keeps live traffic explicitly opt-in', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    assert.match(source, /process\.env\.FORGE_LIVE !== '1'/);
    assert.match(source, /potentially billable model calls/);
    assert.doesNotMatch(source, /litellm\.corp\.stripe|certproxy/);
  });

  it('rejects missing opt-in and unsupported agents before credential lookup or traffic', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    assert.throws(() => liveConfiguration(source, {}), /Set FORGE_LIVE=1/);
    assert.throws(() => liveConfiguration(source, {
      FORGE_LIVE: '1', FORGE_LIVE_AGENT: 'unsupported-agent',
    }), /FORGE_LIVE_AGENT must be claude-code or codex/);
    assert.ok(source.indexOf('const upstreamCredential =') < source.indexOf('let bridge;'));
    assert.ok(source.indexOf('let bridge;') < source.indexOf('await startLoopbackGatewayBridge('));
  });

  it('requires only the selected agent credential before any live work', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    assert.throws(() => liveConfiguration(source, {FORGE_LIVE: '1'}), /ANTHROPIC_API_KEY is required/);
    assert.throws(() => liveConfiguration(source, {
      FORGE_LIVE: '1', ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
    }), /ANTHROPIC_AUTH_TOKEN is required/);
    assert.throws(() => liveConfiguration(source, {
      FORGE_LIVE: '1', FORGE_LIVE_AGENT: 'codex', ANTHROPIC_API_KEY: 'unselected-placeholder',
    }), /CODEX_API_KEY is required/);
    const codex = liveConfiguration(source, {
      FORGE_LIVE: '1', FORGE_LIVE_AGENT: 'codex', CODEX_API_KEY: 'synthetic-codex-key',
      OPENAI_BASE_URL: 'https://example.test/v1',
    });
    assert.equal(codex.liveAgent, 'codex');
    assert.equal(codex.codexSelected, true);
    assert.equal(codex.credentialEnvironmentName, 'CODEX_API_KEY');
    assert.equal(codex.gatewayEnvironmentName, 'OPENAI_BASE_URL');
    assert.equal(codex.gatewayBaseUrl, 'https://example.test/v1');
    const claude = liveConfiguration(source, {FORGE_LIVE: '1', ANTHROPIC_API_KEY: 'synthetic-claude-key'});
    assert.equal(claude.liveAgent, 'claude-code');
    assert.equal(claude.codexSelected, false);
    assert.equal(claude.credentialEnvironmentName, 'ANTHROPIC_API_KEY');
  });

  it('keeps protocol-specific bridge routes narrow and never duplicates the Responses API prefix', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    const helpers = runInNewContext(`${section(source,
      'function gatewayBridgePaths(', 'async function startLoopbackGatewayBridge(')}
      ({gatewayBridgePaths, gatewayBridgeUpstreamPath})`, {}) as {
        gatewayBridgePaths(prefix: string, protocol: string): Set<string>;
        gatewayBridgeUpstreamPath(upstream: URL, target: URL, prefix: string): string;
      };
    const prefix = 'opaque-test-route';
    const responses = helpers.gatewayBridgePaths(prefix, 'responses');
    assert.deepEqual([...responses], [`/${prefix}/responses`]);
    for (const denied of ['/responses', `/${prefix}/v1/responses`, `/${prefix}/v1/messages`,
      `/${prefix}/chat/completions`, `/${prefix}/models`]) {
      assert.equal(responses.has(denied), false);
    }
    assert.deepEqual([...helpers.gatewayBridgePaths(prefix, 'messages')], [
      `/${prefix}/v1/messages`, `/${prefix}/v1/messages/count_tokens`,
    ]);
    assert.throws(() => helpers.gatewayBridgePaths(prefix, 'unknown'), /Unsupported live gateway protocol/);
    assert.equal(helpers.gatewayBridgeUpstreamPath(
      new URL('https://example.test/v1/'), new URL(`http://bridge.test/${prefix}/responses`), prefix,
    ), '/v1/responses');
    assert.equal(helpers.gatewayBridgeUpstreamPath(
      new URL('https://example.test/anthropic'), new URL(`http://bridge.test/${prefix}/v1/messages`), prefix,
    ), '/anthropic/v1/messages');
    assert.match(source, /request\.method !== 'POST'/);
    assert.match(source, /!allowedPaths\.has\(parsedTarget\.pathname\)/);
    assert.match(source, /!authorizedBridgeRequest\(/);
    assert.match(source, /headers\.authorization = `Bearer \$\{upstreamCredential\}`/);
    assert.match(source, /if \(protocol === 'messages'\) filterAnthropicBetaHeader\(headers\)/);
  });

  it('always bridges Codex credentials and limits that mode to the pinned one-shot example', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    assert.match(source, /codexSelected \|\| isLoopbackHostname\(gatewayUrl\.hostname\)/);
    assert.match(source, /const agentCredential = bridge\?\.credential \?\? upstreamCredential/);
    assert.match(source, /codexSelected \? \[\] : \[\[completionCredentialReference, upstreamCredential\]\]/);
    assert.match(source, /const completionProvider = codexSelected \? undefined/);
    assert.match(source, /if \(!codexSelected\) \{\s+progress\('checking latest Claude plugin/);
    assert.match(source, /if \(!codexSelected\) \{\s+progress\('running the multi-turn/);
    assert.match(source, /example: codexSelected \? 'codex' : 'quickstart'/);
    assert.match(source, /datasetExample: 'quickstart'/);
    assert.match(source, /const CODEX_MODEL = 'gpt-5\.4'/);
    assert.match(source, /format: 'codex-rollout-jsonl', version: FORGE_CODEX_VERSION/);
    assert.match(source, /return verifyCompletedRun\(summary\.location\)/);
  });

  it('requires pinned native Codex evidence rather than accepting a fallback live result', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    const verify = runInNewContext(`${section(source,
      'function verifyNativeSession(', 'function verifyTrajectoryTurns(')}
      verifyNativeSession`, {
      requireCondition(condition: boolean, message: string) {
        if (!condition) throw new Error(message);
      },
    }) as (result: unknown, trajectory: unknown, minimum: number, location: string,
      identity: {format: string; version: string}) => void;
    const agent = {adapter: 'codex', adapter_version: '1+responses-compatible', session_id: 'exact-session', model: 'gpt-5.4'};
    const result = {agent, evidence: {completeness: 'complete', provenance: {
      source: {kind: 'native_log', format: 'codex-rollout-jsonl', session_id: agent.session_id},
      adapter: {id: agent.adapter, version: agent.adapter_version},
    }}};
    const trajectory = {session_id: agent.session_id, agent: {
      name: 'codex', version: FORGE_CODEX_VERSION, model_name: agent.model,
    }, steps: [{source: 'user'}, {source: 'agent'}]};
    const identity = {format: 'codex-rollout-jsonl', version: FORGE_CODEX_VERSION};
    verify(result, trajectory, 1, '/synthetic-result', identity);
    assert.throws(() => verify({...result, evidence: {...result.evidence, completeness: 'fallback'}},
      trajectory, 1, '/synthetic-result', identity), /exact native agent session evidence/);
    assert.throws(() => verify(result, {...trajectory, agent: {...trajectory.agent, version: '0.0.0'}},
      1, '/synthetic-result', identity), /exact native agent session evidence/);
  });

  it('uses the conformance image ID for the bridge probe instead of reconstructing a tag', async () => {
    const source = await fs.readFile(liveScript, 'utf8');
    const imageId = `sha256:${'a'.repeat(64)}`;
    const signal = new AbortController().signal;
    const runConformance = runInNewContext(`${section(source,
      'async function runDockerConformance(', 'async function runSelection(')}
      runDockerConformance`, {
      path,
      Buffer,
      repositoryRoot,
      loadDataset: async () => ({}),
      loadExperimentConfig: async () => ({}),
      expandExperiment: () => [{}],
      resolveRunPlan: () => ({runtime: {platform: 'linux/amd64'}}),
      async assertRuntimeAdapterConforms(adapter: {
        prepare(): Promise<{quiesce(): Promise<unknown>}>;
      }) {
        const prepared = await adapter.prepare();
        await prepared.quiesce();
        return {runtimeId: 'probe'};
      },
    }) as (runtime: unknown, runId: string, signal: AbortSignal) => Promise<{
      image_id: string; platform: string;
    }>;
    const report = await runConformance({
      id: 'forge/docker',
      async prepare() {
        return {async quiesce() {return {metadata: {imageId}};}};
      },
    }, 'probe', signal);
    assert.equal(report.image_id, imageId);

    const calls: string[][] = [];
    const probeBridge = runInNewContext(`${section(source,
      'async function assertDockerCanReachBridge(', 'function runBoundedCommand(')}
      assertDockerCanReachBridge`, {
      AbortSignal,
      async runBoundedCommand(executable: string, argv: readonly string[]) {
        assert.equal(executable, 'docker');
        calls.push([...argv]);
        return {exitCode: 0, stdout: '204'};
      },
    }) as (input: Record<string, unknown>) => Promise<void>;
    const input = {
      bridge: {healthUrl: 'http://bridge.test/health'},
      dockerExecutable: 'docker',
      platform: report.platform,
      imageId: report.image_id,
      signal,
    };
    await probeBridge(input);
    const argv = calls[0]!;
    assert.equal(argv[argv.indexOf('/usr/bin/curl') + 1], imageId);
    assert.ok(argv.includes('--pull=never'));
    await assert.rejects(probeBridge({...input, imageId: 'stripe-forge-runtime:mutable'}),
      /immutable Docker image ID/);
    assert.equal(calls.length, 1);
  });
});

/** Evaluate only the production configuration prefix; no imports, sockets, or Docker exist in this context. */
function liveConfiguration(source: string, environment: Record<string, string>) {
  const configuration = section(source, "if (process.env.FORGE_LIVE !== '1')", 'const timeoutMs =');
  const environmentHelpers = section(source, 'function requiredEnvironment(', 'function positiveIntegerEnvironment(');
  return runInNewContext(`${configuration}\n${environmentHelpers}\n({
    liveAgent, codexSelected, credentialEnvironmentName, gatewayEnvironmentName, gatewayBaseUrl,
  })`, {process: {env: environment}}) as Record<string, unknown>;
}

function section(source: string, from: string, until: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start, `Missing live-script section: ${from}`);
  return source.slice(start, end);
}
