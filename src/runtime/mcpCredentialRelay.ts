import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { isIPv4, type Socket } from 'node:net';
import type { PluginMcpConnection } from '../contracts/runtime.ts';

export interface McpCredentialRelayLimits {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly concurrency: number;
  /** Resets on request-body bytes, upstream headers, and response-body bytes. */
  readonly idleTimeoutMs: number;
  /** Sockets that have presented a valid capability. */
  readonly connections: number;
  /** Pending first authentication; a newer socket evicts the oldest pending one. */
  readonly unauthenticatedConnections: number;
  readonly authenticationTimeoutMs: number;
  readonly headerBytes: number;
  readonly keepAliveTimeoutMs: number;
}

export const DEFAULT_MCP_CREDENTIAL_RELAY_LIMITS: McpCredentialRelayLimits =
  Object.freeze({
    requestBytes: 1024 * 1024,
    responseBytes: 16 * 1024 * 1024,
    concurrency: 8,
    idleTimeoutMs: 60_000,
    connections: 32,
    unauthenticatedConnections: 4,
    authenticationTimeoutMs: 1_000,
    headerBytes: 16 * 1024,
    keepAliveTimeoutMs: 1_000,
  });

export function resolveMcpCredentialRelayLimits(
  input: Partial<McpCredentialRelayLimits> = {},
): McpCredentialRelayLimits {
  if (
    Object.keys(input).some(
      (key) => !Object.hasOwn(DEFAULT_MCP_CREDENTIAL_RELAY_LIMITS, key),
    )
  )
    throw new TypeError('Invalid MCP relay limit.');
  const limits = { ...DEFAULT_MCP_CREDENTIAL_RELAY_LIMITS, ...input };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError('Invalid MCP relay limit.');
  for (const value of [
    limits.idleTimeoutMs,
    limits.authenticationTimeoutMs,
    limits.keepAliveTimeoutMs,
  ])
    if (value > 2_147_483_647)
      throw new TypeError('Invalid MCP relay timeout.');
  return Object.freeze(limits);
}
const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;
const RESPONSE_HEADERS = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
] as const;

export interface McpCredentialRelay {
  readonly connection: PluginMcpConnection;
  counts(): Readonly<{ requests: number; errors: number }>;
  close(): Promise<void>;
}

