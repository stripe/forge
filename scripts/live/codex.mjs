import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertNoCleanupWarnings, assertRuntimeCleanup } from './cleanup.mjs';

const PLUGIN = 'fixture@forge-fixture';
const MARKETPLACE = 'forge-fixture/plugins';
const write = (target, content) => ({
  uses: 'forge/write',
  with: { target, source: { content } },
});
const command = (argv) => ({
  uses: 'forge/command',
  with: { argv, timeout_ms: 30_000 },
});

/** Keep the synthetic native plugin outside the public plugin registry. */
export async function createCodexPluginFixture(forge) {
  const bundle = forge.defineSetupActionBundle({
    manifest: {
      namespace: 'forge-live',
      version: '1.0.0',
      sha256: forge.sha256Digest(await fs.readFile(new URL(import.meta.url))),
    },
    actions: [
      {
        uses: 'forge-live/plugin',
        parseWith(input) {
          assert.deepEqual(input, {});
          return {};
        },
        preflight(_step, context) {
          assert.ok(context.pluginInstaller);
          const prepared = context.pluginInstaller.preflight(
            { plugin: PLUGIN, marketplace: MARKETPLACE },
            { selection: context.selection, runtime: context.runtime },
          );
          return {
            requirements: prepared.requirements,
            async apply(context) {
              return forge.parseAgentPluginInstallationReceipt(
                await prepared.install({
                  runId: context.runId,
                  paths: context.paths,
                  stateDirectories: context.stateDirectories,
                  commands: context.commands,
                  signal: context.signal,
                }),
              );
            },
          };
        },
      },
    ],
  });
  const engine = forge.createForgeEngine({ setupActionBundles: [bundle] });
  return {
    engine,
    withPlugin(base) {
      const step = { uses: 'forge-live/plugin', with: {} };
      return engine.parseResolvedRunPlan({
        ...base,
        treatment: {
          ...base.treatment,
          setup: [...base.treatment.setup, step],
        },
        setup: [...base.setup, step],
        provenance: {
          ...base.provenance,
          forge: {
            ...base.provenance.forge,
            action_bundles: [bundle.manifest],
          },
        },
      });
    },
  };
}

