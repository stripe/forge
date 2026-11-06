import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const endpoint = 'http://127.0.0.1:8931/mcp';
const runId = process.argv[2];
assert.match(runId ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
const signal = AbortSignal.timeout(90_000);
const records = [];
let sequence = 0;

async function connect() {
  let session;
  let id = 0;
  async function request(method, params, notification = false) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id: ++id }),
        method,
        params,
      }),
      signal,
    });
    assert.ok(response.ok, `MCP ${method}: HTTP ${response.status}`);
    session = response.headers.get('mcp-session-id') ?? session;
    if (notification) return;
    const text = await response.text();
    const message = response.headers
      .get('content-type')
      ?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
          .find((item) => item.id === id)
      : JSON.parse(text);
    assert.ok(message && !message.error, `MCP ${method} failed`);
    if (method === 'tools/call') {
      assert.ok(
        !message.result.isError,
        `Tool ${params.name} failed: ${JSON.stringify(message.result.content)}`,
      );
      records.push({
        sequence: ++sequence,
        connection: session ?? 'stateless',
        name: params.name,
        arguments: params.arguments,
        result: message.result,
      });
    }
    return message.result;
  }
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'forge-devbox-browser-probe', version: '1' },
  });
  await request('notifications/initialized', {}, true);
  return {
    request,
    async close() {
      if (!session) return;
      const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: { 'mcp-session-id': session },
        signal,
      });
      assert.ok(
        response.ok || response.status === 405,
        'MCP disconnect failed',
      );
    },
  };
}

function tool(client, name, args) {
  return client.request('tools/call', { name, arguments: args });
}
function text(result) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// This probes the native registries without model credentials or model calls.
const environment = {
  PATH: process.env.PATH,
  HOME: '/home/forge',
  CODEX_HOME: '/home/forge/.codex',
  DISABLE_TELEMETRY: '1',
};
const run = (command, args) =>
  execFileSync(command, args, {
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
run('claude', [
  'mcp',
  'add',
  '--scope',
  'user',
  '--transport',
  'http',
  'playwright',
  endpoint,
]);
assert.match(run('claude', ['mcp', 'get', 'playwright']), /127\.0\.0\.1:8931/);
await mkdir(environment.CODEX_HOME, { recursive: true, mode: 0o700 });
run('codex', ['mcp', 'add', 'playwright', '--url', endpoint]);
assert.match(run('codex', ['mcp', 'get', 'playwright']), /127\.0\.0\.1:8931/);
const registrations = { claude_code: true, codex: true };
const pins = {
  playwright_mcp: JSON.parse(
    await readFile(
      '/opt/browser/node_modules/@playwright/mcp/package.json',
      'utf8',
    ),
  ).version,
  playwright: JSON.parse(
    await readFile('/opt/browser/node_modules/playwright/package.json', 'utf8'),
  ).version,
  claude_code: run('claude', ['--version']).trim().split(' ')[0],
  codex: run('codex', ['--version'])
    .trim()
    .replace(/^codex-cli /, ''),
};

const first = await connect();
const tools = await first.request('tools/list', {});
for (const name of [
  'browser_navigate',
  'browser_evaluate',
  'browser_take_screenshot',
])
  assert.ok(
    tools.tools.some((item) => item.name === name),
    `Missing ${name}`,
  );
const navigation = await tool(first, 'browser_navigate', {
  url: 'http://127.0.0.1:3030',
});
assert.match(text(navigation), /Forge browser fixture/);
await tool(first, 'browser_evaluate', {
  function:
    "() => { document.querySelector('input').value = 'Forge'; document.querySelector('button').click(); }",
});
await first.close();
const second = await connect();
const persisted = await tool(second, 'browser_evaluate', {
  function: "() => document.querySelector('#result').textContent",
});
assert.match(text(persisted), /Hello, Forge/);
await tool(second, 'browser_take_screenshot', {
  type: 'png',
  filename: '/evidence/screenshot.png',
});
await second.close();
const image = await readFile('/evidence/screenshot.png');
assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.ok(image.length < 4 * 1024 * 1024, 'Screenshot exceeds the PoC budget');
const actions = Buffer.from(
  `${JSON.stringify({ run_id: runId, app_url: 'http://127.0.0.1:3030', viewport: { width: 1280, height: 720 }, actions: records }, null, 2)}\n`,
);
assert.ok(
  actions.length < 2 * 1024 * 1024,
  'Action records exceed the PoC budget',
);
await writeFile('/evidence/actions.json', actions, { mode: 0o600 });
await writeFile(
  '/evidence/probe.json',
  `${JSON.stringify(
    {
      run_id: runId,
      model_calls: 0,
      registrations,
      pins,
      reconnect_state_preserved: true,
      artifacts: [
        {
          path: 'screenshot.png',
          media_type: 'image/png',
          size_bytes: image.length,
          sha256: `sha256:${createHash('sha256').update(image).digest('hex')}`,
        },
        {
          path: 'actions.json',
          media_type: 'application/json',
          size_bytes: actions.length,
          sha256: `sha256:${createHash('sha256').update(actions).digest('hex')}`,
        },
      ],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  'Browser tools, reconnect persistence, native registrations, and screenshot verified.\n',
);
