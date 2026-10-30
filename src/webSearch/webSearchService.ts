import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import type { WebSearchUsageV1 } from '../results/types.ts';
import {
  isRecord,
  parseSearchUsage,
  runWebSearch,
} from './webSearchBackend.ts';
import { handleSearchMessage } from './webSearchProtocol.ts';

export interface WebSearchConnection {
  readonly url: string;
  readonly credential: string;
  /** Supplied when this connection owns a per-run host listener. */
  close?(): Promise<void>;
}
export interface WebSearchService extends WebSearchConnection {
  close(): Promise<void>;
  usage(): WebSearchUsageV1;
}

/** Per-run, authenticated MCP endpoint; never forwards arbitrary agent HTTP requests. */
export async function startWebSearchService(options: {
  readonly upstreamBaseUrl: string;
  readonly upstreamCredential: string;
  readonly agentHostname: string;
  readonly signal: AbortSignal;
}): Promise<WebSearchService> {
  options.signal.throwIfAborted();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(options.agentHostname))
    throw new Error('Invalid search service hostname.');
  const upstream = new URL(options.upstreamBaseUrl);
  if (
    !['http:', 'https:'].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  )
    throw new Error('Invalid search upstream.');
  const route = `/${randomBytes(32).toString('hex')}/mcp/web-search`;
  const credential = randomBytes(32).toString('base64url');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${credential}`);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const sockets = new Set<Socket>();
  const calls = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  let active = 0;
  const usage: {
    -readonly [K in keyof WebSearchUsageV1]: WebSearchUsageV1[K];
  } = {
    usage_complete: true,
    tool_calls: 0,
    search_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
  };
  type Counter = Exclude<keyof WebSearchUsageV1, 'usage_complete'>;
  const counted = new Set<Counter>();
  const overflowed = new Set<Counter>();
  const add = (key: Counter, value: number | null) => {
    if (value === null) {
      usage.usage_complete = false;
      if (!counted.has(key)) usage[key] = null;
      return;
    }
    if (overflowed.has(key)) return;
    const previous = usage[key];
    const total = (previous ?? 0) + value;
    counted.add(key);
    if (!Number.isSafeInteger(total)) {
      overflowed.add(key);
      usage[key] = null;
      usage.usage_complete = false;
    } else usage[key] = total;
  };
  const server = http.createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const task = serve(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed)
          response.writeHead(500);
        response.end();
      });
      tasks.add(task);
      task.then(() => tasks.delete(task));
    },
  );
  async function serve(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const { authorization } = request.headers;
    if (
      signal.aborted ||
      request.url !== route ||
      typeof authorization !== 'string' ||
      !timingSafeEqual(digest(authorization), expected)
    ) {
      request.resume();
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    if (active >= 4) {
      request.resume();
      response.writeHead(429);
      response.end();
      return;
    }
    active += 1;
    const call = new AbortController();
    calls.add(call);
    const callSignal = AbortSignal.any([signal, call.signal]);
    response.once('close', () => {
      if (!response.writableFinished) call.abort();
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024) {
          response.writeHead(413);
          response.end();
          request.resume();
          return;
        }
        chunks.push(chunk);
      }
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      // Accept one bounded MCP request; batches are invalid requests.
      if (
        isRecord(message) &&
        message.jsonrpc === '2.0' &&
        message.method === 'tools/call' &&
        message.id != null &&
        isRecord(message.params) &&
        message.params.name === 'call_web_search'
      )
        add('tool_calls', 1);
      const result = await handleSearchMessage(message, async (query) => {
        try {
          const result = await runWebSearch(query, {
            ...options,
            signal: callSignal,
          });
          add('search_count', result.searchCount);
          for (const [key, value] of Object.entries(result.usage))
            add(key as Counter, value);
          return result;
        } catch (error) {
          add('search_count', null);
          for (const key of Object.keys(parseSearchUsage(undefined)))
            add(key as Counter, null);
          throw error;
        }
      });
      response.writeHead(result === undefined ? 202 : 200, {
        'content-type': 'application/json',
      });
      response.end(result === undefined ? undefined : JSON.stringify(result));
    } finally {
      active -= 1;
      calls.delete(call);
    }
  }
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 8;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Search listener did not bind.');
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= closeListener();
    return closing;
  }
  async function closeListener() {
    lifetime.abort();
    for (const call of calls) call.abort();
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...tasks]);
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  }
  return {
    url: `http://${options.agentHostname}:${address.port}${route}`,
    credential,
    usage: () => ({ ...usage }),
    close,
  };
}
