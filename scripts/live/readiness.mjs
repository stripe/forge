import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify } from 'yaml';
import { createDefaultCliComposition, runCli } from '../../dist/cli.js';
import { assertRuntimeCleanup } from './cleanup.mjs';

const fixtureToken = 'forge-synthetic-mcp-token';

/** Standard CLI orchestration and pinned native clients; local MCP, no models. */
export async function runReadinessIntegrationSuite({
  liveAgent,
  dockerExecutable,
  signal,
  progress,
}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-live-readiness-'),
  );
  const runtimeRoot = path.join(root, 'runtime');
  await fs.mkdir(runtimeRoot);
  const reports = [];
  const mocks = [];
  const distribution = {
    plugin: 'stripe@claude-plugins-official',
    marketplace: 'anthropics/claude-plugins-official',
  };
  try {
    for (const scenario of [
      'connected',
      'unauthorized',
      'discovery-failed',
      'absent',
    ]) {
      progress(`checking ${liveAgent} native MCP readiness: ${scenario}`);
      const setup = readinessFixtureSetup(scenario);
      const caseBody = stringify({
        id: 'readiness/fixture',
        version: '0.1.0',
        initial_prompt: 'Unused: readiness makes no model calls.',
        execution_mode: 'one_shot',
        setup,
        judging_criteria: [],
      });
      const datasetRoot = path.join(root, scenario, 'dataset');
      await fs.mkdir(path.join(datasetRoot, 'cases'), { recursive: true });
      await fs.writeFile(
        path.join(datasetRoot, 'cases/fixture.case.yaml'),
        caseBody,
      );
      const manifest = JSON.stringify({
        dataset: { id: 'forge-live-readiness', version: '1.0.0' },
        cases: [
          {
            id: 'readiness/fixture',
            version: '0.1.0',
            path: 'cases/fixture.case.yaml',
          },
        ],
      });
      await fs.writeFile(path.join(datasetRoot, 'manifest.json'), manifest);
      const experimentPath = path.join(root, scenario, 'experiment.yaml');
      await fs.writeFile(
        experimentPath,
        stringify({
          id: 'testing/readiness',
          version: '1.0.0',
          dataset: {
            id: 'forge-live-readiness',
            version: '1.0.0',
            path: './dataset',
          },
          runtime: {
            adapter: 'docker',
            image: { kind: 'forge' },
            platform: 'native',
          },
          models: {},
          treatments: {
            plugin: {
              setup: [
                {
                  uses: 'forge/plugin',
                  with: { plugin: 'stripe' },
                },
              ],
            },
          },
          matrix: {
            cases: ['cases/fixture.case.yaml'],
            treatments: ['plugin'],
            agents: [
              {
                adapter: liveAgent,
                provider: liveAgent === 'codex' ? 'openai' : 'anthropic',
                model: 'unused',
              },
            ],
            repetitions: 1,
            retries: 0,
          },
          limits: { run_timeout_ms: 180000 },
        }),
      );
      let output = '';
      let errors = '';
      const runIds = [];
      const mock = await startReadinessMcpFixture(scenario);
      mocks.push(mock);
      const observed = mock.observed;
      const code = await runCli(
        [
          'validate',
          '--experiment',
          experimentPath,
          '--host',
          '--agent',
          liveAgent,
        ],
        {
          signal,
          environment: {
            STRIPE_API_KEY: fixtureToken,
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) =>
                  name.startsWith('FORGE_DOCKER_') ||
                  ['FORGE_HTTP_PROXY', 'FORGE_HTTPS_PROXY'].includes(name),
              ),
            ),
            FORGE_NO_PROXY: 'localhost,127.0.0.1',
          },
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            errors += text;
          },
          async compositionFactory(options) {
            const composition = await createDefaultCliComposition(options);
            const { createDockerRuntimeAdapter } = await import(
              '../../dist/runtime/docker/index.js'
            );
            const docker = createDockerRuntimeAdapter({
              dockerExecutable,
              temporaryRoot: runtimeRoot,
              mcpRelayFetch: (url, init) => {
                assert.equal(url, 'https://mcp.stripe.com/');
                return fetch(mock.url, init);
              },
            });
            return {
              ...composition,
              runtime: {
                ...docker,
                async prepare(input) {
                  runIds.push(input.runId);
                  const runtime = await docker.prepare(input);
                  return {
                    ...runtime,
                    commands: {
                      ...runtime.commands,
                      uncredentialed: {
                        async run(argv, options) {
                          // Exercise the supported public plugin selection while native Git
                          // clones a run-owned fixture catalog with a local MCP server.
                          const mapped = argv.includes('plugin')
                            ? [
                                'env',
                                'GIT_CONFIG_COUNT=2',
                                'GIT_CONFIG_KEY_0=url.file:///workspace/catalog.insteadOf',
                                `GIT_CONFIG_VALUE_0=https://github.com/${distribution.marketplace}.git`,
                                'GIT_CONFIG_KEY_1=url.file:///workspace/catalog.insteadOf',
                                `GIT_CONFIG_VALUE_1=https://github.com/${distribution.marketplace}`,
                                ...argv,
                              ]
                            : argv;
                          const result =
                            await runtime.commands.uncredentialed.run(
                              mapped,
                              options,
                            );
                          if (argv.includes('plugin') && result.exitCode !== 0)
                            throw new Error(
                              `Native fixture install failed: ${result.stderr}`,
                            );
                          return result;
                        },
                      },
                    },
                  };
                },
              },
            };
          },
        },
      );
      try {
        assert.equal(code, scenario === 'connected' ? 0 : 1, errors);
        assert.ok(
          !output.includes(fixtureToken) && !errors.includes(fixtureToken),
        );
        if (scenario === 'connected') {
          const report = JSON.parse(output);
          assert.equal(report.host.checks[0].mcp_authentication, 'verified');
          assert.equal(report.host.checks[0].model_authentication, 'untested');
          assert.ok(
            observed.some(
              (row) => row.method === 'initialize' && row.auth === true,
            ),
          );
          assert.ok(
            observed.some(
              (row) => row.method === 'tools/list' && row.auth === true,
            ),
          );
        } else assert.match(errors, scenario === 'absent' ? /setup/ : /mcp/);
        assert.ok(!(observed ?? []).some((row) => row.method === 'tools/call'));
        reports.push({ scenario, verified: true });
      } finally {
        for (const runId of runIds)
          await assertRuntimeCleanup({ dockerExecutable, runtimeRoot, runId });
      }
    }
    return { verified: true, model_calls: 0, agent: liveAgent, cases: reports };
  } finally {
    await Promise.all(mocks.map((mock) => mock.close()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function readinessFixtureSetup(scenario) {
  const write = (target, content) => ({
    uses: 'forge/write',
    with: { target, source: { content } },
  });
  const command = (argv) => ({
    uses: 'forge/command',
    with: { argv, timeout_ms: 30000 },
  });
  return [
    write(
      'catalog/.claude-plugin/marketplace.json',
      JSON.stringify({
        name: 'claude-plugins-official',
        owner: { name: 'Forge fixture' },
        plugins: [{ name: 'stripe', source: './plugin' }],
      }),
    ),
    write(
      'catalog/plugin/.claude-plugin/plugin.json',
      JSON.stringify({ name: 'stripe', version: '1.0.0' }),
    ),
    write(
      'catalog/plugin/.mcp.json',
      JSON.stringify({
        mcpServers: {
          [scenario === 'absent' ? 'other' : 'stripe']: {
            type: 'http',
            url: 'https://mcp.stripe.com/',
          },
        },
      }),
    ),
    command(['git', 'init', '-b', 'main', '/workspace/catalog']),
    command(['git', '-C', '/workspace/catalog', 'add', '.']),
    command([
      'git',
      '-C',
      '/workspace/catalog',
      '-c',
      'user.name=Forge fixture',
      '-c',
      'user.email=forge@example.test',
      'commit',
      '-m',
      'fixture',
    ]),
  ];
}

/** Host mock sees the upstream key; native clients see only the run relay token. */
export async function startReadinessMcpFixture(scenario) {
  const observed = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
    }
    const message = JSON.parse(body);
    const auth = request.headers.authorization === `Bearer ${fixtureToken}`;
    observed.push({ method: message.method, auth });
    if (!auth || scenario === 'unauthorized') {
      response.writeHead(401).end();
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/list' && scenario === 'discovery-failed') {
      response.writeHead(500).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'ping',
                  description: 'Fixture tool; never invoked.',
                  inputSchema: { type: 'object' },
                },
              ],
            }
          : message.method === 'resources/list'
            ? { resources: [] }
            : { resourceTemplates: [] };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    observed,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
