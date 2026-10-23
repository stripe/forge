import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as http from 'node:http';
import {
  mergeStripeOpenCodeConfiguration,
  PLUGIN_CONFIG_PATH,
} from '../../dist/agents/opencode/pluginConfig.js';
import { assertRuntimeCleanup } from './cleanup.mjs';

const bundlePath = 'providers/agent-plugins/plugin';
const manifest = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'stripe',
  version: '1.0.0',
};

// The pinned CLI exits before large pipe writes drain. Capture to a regular file,
// then return only the bounded discovery inventory rather than full skill bodies.
const SKILL_INVENTORY = `
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const root = fs.mkdtempSync('/tmp/forge-skill-inventory-');
try {
  const file = root + '/skills.json';
  const fd = fs.openSync(file, 'w', 0o600);
  const result = spawnSync('opencode', ['debug', 'skill'], {stdio:['ignore',fd,'inherit']});
  fs.closeSync(fd);
  if (result.status !== 0) throw new Error('OpenCode skill discovery failed');
  if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('Skill inventory exceeds its limit');
  const skills = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdout.write(JSON.stringify(skills.map(({name,location}) => ({name,location}))));
} finally { fs.rmSync(root, {recursive:true,force:true}); }
`;

export async function startOpenCodeMcpFixture() {
  const token = randomUUID();
  const observed = { initialize: 0, list: 0, call: 0, rejected: 0 };
  let reject = false;
  const server = http.createServer(async (request, response) => {
    if (reject || request.headers.authorization !== `Bearer ${token}`) {
      observed.rejected++;
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(Buffer.byteLength(body) < 1024 * 1024);
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (message.method === 'initialize') {
        observed.initialize++;
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge-fixture', version: '1.0.0' },
        };
      } else if (message.method === 'tools/list') {
        observed.list++;
        result = {
          tools: [
            {
              name: 'fixture_echo',
              description: 'Read the fixture value.',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        };
      } else if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'fixture_echo');
        observed.call++;
        result = { content: [{ type: 'text', text: 'fixture MCP succeeded' }] };
      } else if (message.method === 'ping') result = {};
      else throw new Error('Unexpected MCP fixture request');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch {
      response.writeHead(500).end();
    }
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  return {
    token,
    observed,
    url: `http://host.docker.internal:${server.address().port}/mcp`,
    reject(value) {
      reject = value;
    },
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

/** Real Git fixtures, installed by production code; no public source or production endpoint overrides. */
export function openCodePluginFixtureSetup(url) {
  const files = {
    [`${bundlePath}/plugin.json`]: JSON.stringify(manifest),
    [`${bundlePath}/mcp.json`]: JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { stripe: { type: 'streamable-http', url } },
    }),
    [`${bundlePath}/skills/stripe-test/SKILL.md`]:
      '---\nname: stripe-test\ndescription: Read the Stripe fixture instructions.\n---\nUse the fixture_echo MCP tool, then write answer.txt.\n',
  };
  const script = `
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const git = (dir, args) => execFileSync('git', ['-c', 'user.name=Forge fixture', '-c', 'user.email=fixture@example.test', '-C', dir, ...args], {encoding:'utf8'}).trim();
fs.mkdirSync('source-fixture', {recursive:true});
git('source-fixture', ['init']);
for (const [file, content] of Object.entries(JSON.parse(process.argv[1]))) {
  const target = 'source-fixture/' + file;
  fs.mkdirSync(require('node:path').dirname(target), {recursive:true});
  fs.writeFileSync(target, content);
}
git('source-fixture', ['add', '.']);
git('source-fixture', ['commit', '-m', 'Fixture bundle']);
const sha = git('source-fixture', ['rev-parse', 'HEAD']);
fs.mkdirSync('catalog-fixture/.claude-plugin', {recursive:true});
fs.writeFileSync('catalog-fixture/.claude-plugin/marketplace.json', JSON.stringify({name:'claude-plugins-official',plugins:[{name:'stripe',source:{source:'git-subdir',url:'https://github.com/stripe/ai.git',path:'providers/claude/plugin',ref:'main',sha}}]}));
git('catalog-fixture', ['init']);
git('catalog-fixture', ['add', '.']);
git('catalog-fixture', ['commit', '-m', 'Fixture catalog']);
`;
  return [
    {
      uses: 'forge/command',
      with: {
        argv: ['node', '-e', script, JSON.stringify(files)],
        timeout_ms: 30_000,
      },
    },
  ];
}

/** Map only network fetches to fixture repositories; pin verification and checkout remain real Git. */
export function fixtureOpenCodeRuntime(runtime, forge, mcp) {
  return {
    ...runtime,
    async prepare(input) {
      const prepared = await runtime.prepare(input);
      if (!input.plan.setup.some((step) => step.uses === 'forge/plugin'))
        return prepared;
      return {
        ...prepared,
        commands: {
          ...prepared.commands,
          uncredentialed: {
            run(argv, options) {
              const mapped =
                argv.includes('git') && argv.includes('fetch')
                  ? argv.map((arg) =>
                      arg === 'https://github.com/stripe/ai.git'
                        ? 'file:///workspace/source-fixture'
                        : arg ===
                            'https://github.com/anthropics/claude-plugins-official.git'
                          ? 'file:///workspace/catalog-fixture'
                          : arg,
                    )
                  : argv;
              return prepared.commands.uncredentialed.run(mapped, options);
            },
          },
        },
        async finalizeSetup() {
          const state = prepared.stateDirectories.get(forge.OPENCODE_STATE_ID);
          const directory = input.requirements.stateDirectories.find(
            (entry) => entry.id === forge.OPENCODE_STATE_ID,
          ).containerPath;
          const config = mergeStripeOpenCodeConfiguration(
            Buffer.from(
              await prepared.workspace.readFile('opencode.json'),
            ).toString(),
            Buffer.from(await state.readFile(PLUGIN_CONFIG_PATH)).toString(),
            directory,
          );
          await state.writeFile('config.json', Buffer.from(config));
          const skill = await prepared.commands.agent.run(
            ['node', '-e', SKILL_INVENTORY],
            { signal: input.signal, timeoutMs: 60_000 },
          );
          assert.equal(skill.exitCode, 0, skill.stderr);
          assert.ok(
            JSON.parse(skill.stdout).some(
              (entry) => entry.name === 'stripe-test',
            ),
          );
          for (const rejected of [true, false]) {
            mcp.reject(rejected);
            const status = await prepared.commands.agent.run(
              ['opencode', 'mcp', 'list'],
              { signal: input.signal, timeoutMs: 60_000 },
            );
            const output = `${status.stdout}\n${status.stderr}`.replace(
              /\x1b\[[0-9;]*m/g,
              '',
            );
            assert.equal(status.exitCode, 0, output);
            assert.match(
              output,
              rejected ? /failed|needs authentication/ : /connected/,
            );
          }
          assert.ok(mcp.observed.rejected > 0);
          assert.ok(mcp.observed.list > 0);
          await prepared.finalizeSetup();
        },
      };
    },
  };
}

/** Public catalog/source checkout and native skill discovery, without MCP or model requests. */
export async function verifyPublishedOpenCodePlugin(
  forge,
  runtime,
  plan,
  options,
) {
  const { signal, dockerExecutable, runtimeRoot, suiteId } = options;
  const runId = `${suiteId}-opencode-published-plugin`;
  const agent = forge.createOpenCodeAdapter({
    baseUrl: 'http://unused.example/v1',
  });
  const selected = agent.requirements(plan.agent);
  const installation = agent.pluginInstaller.preflight(
    {
      plugin: 'stripe@claude-plugins-official',
      marketplace: 'anthropics/claude-plugins-official',
    },
    { selection: plan.agent, runtime: plan.runtime, mcpServers: ['stripe'] },
  );
  let prepared;
  try {
    prepared = await runtime.prepare({
      runId,
      plan,
      signal,
      requirements: {
        executables: [
          ...selected.executables,
          ...installation.requirements.executables,
        ],
        stateDirectories: selected.stateDirectories,
      },
      environment: {
        variables: selected.environment.variables,
        credentials: {},
      },
    });
    const receipt = await installation.install({
      runId,
      paths: prepared.paths,
      stateDirectories: prepared.stateDirectories,
      commands: prepared.commands.uncredentialed,
      signal,
    });
    forge.parseAgentPluginInstallationReceipt(receipt);
    const state = prepared.stateDirectories.get(forge.OPENCODE_STATE_ID);
    const configuration = JSON.parse(
      Buffer.from(await state.readFile(PLUGIN_CONFIG_PATH)).toString(),
    );
    // Discovery has no need to connect the production MCP server or resolve credentials.
    await state.writeFile(
      'config.json',
      Buffer.from(JSON.stringify({ skills: configuration.skills })),
    );
    const skills = await prepared.commands.uncredentialed.run(
      ['node', '-e', SKILL_INVENTORY],
      { signal, timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 },
    );
    assert.equal(skills.exitCode, 0, skills.stderr);
    const discovered = JSON.parse(skills.stdout);
    const inventory = await state.listFiles({
      under: 'plugins/stripe/bundle/skills',
    });
    const skillFiles = inventory.filter(
      (entry) => entry.kind === 'file' && entry.path.endsWith('/SKILL.md'),
    );
    assert.ok(skillFiles.length > 0);
    for (const file of skillFiles)
      assert.ok(
        discovered.some((entry) => entry.location?.endsWith(`/${file.path}`)),
        `Missing skill ${file.path}`,
      );
    return { receipt, skills: discovered.map(({ name }) => name) };
  } finally {
    await prepared?.dispose();
    await assertRuntimeCleanup({ dockerExecutable, runtimeRoot, runId });
  }
}
