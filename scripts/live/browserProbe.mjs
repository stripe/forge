import assert from 'node:assert/strict';

// Executes inside the real eval container. The scripted interaction makes no model calls.
const endpoint = 'http://127.0.0.1:8931/mcp';
const signal = AbortSignal.timeout(60_000);
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
    const body = await response.text();
    const message = response.headers
      .get('content-type')
      ?.includes('text/event-stream')
      ? body
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
          .find((item) => item.id === id)
      : JSON.parse(body);
    assert.ok(
      message && !message.error && !message.result.isError,
      `MCP ${method} failed`,
    );
    return message.result;
  }
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'forge-setup-probe', version: '1' },
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
      assert.ok(response.ok || response.status === 405);
    },
  };
}
const first = await connect();
const tools = await first.request('tools/list', {});
for (const name of [
  'browser_navigate',
  'browser_evaluate',
  'browser_take_screenshot',
]) {
  assert.ok(tools.tools.some((tool) => tool.name === name));
}
await first.request('tools/call', {
  name: 'browser_navigate',
  arguments: { url: 'http://127.0.0.1:3030' },
});
await first.request('tools/call', {
  name: 'browser_evaluate',
  arguments: {
    function:
      "() => { document.querySelector('input').value = 'Forge'; document.querySelector('button').click(); }",
  },
});
await first.close();
const second = await connect();
const result = await second.request('tools/call', {
  name: 'browser_evaluate',
  arguments: {
    function: "() => document.querySelector('#result').textContent",
  },
});
assert.match(JSON.stringify(result), /Hello, Forge/);
await second.request('tools/call', {
  name: 'browser_take_screenshot',
  arguments: {
    type: 'png',
  },
});
await second.close();
process.stdout.write(
  'Browser interaction and reconnect persistence verified.\n',
);
