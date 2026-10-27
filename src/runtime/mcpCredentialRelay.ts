import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { PluginMcpConnection } from '../contracts/runtime.ts';

interface RelayLimits {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly connections: number;
}

const DEFAULT_LIMITS: RelayLimits = Object.freeze({
  requestBytes: 1024 * 1024,
  responseBytes: 16 * 1024 * 1024,
  concurrency: 8,
  timeoutMs: 60_000,
  connections: 32,
});
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
  readonly limits?: Partial<typeof DEFAULT_LIMITS>;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<McpCredentialRelay> {
  input.signal.throwIfAborted();
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError('Invalid MCP relay limit.');
  const token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const shutdown = new AbortController();
  let active = 0;
  let requests = 0;
  let errors = 0;
  let closing: Promise<void> | undefined;
  const tasks = new Set<Promise<void>>();
  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      requests += 1;
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
        fail(401);
        return;
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
      const signal = AbortSignal.any([
        shutdown.signal,
        disconnected.signal,
        (input.timeoutSignal ?? AbortSignal.timeout)(limits.timeoutMs),
      ]);
      const abort = () => {
        request.destroy();
        response.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      const task = (async () => {
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
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
          signal.removeEventListener('abort', abort);
          active -= 1;
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
  );
  server.maxConnections = limits.connections;
  server.headersTimeout = Math.min(limits.timeoutMs, 10_000);
  server.requestTimeout = limits.timeoutMs;
  server.keepAliveTimeout = 1_000;
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
