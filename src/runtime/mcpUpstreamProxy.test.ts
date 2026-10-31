import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { bypassesUpstreamProxy } from './mcpUpstreamProxy.ts';

describe('relay upstream no_proxy matching', () => {
  const url = new URL('https://mcp.stripe.com/');
  for (const [noProxy, expected] of [
    [undefined, false],
    ['', false],
    ['*', true],
    ['mcp.stripe.com', true],
    ['.stripe.com', true],
    ['*.stripe.com', true],
    ['stripe.com', false],
    ['mcp.stripe.com:443', true],
    ['mcp.stripe.com:8443', false],
    ['localhost, .localhost,mcp.stripe.com', true],
    ['other.com,.example.org', false],
  ] as const)
    it(`${noProxy ?? 'unset'} -> ${expected}`, () => {
      assert.equal(bypassesUpstreamProxy(url, noProxy), expected);
    });
});

describe('relay upstream through a CONNECT proxy', () => {
  it('reaches an upstream that only the proxy can resolve (HTTP/1.0 tunnel reply)', async () => {
    const { createServer: createHttpServer } = await import('node:http');
    const { createServer: createNetServer, connect } = await import('node:net');
    const { createProxiedFetch } = await import('./mcpUpstreamProxy.ts');
    const upstream = createHttpServer((request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ method: request.method, host: request.headers.host }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const upstreamPort = (upstream.address() as { port: number }).port;
    const tunnels: string[] = [];
    // Mimics the kos egress proxy: answers CONNECT with HTTP/1.0 and maps a
    // name that does not resolve directly to the local upstream.
    const proxy = createNetServer((client) => {
      client.once('data', (chunk) => {
        const line = chunk.toString('latin1').split('\r\n')[0] ?? '';
        tunnels.push(line);
        const server = connect(upstreamPort, '127.0.0.1', () => {
          client.write('HTTP/1.0 200 OK\r\n\r\n');
          client.pipe(server).pipe(client);
        });
        server.on('error', () => client.destroy());
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
      const proxiedFetch = createProxiedFetch({
        https: `http://127.0.0.1:${proxyPort}`,
      });
      const response = await proxiedFetch(
        'http://upstream.forge-test.invalid:8080/mcp',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{}'),
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), {
        method: 'POST',
        host: 'upstream.forge-test.invalid:8080',
      });
      assert.deepEqual(tunnels, [
        'CONNECT upstream.forge-test.invalid:8080 HTTP/1.1',
      ]);
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});