/** Internal transport seam; callers choose the fixed upstream before listening. */
export async function startMcpCredentialRelay(input: {
  readonly upstreamUrl: string;
  readonly credential: string;
  readonly listenHost: string;
  readonly connectHost: string;
  readonly signal: AbortSignal;
  readonly limits?: Partial<McpCredentialRelayLimits>;
  readonly scheduleTimeout?: (
    expire: () => void,
    milliseconds: number,
  ) => () => void;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<McpCredentialRelay> {
  input.signal.throwIfAborted();
  const limits = resolveMcpCredentialRelayLimits(input.limits);
  if (!isIPv4(input.listenHost) || input.listenHost === '0.0.0.0')
    throw new TypeError('MCP relay requires a specific host IPv4 address.');
  const scheduleTimeout =
    input.scheduleTimeout ??
    ((expire, milliseconds) => {
      const timer = setTimeout(expire, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const shutdown = new AbortController();
  let active = 0;
  let requests = 0;
  let errors = 0;
  let closing: Promise<void> | undefined;
  const tasks = new Set<Promise<void>>();
  const unauthenticated = new Map<Socket, () => void>();
  const authenticated = new Set<Socket>();
  const server = createServer(
    { maxHeaderSize: limits.headerBytes },
    (request, response) => {
      let failed = false;
      const markError = () => {
        if (!failed) errors += 1;
        failed = true;
      };
      const fail = (status: number) => {
        markError();
        response.writeHead(status, { Connection: 'close' });
        response.end();
        request.resume();
      };
      const authorization = Buffer.from(request.headers.authorization ?? '');
      if (
        authorization.length !== expectedAuthorization.length ||
        !timingSafeEqual(authorization, expectedAuthorization)
      ) {
        response.writeHead(401, { Connection: 'close' }).end();
        request.resume();
        return;
      }
      requests += 1;
      if (!authenticated.has(request.socket)) {
        if (authenticated.size >= limits.connections) {
          fail(503);
          return;
        }
        unauthenticated.get(request.socket)?.();
        unauthenticated.delete(request.socket);
        authenticated.add(request.socket);
      }
      if (
        request.url !== '/mcp' ||
        !['POST', 'GET', 'DELETE'].includes(request.method ?? '')
      ) {
        fail(404);
        return;
      }
      if (active >= limits.concurrency || shutdown.signal.aborted) {
        fail(503);
        return;
      }
      if (
        Number(request.headers['content-length'] ?? 0) > limits.requestBytes
      ) {
        fail(413);
        return;
      }
      active += 1;
      const disconnected = new AbortController();
      response.once('close', () => disconnected.abort());
      const idle = new AbortController();
      let cancelIdle = () => {};
      const refreshIdle = () => {
        cancelIdle();
        cancelIdle = scheduleTimeout(() => idle.abort(), limits.idleTimeoutMs);
      };
      refreshIdle();
      const signal = AbortSignal.any([
        shutdown.signal,
        disconnected.signal,
        idle.signal,
      ]);
      const abort = () => {
        request.destroy();
        response.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const task = (async () => {
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            if (chunk.length > 0) refreshIdle();
            bytes += chunk.length;
            if (bytes > limits.requestBytes) {
              fail(413);
              return;
            }
            chunks.push(Buffer.from(chunk));
          }
          const headers = new Headers();
          for (const name of REQUEST_HEADERS) {
            const value = request.headers[name];
            if (typeof value === 'string') headers.set(name, value);
          }
          headers.set('Authorization', `Bearer ${input.credential}`);
          const upstream = await awaitRelayOperation(
            (input.fetch ?? globalThis.fetch)(input.upstreamUrl, {
              method: request.method!,
              headers,
              ...(bytes > 0 ? { body: Buffer.concat(chunks) } : {}),
              redirect: 'manual',
              signal,
            }),
            signal,
          );
          refreshIdle();
          if (upstream.status >= 300 && upstream.status < 400) {
            void upstream.body?.cancel().catch(() => undefined);
            fail(502);
            return;
          }
          if (upstream.status >= 400) markError();
          for (const name of RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value !== null) response.setHeader(name, value);
          }
          response.writeHead(upstream.status);
          if (upstream.body) {
            let responseBytes = 0;
            const reader = upstream.body.getReader();
            try {
              while (true) {
                const chunk = await awaitRelayOperation(reader.read(), signal);
                if (chunk.done) break;
                if (chunk.value.length > 0) refreshIdle();
                responseBytes += chunk.value.length;
                if (responseBytes > limits.responseBytes)
                  throw new Error('MCP response limit.');
                await writeChunk(response, chunk.value, signal);
              }
            } finally {
              void reader.cancel().catch(() => undefined);
            }
          }
          response.end();
        } catch {
          markError();
          if (!response.headersSent && !response.destroyed)
            response.writeHead(502).end();
          else response.destroy();
        } finally {
          cancelIdle();
          signal.removeEventListener('abort', abort);
          active -= 1;
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
  );
  server.on('connection', (socket) => {
    if (unauthenticated.size >= limits.unauthenticatedConnections) {
      const oldest = unauthenticated.keys().next().value!;
      unauthenticated.get(oldest)!();
      unauthenticated.delete(oldest);
      oldest.destroy();
    }
    unauthenticated.set(
      socket,
      scheduleTimeout(() => socket.destroy(), limits.authenticationTimeoutMs),
    );
    socket.once('close', () => {
      unauthenticated.get(socket)?.();
      unauthenticated.delete(socket);
      authenticated.delete(socket);
    });
  });
  server.headersTimeout = limits.authenticationTimeoutMs;
  server.requestTimeout = 0;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      shutdown.abort();
      server.close(() => {
        void Promise.allSettled([...tasks]).then(() => resolve());
      });
      server.closeAllConnections();
      input.signal.removeEventListener('abort', onAbort);
    });
    return closing;
  };
  const onAbort = () => {
    void close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, input.listenHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    input.signal.addEventListener('abort', onAbort, { once: true });
    input.signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('MCP relay could not listen.');
    return Object.freeze({
      connection: Object.freeze({
        url: `http://${input.connectHost}:${address.port}/mcp`,
        token,
      }),
      counts: () => Object.freeze({ requests, errors }),
      close,
    });
  } catch {
    await close();
    throw new Error('MCP credential relay could not start.');
  }
}

async function awaitRelayOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('MCP relay operation stopped.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function writeChunk(
  response: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', onDrain);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('MCP relay stream stopped.'));
    };
    response.once('drain', onDrain);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
