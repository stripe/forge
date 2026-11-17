import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
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
      let observed;
      const code = await runCli(
        [
          'validate',
          '--experiment',
          experimentPath,
          '--host',
          '--agent',
          liveAgent,
          '--credential-env',
          'STRIPE_API_KEY',
        ],
        {
          signal,
          environment: { STRIPE_API_KEY: fixtureToken },
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
                    async dispose() {
                      if (scenario !== 'absent') {
                        try {
                          observed = JSON.parse(
                            Buffer.from(
                              await runtime.workspace.readFile(
                                'mcp-observed.json',
                              ),
                            ).toString(),
                          );
                        } catch {}
                      }
                      await runtime.dispose();
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
    write('mock-mcp.cjs', mockMcpScript(scenario)),
    command([
      'node',
      '-e',
      `require('node:child_process').spawn(process.execPath, ['mock-mcp.cjs'], {detached: true, stdio: 'ignore'}).unref()`,
    ]),
    command([
      'node',
      '-e',
      `const fs=require('node:fs'); (async()=>{for(let i=0;i<100;i++){if(fs.existsSync('mcp-ready'))return;await new Promise(r=>setTimeout(r,50));}throw new Error('mock MCP did not start');})().catch(()=>process.exit(1));`,
    ]),
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

function mockMcpScript(scenario) {
  return `const fs=require('node:fs'); const http=require('node:http'); const observations=[];
const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';for await(const chunk of req)body+=chunk;const message=JSON.parse(body);
  const auth=req.headers.authorization==='Bearer ${fixtureToken}';
  observations.push({method:message.method,auth});fs.writeFileSync('mcp-observed.json',JSON.stringify(observations));
  if(!auth || ${JSON.stringify(scenario)}==='unauthorized'){res.writeHead(401).end();return;}
  if(message.id===undefined){res.writeHead(202).end();return;}
  if(message.method==='tools/list' && ${JSON.stringify(scenario)}==='discovery-failed'){res.writeHead(500).end();return;}
  const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:message.method==='tools/list'?{tools:[{name:'ping',description:'Fixture tool; never invoked.',inputSchema:{type:'object'}}]}:message.method==='resources/list'?{resources:[]}:{resourceTemplates:[]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
});server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('catalog/plugin/.mcp.json',JSON.stringify({mcpServers:{[${JSON.stringify(scenario)}==='absent'?'other':'stripe']:{type:'http',url:'http://127.0.0.1:'+server.address().port+'/mcp'}}}));fs.writeFileSync('mcp-ready','ready');});`;
}
