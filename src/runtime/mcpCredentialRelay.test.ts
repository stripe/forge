import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, it } from 'vitest';
import { startMcpCredentialRelay } from './mcpCredentialRelay.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void = (
    _request,
    response,
  ) => response.end('ok'),
  options: Partial<Parameters<typeof startMcpCredentialRelay>[0]> = {},
) {
  const calls: {
    url: string | undefined;
    headers: IncomingMessage['headers'];
    body: string;
  }[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    handle(request, response);
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      }),
  );
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const relay = await startMcpCredentialRelay({
    upstreamUrl: `http://127.0.0.1:${address.port}/fixed`,
    credential: 'synthetic-host-key',
    listenHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    signal: controller.signal,
    ...options,
  });
  cleanup.push(relay.close);
  const headers = {
    Authorization: `Bearer ${relay.connection.token}`,
    'Content-Type': 'application/json',
  };
  return { relay, calls, controller, headers };
}

describe('host MCP credential relay', () => {
  it('injects the host key, forwards only MCP headers, and streams the fixed upstream', async () => {
    const test = await fixture((_request, response) => {
      response.setHeader('mcp-session-id', 'synthetic-session');
      response.setHeader('set-cookie', 'discard-me');
      response.setHeader('content-type', 'text/event-stream');
      response.write('data: first\n\n');
      response.end('data: last\n\n');
    });
    const response = await fetch(test.relay.connection.url, {
      method: 'POST',
      headers: {
        ...test.headers,
        'mcp-protocol-version': '2025-03-26',
        'x-target-url': 'https://example.com',
      },
      body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), 'synthetic-session');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), 'data: first\n\ndata: last\n\n');
    assert.equal(test.calls.length, 1);
    assert.equal(test.calls[0]?.url, '/fixed');
    assert.equal(
      test.calls[0]?.headers.authorization,
      'Bearer synthetic-host-key',
    );
    assert.equal(test.calls[0]?.headers['x-target-url'], undefined);
    assert.equal(test.calls[0]?.headers['mcp-protocol-version'], '2025-03-26');
    assert.equal(
      test.calls[0]?.body,
      '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    );
    assert.deepEqual(test.relay.counts(), { requests: 1, errors: 0 });
    assert.ok(!JSON.stringify(test.relay).includes('synthetic-host-key'));
  });

  it('rejects absent, incorrect and other-run capabilities before contacting upstream', async () => {
    const first = await fixture();
    const second = await fixture();
    assert.notEqual(
      first.relay.connection.token,
      second.relay.connection.token,
    );
    for (const token of ['', 'incorrect', second.relay.connection.token]) {
      const response = await fetch(first.relay.connection.url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 401);
    }
    assert.equal(first.calls.length, 0);
    assert.deepEqual(first.relay.counts(), { requests: 3, errors: 3 });
  });

  it('rejects other paths, queries and methods without forwarding', async () => {
    const test = await fixture();
    for (const suffix of ['/other', '/mcp?url=https://example.com', '/mcp/']) {
      const response = await fetch(new URL(suffix, test.relay.connection.url), {
        headers: test.headers,
      });
      assert.equal(response.status, 404);
    }
    const response = await fetch(test.relay.connection.url, {
      method: 'PUT',
      headers: test.headers,
    });
    assert.equal(response.status, 404);
    assert.equal(test.calls.length, 0);
  });

  it('does not follow upstream redirects or return their locations', async () => {
    const test = await fixture((_request, response) => {
      response.writeHead(307, { Location: 'https://example.com' });
      response.end();
    });
    const response = await fetch(test.relay.connection.url, {
      headers: test.headers,
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('location'), null);
    assert.equal(test.calls.length, 1);
    assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
  });

  it('bounds request bodies and concurrent upstream requests', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const test = await fixture(
      (_request, response) => {
        finish = () => response.end('ok');
        entered();
      },
      { limits: { requestBytes: 4, concurrency: 1 } },
    );
    const oversized = await fetch(test.relay.connection.url, {
      method: 'POST',
      headers: test.headers,
      body: '12345',
    });
    assert.equal(oversized.status, 413);
    assert.equal(test.calls.length, 0);
    const pending = fetch(test.relay.connection.url, { headers: test.headers });
    await started;
    const busy = await fetch(test.relay.connection.url, {
      headers: test.headers,
    });
    assert.equal(busy.status, 503);
    finish();
    assert.equal(await (await pending).text(), 'ok');
    assert.equal(test.calls.length, 1);
    assert.deepEqual(test.relay.counts(), { requests: 3, errors: 2 });
  });

  it('bounds streamed response bytes', async () => {
    const test = await fixture(
      (_request, response) => response.end('too large'),
      { limits: { responseBytes: 4 } },
    );
    await assert.rejects(async () => {
      const response = await fetch(test.relay.connection.url, {
        headers: test.headers,
      });
      await response.text();
    });
    await test.relay.close();
    assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
  });

  it('bounds chunked request bodies without relying on content length', async () => {
    const test = await fixture(undefined, { limits: { requestBytes: 4 } });
    const response = await fetch(test.relay.connection.url, {
      method: 'POST',
      headers: test.headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('12345'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    assert.equal(response.status, 413);
    assert.equal(test.calls.length, 0);
    assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
  });

  it('reports upstream transport failure without exposing its message', async () => {
    const test = await fixture(undefined, {
      fetch: async () => {
        throw new Error('synthetic-host-key and private response');
      },
    });
    const response = await fetch(test.relay.connection.url, {
      headers: test.headers,
    });
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '');
    assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
  });

  for (const stall of ['transport', 'body'] as const)
    it(`enforces deadlines even when the upstream ${stall} ignores cancellation`, async () => {
      const deadline = new AbortController();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const test = await fixture(undefined, {
        timeoutSignal: () => deadline.signal,
        fetch: async () => {
          entered();
          if (stall === 'transport') return new Promise<Response>(() => {});
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('first'));
              },
              cancel: () => new Promise<void>(() => {}),
            }),
          );
        },
      });
      const pending = fetch(test.relay.connection.url, {
        headers: test.headers,
      });
      await started;
      const completion = stall === 'body' ? (await pending).text() : pending;
      deadline.abort();
      await assert.rejects(completion);
      await test.relay.close();
      assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
    });

  it('rejects redirects even when the upstream body never finishes cancellation', async () => {
    const test = await fixture(undefined, {
      fetch: async () =>
        new Response(
          new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
          { status: 307, headers: { Location: 'https://example.com' } },
        ),
    });
    const response = await fetch(test.relay.connection.url, {
      headers: test.headers,
    });
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '');
    await test.relay.close();
    assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
  });

  for (const reason of ['deadline', 'abort'] as const)
    it(`cancels a stalled request on ${reason} and revokes the capability on close`, async () => {
      const deadline = new AbortController();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const test = await fixture(() => entered(), {
        timeoutSignal: () => deadline.signal,
      });
      const pending = fetch(test.relay.connection.url, {
        headers: test.headers,
      });
      await started;
      if (reason === 'abort') test.controller.abort();
      else deadline.abort();
      await assert.rejects(pending);
      await test.relay.close();
      await test.relay.close();
      await assert.rejects(
        fetch(test.relay.connection.url, { headers: test.headers }),
      );
      assert.deepEqual(test.relay.counts(), { requests: 1, errors: 1 });
    });
});