/** Real pinned CLI, setup, hooks, MCP, resume and evidence; no upstream model calls. */
export async function runCodexPluginIntegrationSuite({
  dockerExecutable,
  resultsRoot,
  suiteId,
  signal,
  progress,
}) {
  const forge = Object.assign(
    {},
    ...(await Promise.all([
      import('../../dist/index.js'),
      import('../../dist/agents/codex/index.js'),
      import('../../dist/runtime/docker/index.js'),
      import('../../dist/testing/index.js'),
    ])),
  );
  const fixture = await createCodexPluginFixture(forge);
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-live-codex-'),
  );
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  await fs.mkdir(runtimeRoot);
  try {
    const platform = await forge.detectDockerRuntimePlatform({
      dockerExecutable,
      signal,
    });
    const nativeRuntime = forge.createDockerRuntimeAdapter({
      dockerExecutable,
      temporaryRoot: runtimeRoot,
    });
    // Map fixture HTTPS identities to a run-owned repository. Native Codex
    // still clones it and records the original origin and catalog snapshot.
    const runtime = {
      ...nativeRuntime,
      async prepare(input) {
        const prepared = await nativeRuntime.prepare(input);
        const commands = {
          ...prepared.commands,
          uncredentialed: {
            run(argv, options) {
              const fixtureGit = argv.includes('plugin');
              return prepared.commands.uncredentialed.run(
                fixtureGit
                  ? [
                      'env',
                      'GIT_CONFIG_COUNT=2',
                      'GIT_CONFIG_KEY_0=url.file:///workspace/catalog.insteadOf',
                      'GIT_CONFIG_VALUE_0=https://github.com/forge-fixture/plugins.git',
                      'GIT_CONFIG_KEY_1=url.file:///workspace/catalog.insteadOf',
                      'GIT_CONFIG_VALUE_1=https://github.com/forge-fixture/plugin.git',
                      ...argv,
                    ]
                  : argv,
                options,
              );
            },
          },
        };
        return { ...prepared, commands };
      },
    };
    const reports = [];
    for (const scenario of [
      { id: 'baseline', trust: 'native', plugin: false },
      { id: 'native', trust: 'native', plugin: true },
      { id: 'automation', trust: 'automation', plugin: true, multi: true },
      { id: 'git-subdir', trust: 'automation', plugin: true, git: true },
      {
        id: 'disabled-resume',
        trust: 'automation',
        plugin: true,
        multi: true,
        disable: true,
      },
    ]) {
      const runId = `${suiteId}-codex-${scenario.id}`;
      progress(
        `checking native Codex ${scenario.id}: skills, MCP, hooks and evidence`,
      );
      const nativeAgent = forge.createCodexAdapter({
        baseUrl: 'http://127.0.0.1:38471/v1',
      });
      let sends = 0;
      const agent = {
        ...nativeAgent,
        async openSession(context) {
          const session = await nativeAgent.openSession(context);
          return {
            ...session,
            async send(message, options) {
              const home = context.runtime.stateDirectories.get(
                forge.CODEX_HOME_STATE_ID,
              );
              const config =
                (await home.inspect('config.toml')).kind === 'absent'
                  ? ''
                  : Buffer.from(await home.readFile('config.toml')).toString();
              if (scenario.disable && sends === 1) {
                await home.writeFile(
                  'config.toml',
                  Buffer.from(
                    config.replace('enabled = true', 'enabled = false') +
                      hostileProvider,
                  ),
                );
              } else {
                await home.writeFile(
                  'config.toml',
                  Buffer.from(config + hostileProvider),
                );
              }
              sends += 1;
              return session.send(message, options);
            },
          };
        },
      };
      const rolePlayer = forge.createScriptedCompletionProvider({
        id: 'scripted-role',
        responses: [
          JSON.stringify({
            user_needs: [
              { description: 'Complete two turns', status: 'remaining' },
            ],
            message: 'Run the fixture once.',
          }),
          JSON.stringify({
            remaining_need_ids: ['need_1'],
            message: 'Continue the same fixture.',
          }),
          JSON.stringify({ remaining_need_ids: [], message: '' }),
        ],
      });
      const composition = {
        runtime,
        agents: new Map([[agent.id, agent]]),
        completionProviders: new Map([
          [rolePlayer.provider.id, rolePlayer.provider],
        ]),
        credentialResolver: {
          async resolve(reference) {
            assert.equal(reference, 'openai.api-key');
            return 'synthetic-codex-fixture-key';
          },
        },
        inputProvider: forge.createMemoryRunInputProvider(),
        artifactStore: forge.createArtifactStore({ root: resultsRoot }),
      };
      const basePlan = fixture.engine.parseResolvedRunPlan({
        ...forge.createTestResolvedRunPlan({
          caseId: `live/codex-${scenario.id}`,
          agent: {
            adapter: 'codex',
            provider: 'openai',
            model: 'gpt-5.4',
            hook_trust: scenario.trust,
          },
          mode: scenario.multi ? 'multi_turn' : 'one_shot',
          prompt: 'Exercise the Codex plugin fixture.',
          maxTurns: 3,
          ...(scenario.multi
            ? { rolePlayer: { provider: 'scripted-role', model: 'fixture' } }
            : {}),
          caseSetup: fixtureSetup(scenario),
          treatment: scenario.plugin ? 'plugin' : 'baseline',
          checks: {
            file_checks: [
              { file: 'requests.json', exists: true },
              {
                file: 'mcp-marker.txt',
                exists: scenario.plugin,
                ...(scenario.plugin
                  ? {
                      contains:
                        scenario.multi && !scenario.disable
                          ? '^called\\ncalled\\n$'
                          : '^called\\n$',
                    }
                  : {}),
              },
              {
                file: 'plugin-hook.txt',
                exists: scenario.plugin && scenario.trust === 'automation',
                ...(scenario.trust === 'automation'
                  ? {
                      contains:
                        scenario.multi && !scenario.disable
                          ? '^ran\\nran\\n$'
                          : '^ran\\n$',
                    }
                  : {}),
              },
              {
                file: 'workspace-hook.txt',
                exists: scenario.trust === 'automation',
                ...(scenario.trust === 'automation'
                  ? {
                      contains: scenario.multi ? '^ran\\nran\\n$' : '^ran\\n$',
                    }
                  : {}),
              },
            ],
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
        }),
        limits: { run_timeout_ms: 5 * 60_000 },
      });
      const plan = scenario.plugin ? fixture.withPlugin(basePlan) : basePlan;
      try {
        const completed = await fixture.engine.executeEval({
          runId,
          plan,
          composition,
          signal,
        });
        const verified = await fixture.engine.verifyCompletedRun(
          completed.location,
        );
        assert.equal(
          verified.result.evaluation.status,
          'passed',
          JSON.stringify(verified.result.evaluation.checks),
        );
        assert.equal(verified.result.evidence.completeness, 'complete');
        assertNoCleanupWarnings(verified.result, completed.location);
        const interaction = JSON.parse(
          await fs.readFile(
            path.join(completed.location, 'interaction.json'),
            'utf8',
          ),
        );
        assert.equal(interaction.turns.length, scenario.multi ? 2 : 1);
        const trajectory = JSON.parse(
          await fs.readFile(
            path.join(completed.location, 'trajectory.json'),
            'utf8',
          ),
        );
        const native = await fs.readFile(
          path.join(completed.location, 'native/codex/session.jsonl'),
          'utf8',
        );
        if (scenario.plugin) {
          assert.ok(
            trajectory.steps.some((step) =>
              step.tool_calls?.some((call) =>
                call.function_name.includes('ping'),
              ),
            ),
          );
          assert.match(native, /fixture-skill/);
        }
        if (scenario.trust === 'automation')
          assert.match(native, /FORGE_WORKSPACE_HOOK_CONTEXT/);
        if (scenario.plugin && scenario.trust === 'automation')
          assert.match(native, /FORGE_PLUGIN_HOOK_CONTEXT/);
        const setup = forge.parseSetupArtifact(
          JSON.parse(
            await fs.readFile(
              path.join(completed.location, 'setup.json'),
              'utf8',
            ),
          ),
          { forgeVersion: completed.result.forge.version },
        );
        if (scenario.plugin) {
          const receipt = setup.steps.at(-1).resolution;
          assert.equal(receipt.native_plugin_id, PLUGIN);
          assert.equal(
            receipt.source.kind,
            scenario.git ? 'git-subdir' : 'marketplace-path',
          );
          assert.match(receipt.marketplace_commit, /^[a-f0-9]{40}$/);
        }
        reports.push({
          id: scenario.id,
          verified: true,
          run_id: runId,
          location: completed.location,
        });
      } finally {
        await assertRuntimeCleanup({ dockerExecutable, runtimeRoot, runId });
      }
    }
    return { verified: true, provider_calls: 0, platform, cases: reports };
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

export function fixtureSetup(scenario) {
  const catalog = {
    name: 'forge-fixture',
    plugins: [
      {
        name: 'fixture',
        source: scenario.git
          ? {
              source: 'git-subdir',
              url: 'https://github.com/forge-fixture/plugin.git',
              path: 'plugins/fixture',
              ref: 'main',
            }
          : { source: 'local', path: './plugins/fixture' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  };
  const pluginRoot = 'catalog/plugins/fixture';
  return [
    // Establish the native project boundary for hooks on exact-session resume.
    command(['git', 'init', '-b', 'main', '/workspace']),
    write('catalog/.agents/plugins/marketplace.json', JSON.stringify(catalog)),
    write(
      `${pluginRoot}/.codex-plugin/plugin.json`,
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        skills: './skills/',
        hooks: './hooks/hooks.json',
        mcpServers: './.mcp.json',
      }),
    ),
    write(
      `${pluginRoot}/skills/fixture-skill/SKILL.md`,
      '---\nname: fixture-skill\ndescription: Exercise the fixture ping tool.\n---\nCall the fixture ping MCP tool.\n',
    ),
    write(
      `${pluginRoot}/hooks/hooks.json`,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: The agent expands PLUGIN_ROOT when running the hook.
                  command: 'node "${PLUGIN_ROOT}/hooks/session.mjs"',
                },
              ],
            },
          ],
        },
      }),
    ),
    write(`${pluginRoot}/hooks/session.mjs`, hookScript('plugin')),
    write(
      `${pluginRoot}/.mcp.json`,
      JSON.stringify({
        mcpServers: {
          fixture: { command: 'node', args: ['mcp/server.mjs'], cwd: '.' },
        },
      }),
    ),
    write(`${pluginRoot}/mcp/server.mjs`, mcpScript),
    write(
      '.codex/hooks.json',
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node /workspace/workspace-hook.mjs',
                },
              ],
            },
          ],
        },
      }),
    ),
    write('workspace-hook.mjs', hookScript('workspace')),
    // Native Codex ignores project-local providers. This warning is captured
    // by the stream parser; Forge also removes user-level provider settings.
    write(
      '.codex/config.toml',
      '[model_providers.forge]\nhttp_headers={"X-Wrong"="synthetic-wrong"}\nquery_params={wrong="true"}\n',
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
      'fixture: add plugin',
    ]),
    write('mock-responses.mjs', mockScript),
    command([
      'node',
      '-e',
      `require('node:child_process').spawn(process.execPath, ['mock-responses.mjs'], {detached: true, stdio: 'ignore'}).unref()`,
    ]),
    command([
      'node',
      '-e',
      `
      (async () => {for (let i=0;i<100;i++) {
        try {if ((await fetch('http://127.0.0.1:38471/health')).ok) return;} catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      } throw new Error('Fixture Responses server unavailable');})().catch(() => process.exit(1));
    `,
    ]),
  ];
}

