import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

/** Egress proxy for the relay's own upstream connection; never logged or recorded. */
export interface McpRelayUpstreamProxy {
  readonly https: string;
  readonly noProxy?: string;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** True when `host` matches a `NO_PROXY`-style list (`*`, `host`, `.suffix`, optional `:port`). */
export function bypassesUpstreamProxy(
  url: URL,
  noProxy: string | undefined,
): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of (noProxy ?? '').split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort: string | undefined;
    const portMatch = /^(.*):(\d+)$/.exec(entry);
    if (portMatch && !portMatch[1]!.includes(':')) {
      entry = portMatch[1]!;
      entryPort = portMatch[2];
    }
    if (entryPort !== undefined && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, '.');
    if (entry.startsWith('.') ? host.endsWith(entry) : host === entry)
      return true;
  }
  return false;
}

/**
 * A `fetch`-shaped upstream call that tunnels through an HTTP proxy with
 * CONNECT. Errors are generic so the proxy URL cannot leak through them.
 * Redirects are never followed; callers see the 3xx response.
 */
export function createProxiedFetch(
  proxy: McpRelayUpstreamProxy,
): typeof globalThis.fetch {
  const proxyUrl = new URL(proxy.https);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input),
    );
    if (bypassesUpstreamProxy(target, proxy.noProxy))
      return globalThis.fetch(input, init);
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const socket = await openTunnel(proxyUrl, target, signal);
    return sendThroughTunnel(socket, target, init ?? {}, signal);
  }) as typeof globalThis.fetch;
}

function openTunnel(
  proxyUrl: URL,
  target: URL,
  signal: AbortSignal | undefined,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${
      target.port || (target.protocol === 'https:' ? '443' : '80')
    }`;
    const send = proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const connectRequest = send({
      protocol: proxyUrl.protocol,
      hostname: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      agent: false,
      ...(signal ? { signal } : {}),
    });
    connectRequest.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error('MCP relay proxy refused the tunnel.'));
        return;
      }
      resolve(socket);
    });
    connectRequest.once('error', () =>
      reject(new Error('MCP relay proxy connection failed.')),
    );
    connectRequest.once('response', (response) => {
      response.resume();
      reject(new Error('MCP relay proxy refused the tunnel.'));
    });
    connectRequest.end();
  });
}

function sendThroughTunnel(
  tunnel: Duplex,
  target: URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const secure = target.protocol === 'https:';
    const connection = secure
      ? tlsConnect({ socket: tunnel, servername: target.hostname })
      : tunnel;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const send = secure ? httpsRequest : httpRequest;
    const upstream: ClientRequest = send(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers,
        agent: false,
        createConnection: () => connection as never,
        ...(signal ? { signal } : {}),
      },
      (response: IncomingMessage) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === 'string') responseHeaders.set(name, value);
        const status = response.statusCode ?? 502;
        resolve(
          new Response(
            NULL_BODY_STATUSES.has(status)
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      },
    );
    upstream.once('error', () => {
      connection.destroy();
      reject(new Error('MCP relay upstream request failed.'));
    });
    const body = init.body;
    if (body === undefined || body === null) upstream.end();
    else upstream.end(body as Buffer);
  });
}
