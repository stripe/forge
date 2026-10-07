import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import {describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';
import * as os from 'node:os';

import {FORGE_VERSION} from '../src/version.js';
import {FORGE_CODEX_VERSION, FORGE_CLAUDE_CODE_VERSION} from '../src/runtime/docker/assets.js';
import * as forge from '../src/index.js';
import {parseAtifTrajectory} from '../src/atif/index.js';
import {createAnthropicCompletionProvider} from '../src/providers/anthropic/index.js';

const repositoryRoot = process.cwd();
const liveScript = path.join(repositoryRoot, 'scripts', 'live-e2e.mjs');
const liveModule = (name: string) => import(pathToFileURL(path.join(repositoryRoot, 'scripts', 'live', `${name}.mjs`)).href);
const {readLiveConfiguration} = await liveModule('configuration');
const {createFullSuite} = await liveModule('suite');
const {createRunVerifiers} = await liveModule('verification');
const {assertRuntimeCleanup} = await liveModule('cleanup');
const {startLoopbackGatewayBridge, assertDockerCanReachBridge} = await liveModule('gateway');
const {runCriterionJudgmentRegression} = await liveModule('judgment');
const verifiers = createRunVerifiers({...forge, parseAtifTrajectory, FORGE_CLAUDE_CODE_VERSION});

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

    for (const script of [liveScript, path.join(repositoryRoot, 'scripts', 'live', 'judgment.mjs'),
      path.join(repositoryRoot, 'scripts', 'live', 'setup.mjs'),
      path.join(repositoryRoot, 'scripts', 'live', 'codex.mjs')]) {
      const syntax = spawnSync(process.execPath, ['--check', script], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  });

  it('rejects missing opt-in and unsupported agents before credential lookup or traffic', async () => {
    const noCredentialLookup = new Proxy({} as Record<string, string>, {
      get(_target, name) {
        assert.equal(name, 'FORGE_LIVE');
        return undefined;
      },
    });
    assert.throws(() => configuration(noCredentialLookup), /potentially billable model calls.*Set FORGE_LIVE=1/);
    assert.throws(() => configuration({
      FORGE_LIVE: '1', FORGE_LIVE_AGENT: 'unsupported-agent',
    }), /FORGE_LIVE_AGENT must be claude-code or codex/);
  });

  it('requires only the selected agent credential before any live work', async () => {
    assert.throws(() => configuration({FORGE_LIVE: '1'}), /ANTHROPIC_API_KEY is required/);
    assert.throws(() => configuration({
      FORGE_LIVE: '1', ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
    }), /ANTHROPIC_AUTH_TOKEN is required/);
    assert.throws(() => configuration({
      FORGE_LIVE: '1', FORGE_LIVE_AGENT: 'codex', ANTHROPIC_API_KEY: 'unselected-placeholder',
    }), /CODEX_API_KEY is required/);
    const codex = configuration({
      FORGE_LIVE: '1', FORGE_LIVE_AGENT: 'codex', CODEX_API_KEY: 'synthetic-codex-key',
      OPENAI_BASE_URL: 'https://example.test/v1',
    });
    assert.equal(codex.liveAgent, 'codex');
    assert.equal(codex.codexSelected, true);
    assert.equal(codex.credentialEnvironmentName, 'CODEX_API_KEY');
    assert.equal(codex.gatewayEnvironmentName, 'OPENAI_BASE_URL');
    assert.equal(codex.gatewayBaseUrl, 'https://example.test/v1');
    const claude = configuration({FORGE_LIVE: '1', ANTHROPIC_API_KEY: 'synthetic-claude-key'});
    assert.equal(claude.liveAgent, 'claude-code');
    assert.equal(claude.codexSelected, false);
    assert.equal(claude.credentialEnvironmentName, 'ANTHROPIC_API_KEY');
  });

  it('allows setup integration without looking up any provider credentials or endpoints', async () => {
    // Reading any of these values through the normal environment validator
    // would throw. Setup mode must bypass model configuration entirely.
    const setup = configuration({
      FORGE_LIVE: '1', FORGE_LIVE_MODE: 'setup',
      ANTHROPIC_API_KEY: '\0', ANTHROPIC_AUTH_TOKEN: '\0', CODEX_API_KEY: '\0',
      ANTHROPIC_BASE_URL: '\0', OPENAI_BASE_URL: '\0',
    });
    assert.equal(setup.mode, 'setup');
    assert.equal(setup.upstreamCredential, undefined);
    assert.equal(setup.gatewayBaseUrl, undefined);
  });

  it('rejects invalid live modes and permits Codex setup without provider credentials', async () => {
    assert.throws(() => configuration({
      FORGE_LIVE: '1', FORGE_LIVE_MODE: 'unknown',
    }), /FORGE_LIVE_MODE must be full or setup/);
    assert.equal(configuration({
      FORGE_LIVE: '1', FORGE_LIVE_MODE: 'setup', FORGE_LIVE_AGENT: 'codex',
      CODEX_API_KEY: '\0', OPENAI_BASE_URL: '\0',
    }).upstreamCredential, undefined);
  });

  for (const protocol of ['responses', 'messages'] as const) {
    it(`forwards only authorized ${protocol} routes and isolates upstream credentials and headers`,
      {timeout: 10_000}, async () => {
        const calls: {url: string | undefined; headers: http.IncomingHttpHeaders; body: string}[] = [];
        const upstream = await fakeUpstream((request, response) => {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.once('end', () => {
            calls.push({url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString()});
            response.writeHead(201, {
              'content-type': 'application/json', 'x-upstream-marker': 'preserved',
              authorization: 'synthetic-response-secret', 'x-api-key': 'synthetic-response-key',
              'proxy-authenticate': 'synthetic-proxy-secret',
            });
            response.end('{"ok":true}');
          });
        });
        let bridge: GatewayBridge | undefined;
        try {
          bridge = await startLoopbackGatewayBridge({
            upstream: new URL(`${upstream.url}/${protocol === 'responses' ? 'v1/' : 'anthropic'}`),
            upstreamCredential: 'synthetic-host-only-key', protocol,
          });
          assert.ok(bridge);
          assert.notEqual(bridge.credential, 'synthetic-host-only-key');
          const prefix = new URL(bridge.agentBaseUrl).pathname;
          const routes = protocol === 'responses' ? ['/responses'] : ['/v1/messages', '/v1/messages/count_tokens'];
          for (const route of routes) {
            const result = await bridgeRequest(bridge, `${prefix}${route}?probe=1`, {
              method: 'POST', body: '{"message":"local fixture"}',
              headers: {
                authorization: `Bearer ${bridge.credential}`, 'x-api-key': 'synthetic-agent-key',
                host: 'agent-host.invalid', 'proxy-authorization': 'synthetic-agent-proxy',
                'keep-alive': 'timeout=99', 'content-type': 'application/json',
                'anthropic-beta': 'allowed-beta,thinking-token-count-2026-05-13',
              },
            });
            assert.equal(result.status, 201);
            assert.equal(result.body, '{"ok":true}');
            assert.equal(result.headers['x-upstream-marker'], 'preserved');
            for (const name of ['authorization', 'x-api-key', 'proxy-authenticate']) {
              assert.equal(result.headers[name], undefined);
            }
            const forwarded = calls.at(-1)!;
            assert.equal(forwarded.url, `${protocol === 'responses' ? '/v1' : '/anthropic'}${route}?probe=1`);
            assert.equal(forwarded.body, '{"message":"local fixture"}');
            assert.equal(forwarded.headers.host, new URL(upstream.url).host);
            assert.equal(forwarded.headers.authorization, 'Bearer synthetic-host-only-key');
            assert.equal(forwarded.headers['content-type'], 'application/json');
            assert.equal(forwarded.headers['anthropic-beta'], protocol === 'messages'
              ? 'allowed-beta' : 'allowed-beta,thinking-token-count-2026-05-13');
            for (const name of ['x-api-key', 'proxy-authorization', 'keep-alive']) {
              assert.equal(forwarded.headers[name], undefined);
            }
          }

          const allowed = `${prefix}${routes[0]}`;
          for (const denied of [
            {path: allowed, method: 'POST', authorization: undefined},
            {path: allowed, method: 'POST', authorization: 'Bearer incorrect'},
            {path: allowed, method: 'GET', authorization: `Bearer ${bridge.credential}`},
            ...['/responses', `${prefix}/v1/responses`, `${prefix}/chat/completions`, `${prefix}/models`,
              `${prefix}${protocol === 'responses' ? '/v1/messages' : '/responses'}`]
              .map((target) => ({path: target, method: 'POST', authorization: `Bearer ${bridge!.credential}`})),
          ]) {
            assert.equal((await bridgeRequest(bridge, denied.path, {
              method: denied.method,
              headers: denied.authorization === undefined ? {} : {authorization: denied.authorization},
            })).status, 403, denied.path);
          }
          assert.equal((await bridgeRequest(bridge, allowed, {
            method: 'POST', headers: {
              authorization: `Bearer ${bridge.credential}`,
              'content-length': String(32 * 1024 * 1024 + 1)
            },
          })).status, 413);
          assert.equal((await bridgeRequest(bridge, new URL(bridge.healthUrl).pathname)).status, 204);
          assert.equal(calls.length, routes.length, 'Rejected requests and health probes must never reach upstream');
        } finally {
          await bridge?.close();
          await upstream.close();
        }
      });
  }

  it('closes the listener, idle client sockets and an active upstream request', {timeout: 10_000}, async (t) => {
    let requestStarted!: (request: http.IncomingMessage) => void;
    const started = new Promise<http.IncomingMessage>((resolve) => {requestStarted = resolve;});
    const upstream = await fakeUpstream((request) => requestStarted(request));
    t.after(() => upstream.close());
    const startBridge = startLoopbackGatewayBridge;
    await assert.rejects(startBridge({upstream: new URL(upstream.url),
      upstreamCredential: 'synthetic-host-only-key', protocol: 'unknown'}), /Unsupported live gateway protocol/);
    const bridge = await startBridge({upstream: new URL(upstream.url),
      upstreamCredential: 'synthetic-host-only-key', protocol: 'responses'});
    const idle = net.connect(bridge.port, '127.0.0.1');
    try {
      await once(idle, 'connect');
      const idleClosed = once(idle, 'close');
      const pending = bridgeRequest(bridge, `${new URL(bridge.agentBaseUrl).pathname}/responses`, {
        method: 'POST', headers: {authorization: `Bearer ${bridge.credential}`}, body: '{}',
      });
      const active = await Promise.race([started, pending.then(() => {
        throw new Error('The bridge did not open an upstream request');
      })]);
      const disconnected = assert.rejects(pending, {code: 'ECONNRESET'});
      const upstreamClosed = once(active.socket, 'close');
      await bridge.close();
      await Promise.all([idleClosed, upstreamClosed, disconnected]);
      assert.equal(bridge.server.listening, false);
      await bridge.close();
      await assert.rejects(bridgeRequest(bridge, new URL(bridge.healthUrl).pathname), {code: 'ECONNREFUSED'});
    } finally {
      idle.destroy();
      await bridge.close();
    }
  });

  for (const scenario of [
    {agent: 'codex', endpoint: undefined, bridged: true},
    {agent: 'codex', endpoint: 'https://gateway.example.test/v1', bridged: true},
    {agent: 'claude-code', endpoint: 'http://127.0.0.1:12345/anthropic', bridged: true},
    {agent: 'claude-code', endpoint: 'https://gateway.example.test/anthropic', bridged: false},
    {agent: 'claude-code', endpoint: undefined, bridged: false},
  ]) {
    it(`wires scoped credentials and checks for ${scenario.agent} at ${scenario.endpoint ?? 'the default endpoint'}`, async () => {
      const codex = scenario.agent === 'codex';
      const order: string[] = [];
      let output = '';
      const signal = new AbortController().signal;
      const upstreamCredential = 'synthetic-host-only-key';
      const bridgeCredential = 'synthetic-one-run-token';
      const bridgeBaseUrl = 'http://host.docker.internal:12345/opaque-route';
      const dependencies = {
        ...forge,
        FORGE_CODEX_VERSION,
        createDockerRuntimeAdapter: () => ({id: 'fake-docker'}),
        createCodexAdapter: (options: Record<string, unknown>) => agent('codex', options),
        createClaudeCodeAdapter: (options: Record<string, unknown>) => agent('claude-code', options),
        createAnthropicCompletionProvider(options: Record<string, unknown>) {
          assert.equal(codex, false, 'Codex must not create a host completion provider');
          assert.equal(options.credential, 'live.completion-credential');
          assert.equal(options.auth, scenario.endpoint ? 'bearer' : 'api-key');
          assert.equal(options.baseUrl, scenario.endpoint);
          return {id: 'anthropic'};
        },
        createDirectoryRunInputProvider: async () => ({}), createArtifactStore: () => ({}),
      };
      const options = {
        ...configuration({
          FORGE_LIVE: '1', FORGE_LIVE_AGENT: scenario.agent,
          [codex ? 'CODEX_API_KEY' : scenario.endpoint ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: upstreamCredential,
          ...(scenario.endpoint ? {[codex ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL']: scenario.endpoint} : {}),
          FORGE_LIVE_RUN_ID: 'synthetic-suite'
        }),
        signal, runtimeRoot: '/synthetic-runtime', dockerExecutable: 'fake-docker',
        runIds: {docker: 'docker', plugin: 'plugin', oneShot: 'one-shot', multiTurn: 'multi-turn'},
        progress() {},
      };
      const suite = createFullSuite(dependencies, options, {
        async assertRuntimeCleanup(input: {runId: string}) {
          assert.ok(['plugin', 'one-shot', 'multi-turn'].includes(input.runId));
        },
        async startLoopbackGatewayBridge(input: {upstream: URL; upstreamCredential: string; protocol: string}) {
          order.push('bridge');
          assert.equal(input.upstream.href, scenario.endpoint ?? 'https://api.openai.com/v1');
          assert.equal(input.upstreamCredential, upstreamCredential);
          assert.equal(input.protocol, codex ? 'responses' : 'messages');
          return {
            credential: bridgeCredential, agentBaseUrl: bridgeBaseUrl,
            async close() {order.push('bridge-close');}
          };
        },
        async runDockerConformance() {order.push('docker'); return {platform: 'linux/amd64', image_id: 'immutable-image'};},
        async runClaudePluginConformance() {order.push('plugin'); return {verified: true};},
        async runCodexPluginIntegrationSuite() {order.push('codex-plugin'); return {verified: true};},
        async assertDockerCanReachBridge(input: {imageId: string}) {
          order.push('bridge-probe'); assert.equal(input.imageId, 'immutable-image');
        },
        async runSelection(input: {
          label: string; example: string; datasetExample?: string; agent?: string; model?: string;
          compositionFactory(input: {datasetRoot: string; resultsRoot: string}): Promise<{
            agents: Map<string, unknown>; completionProviders?: Map<string, unknown>;
            credentialResolver: {resolve(reference: string, context: {signal: AbortSignal}): Promise<string>};
          }>
        }) {
          order.push(input.label);
          assert.equal(input.example, input.label === 'multi-turn' ? 'multi-turn' : codex ? 'codex' : 'quickstart');
          if (input.label === 'one-shot') {
            assert.equal(input.datasetExample, 'quickstart');
            assert.equal(input.agent, scenario.agent);
            assert.equal(input.model, codex ? 'gpt-5.4' : 'claude-sonnet-4-6');
          }
          const composition = await input.compositionFactory({datasetRoot: '/synthetic-dataset', resultsRoot: '/synthetic-results'});
          assert.equal(composition.agents.has(scenario.agent), true);
          assert.equal(composition.completionProviders?.has('anthropic'), codex ? undefined : true);
          const reference = scenario.bridged ? 'live.ephemeral-bridge-credential' : 'live.agent-credential';
          assert.equal(await composition.credentialResolver.resolve(reference, {signal}),
            scenario.bridged ? bridgeCredential : upstreamCredential);
          if (codex) await assert.rejects(composition.credentialResolver.resolve('live.completion-credential', {signal}), /unexpected credential/);
          else assert.equal(await composition.credentialResolver.resolve('live.completion-credential', {signal}), upstreamCredential);
          await assert.rejects(composition.credentialResolver.resolve('undeclared', {signal}), /unexpected credential/);
          return {verified: true};
        },
        async verifyOneShotRun(_completed: unknown, identity?: {format: string; version: string}) {
          if (codex) {
            assert.equal(identity?.format, 'codex-rollout-jsonl');
            assert.equal(identity?.version, FORGE_CODEX_VERSION);
          } else assert.equal(identity, undefined);
          return {verified: true};
        },
        verifyMultiTurnRun: async () => ({verified: true}),
        async runCriterionJudgmentRegression(input: {
          provider: {id: string}; runId: string; signal: AbortSignal;
          credentialResolver: {resolve(reference: string, context: {signal: AbortSignal}): Promise<string>};
        }) {
          order.push('judge-escaping');
          assert.equal(codex, false, 'Codex must not invoke the host judge regression');
          assert.equal(input.provider.id, 'anthropic');
          assert.equal(input.runId, 'synthetic-suite-judge-escaping');
          assert.equal(input.signal, signal);
          assert.equal(await input.credentialResolver.resolve('live.completion-credential', {signal}), upstreamCredential);
          return {verified: true};
        },
      });
      function agent(id: string, options: Record<string, unknown>) {
        assert.equal(id, scenario.agent);
        assert.equal(options.credential, scenario.bridged ? 'live.ephemeral-bridge-credential' : 'live.agent-credential');
        assert.equal(options.credentialEnvironmentName, codex ? 'CODEX_API_KEY' : scenario.endpoint ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY');
        assert.equal(options.baseUrl, scenario.bridged ? bridgeBaseUrl : scenario.endpoint);
        return {id};
      }
      const report = await suite.run();
      output = JSON.stringify(report);
      assert.deepEqual(order, [
        ...(scenario.bridged ? ['bridge'] : []), 'docker', ...(codex ? ['codex-plugin'] : ['plugin']),
        ...(scenario.bridged ? ['bridge-probe'] : []), 'one-shot',
        ...(codex ? [] : ['multi-turn', 'judge-escaping']), ...(scenario.bridged ? ['bridge-close'] : []),
      ]);

      assert.equal(report.verified, true);
      assert.equal(report.judgment?.verified, codex ? undefined : true);
      assert.equal(report.authentication_mode, scenario.bridged ? 'loopback_gateway_bridge'
        : scenario.endpoint ? 'messages_compatible_gateway' : 'direct_anthropic');
      assert.ok(!output.includes(upstreamCredential) && !output.includes(bridgeCredential));
    });
  }

  for (const fixture of [
    {name: 'valid backticks', content: '{"results":[{"index":0,"passed":true,"explanation":"Missing `cancel_url`."}]}', error: undefined},
    {name: 'illegal backtick escapes', content: '{"results":[{"index":0,"passed":true,"explanation":"Missing \\`cancel_url\\`."}]}', error: /invalid response/},
    {name: 'whitespace explanation', content: '{"results":[{"index":0,"passed":true,"explanation":"   "}]}', error: /valid completed judgment/},
  ]) {
    it(`checks the native judge schema and local parser for ${fixture.name} without exposing the reply`, async () => {
      const signal = new AbortController().signal;
      const native = createAnthropicCompletionProvider({
        credential: 'live.completion-credential',
        async fetch(_input, init) {
          const request = JSON.parse(String(init?.body));
          assert.equal(request.output_config.format.type, 'json_schema');
          assert.equal(request.output_config.format.schema.properties.results.items.properties.explanation.pattern, undefined);
          assert.equal(request.messages[0].content.match(/\\`/g)?.length, 2);
          return new Response(JSON.stringify({
            type: 'message', role: 'assistant', stop_reason: 'end_turn',
            content: [{type: 'text', text: fixture.content}],
            usage: {input_tokens: 10, output_tokens: 10},
          }), {status: 200});
        },
      });
      const provider = {
        ...native,
        async complete(request: forge.CompletionRequest, context: forge.CompletionProviderCallContext) {
          assert.equal(request.purpose, 'judge');
          assert.equal(request.responseSchema, forge.CRITERION_JUDGMENT_RESPONSE_SCHEMA);
          assert.equal(request.signal, signal);
          return native.complete(request, context);
        },
      };
      const pending = runCriterionJudgmentRegression(forge, {
        provider, runId: 'synthetic-judge', signal,
        credentialResolver: {
          async resolve(reference: string, context: {signal: AbortSignal}) {
            assert.equal(reference, 'live.completion-credential');
            assert.equal(context.signal, signal);
            return 'synthetic-private-key';
          },
        },
      });
      if (fixture.error !== undefined) await assert.rejects(pending, fixture.error);
      else assert.deepEqual(await pending, {
        verified: true, valid_json: true, local_judgment_validation: true,
      });
    });
  }

  it('requires pinned native Codex evidence rather than accepting a fallback live result', async () => {
    const verify = verifiers.verifyNativeSession;
    const agent = {adapter: 'codex', adapter_version: FORGE_VERSION, session_id: 'exact-session', model: 'gpt-5.4'};
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

  it('uses the executed immutable image ID for the container bridge probe', async () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const signal = new AbortController().signal;
    const suite = createFullSuite({
      ...forge,
      async assertRuntimeAdapterConforms(runtime: {prepare(input: unknown): Promise<{quiesce(): Promise<unknown>}>}) {
        await (await runtime.prepare({})).quiesce();
        return {runtimeId: 'probe'};
      },
    }, {
      ...configuration({FORGE_LIVE: '1', ANTHROPIC_API_KEY: 'synthetic-key'}),
      signal, runtimeRoot: '/synthetic-runtime', progress() {}
    }, {assertRuntimeCleanup: async () => {}});
    const report = await suite.runDockerConformance({
      id: 'forge/docker', async prepare() {
        return {async quiesce() {return {metadata: {imageId}};}};
      },
    }, 'probe', signal);
    assert.equal(report.image_id, imageId);
    assert.deepEqual(report.adapter, {id: 'forge/docker'});
    const calls: string[][] = [];
    const runCommand = async (executable: string, argv: readonly string[]) => {
      assert.equal(executable, 'docker');
      calls.push([...argv]);
      return {exitCode: 0, stdout: '204'};
    };
    const input = {
      bridge: {healthUrl: 'http://bridge.test/health'}, dockerExecutable: 'docker',
      platform: report.platform, imageId: report.image_id, signal
    };
    await assertDockerCanReachBridge(input, runCommand);
    const argv = calls[0]!;
    assert.equal(argv[argv.indexOf('/usr/bin/curl') + 1], imageId);
    assert.ok(argv.includes('--pull=never'));
    await assert.rejects(assertDockerCanReachBridge({...input, imageId: 'stripe-forge-runtime:mutable'}, runCommand),
      /immutable Docker image ID/);
    assert.equal(calls.length, 1);
  });

  it('rejects cleanup warnings before verifying a one-shot or multi-turn score', async () => {
    const completed = {location: '/synthetic-result', result: {warnings: [{code: 'runtime_cleanup_failed'}]}};
    for (const verify of [verifiers.verifyOneShotRun, verifiers.verifyMultiTurnRun]) {
      await assert.rejects(verify(completed), /Runtime cleanup failed/);
    }
  });

  it('requires real resource removal instead of trusting a successful dispose call', async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-live-cleanup-test-'));
    const options = {dockerExecutable: 'docker', runtimeRoot, runId: 'cleanup-probe'};
    const commands: string[][] = [];
    const noContainers = async (_executable: string, argv: string[], signal: AbortSignal) => {
      commands.push(argv);
      assert.equal(signal.aborted, false);
      return {exitCode: 0, stdout: ''};
    };
    try {
      await assert.rejects(assertRuntimeCleanup(options, async () => ({exitCode: 0, stdout: 'stopped-container\n'})), /Container leaked/);
      await assert.rejects(assertRuntimeCleanup(options, async () => ({exitCode: 1, stdout: ''})), /Could not inspect/);
      await fs.mkdir(path.join(runtimeRoot, 'undisposed-runtime'));
      await assert.rejects(assertRuntimeCleanup(options, noContainers), /Runtime files leaked/);
      await fs.rm(path.join(runtimeRoot, 'undisposed-runtime'), {recursive: true});
      await assertRuntimeCleanup(options, noContainers);
      assert.deepEqual(commands[0], ['ps', '--all', '--filter', 'name=stripe-forge-cleanup-probe-', '--format', '{{.ID}}']);
    } finally {
      await fs.rm(runtimeRoot, {recursive: true, force: true});
    }
  });

  it('fails the real entry point before importing built code or starting live work', () => {
    for (const environment of [{}, {FORGE_LIVE: '1', FORGE_LIVE_MODE: 'invalid'}]) {
      const result = spawnSync(process.execPath, [liveScript], {cwd: repositoryRoot, env: environment, encoding: 'utf8'});
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, environment.FORGE_LIVE ? /FORGE_LIVE_MODE must be full or setup/ : /Set FORGE_LIVE=1/);
    }
  });
});

interface GatewayBridge {
  server: http.Server;
  port: number;
  credential: string;
  agentBaseUrl: string;
  healthUrl: string;
  close(): Promise<void>;
}

async function fakeUpstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

function bridgeRequest(bridge: GatewayBridge, target: string, options: {
  method?: string; headers?: http.OutgoingHttpHeaders; body?: string;
} = {}) {
  return new Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}>((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: bridge.port, path: target,
      method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({status: response.statusCode!, headers: response.headers,
        body: Buffer.concat(chunks).toString()}));
    });
    request.setTimeout(2_000, () => request.destroy(new Error('Local bridge test request timed out')));
    request.once('error', reject);
    request.end(options.body);
  });
}

function configuration(environment: Record<string, string>) {
  return readLiveConfiguration(environment, repositoryRoot) as Record<string, unknown>;
}