function hookScript(kind) {
  return `import fs from 'node:fs';
fs.appendFileSync('${kind}-hook.txt', 'ran\\n');
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'FORGE_${kind.toUpperCase()}_HOOK_CONTEXT'}}));\n`;
}

const mcpScript = `import fs from 'node:fs';
import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const request=JSON.parse(line);
  if (request.id===undefined) continue;
  let result={};
  if (request.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'forge-fixture',version:'1'}};
  if (request.method==='tools/list') result={tools:[{name:'ping',description:'Return the Forge fixture marker.',inputSchema:{type:'object',properties:{}}}]};
  if (request.method==='tools/call') {
    fs.appendFileSync('/workspace/mcp-marker.txt','called\\n');
    result={content:[{type:'text',text:'FORGE_MCP_CONTEXT'}],isError:false};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}\n`;

const hostileProvider =
  '\n[model_providers.forge]\nbase_url="http://127.0.0.1:9/v1"\nenv_key="WRONG_KEY"\nexperimental_bearer_token="synthetic-wrong"\nhttp_headers={"X-Wrong"="synthetic-wrong"}\nenv_http_headers={"X-Wrong-Env"="CODEX_API_KEY"}\nquery_params={wrong="true"}\n';

const mockScript = `import fs from 'node:fs';
import http from 'node:http';
const requests=[];
let calls=0;
http.createServer(async (request,response) => {
  if (request.url==='/health') {response.end('ok');return;}
  const chunks=[];
  for await (const chunk of request) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if (request.url!=='/v1/responses' || request.headers['x-wrong'] || request.headers.authorization!=='Bearer '+['synthetic','codex','fixture','key'].join('-')) {
    response.writeHead(400);response.end('Invalid fixture provider configuration');return;
  }
  requests.push({body,path:request.url});fs.writeFileSync('requests.json',JSON.stringify(requests));
  const number=++calls;
  const tools=[];
  const visit=(value,namespace) => {if (!value||typeof value!=='object') return;
    if (value.type==='namespace') namespace=value.name;
    if (value.type==='function' && typeof value.name==='string') tools.push({name:value.name,namespace});
    for (const child of Object.values(value)) if (typeof child==='object') visit(child,namespace);
  };visit(body.tools);if(body.input?.at(-1)?.type==='tool_search_output') visit(body.input.at(-1).tools);
  const ping=tools.find(tool => tool.name.includes('ping') && (tool.name.includes('mcp') || tool.namespace?.includes('mcp')));
  const last=body.input?.at(-1);
  const toolDone=last?.type==='function_call_output';
  const search=!ping && !toolDone && last?.type!=='tool_search_output' && JSON.stringify(body.input).includes('fixture-skill') && body.tools?.some(tool => tool.type==='tool_search');
  const item=ping && !toolDone
    ? {type:'function_call',id:'fc_'+number,call_id:'call_'+number,...ping,arguments:'{}',status:'completed'}
    : search ? {type:'tool_search_call',id:'search_'+number,call_id:'search_call_'+number,status:'completed',execution:'client',arguments:{query:'fixture ping',limit:1}}
    : {type:'message',id:'msg_'+number,role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture complete.',annotations:[]}]};
  const result={id:'resp_'+number,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',output:[item],
    usage:{input_tokens:10,input_tokens_details:{cached_tokens:0},output_tokens:5,output_tokens_details:{reasoning_tokens:0},total_tokens:15}};
  const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress'}},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:result}];
  response.writeHead(200,{'content-type':'text/event-stream'});
  for (const event of events) response.write('event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n');
  response.end();
}).listen(38471,'127.0.0.1');\n`;
