import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { runBoundedCommand } from './command.mjs';

const MAX_BRIDGE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_BRIDGE_CONCURRENCY = 8;
const BRIDGE_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const BLOCKED_ANTHROPIC_BETA_FLAGS = new Set([
  'thinking-token-count-2026-05-13',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function gatewayBridgePaths(prefix, protocol) {
  if (protocol === 'responses') return new Set([`/${prefix}/responses`]);
  if (protocol === 'chat-completions')
    return new Set([`/${prefix}/chat/completions`]);
  if (protocol === 'messages')
    return new Set([
      `/${prefix}/v1/messages`,
      `/${prefix}/v1/messages/count_tokens`,
    ]);
  throw new TypeError('Unsupported live gateway protocol.');
}

function gatewayBridgeUpstreamPath(upstream, target, prefix) {
  const suffix = target.pathname.slice(`/${prefix}`.length);
  return `${upstream.pathname.replace(/\/+$/, '')}${suffix}${target.search}`;
}

export async function startLoopbackGatewayBridge({
  upstream,
  upstreamCredential,
  protocol,
}) {
  const prefix = randomBytes(32).toString('hex');
  const bridgeCredential = randomBytes(32).toString('base64url');
  const expectedAuthorizationDigest = authorizationDigest(bridgeCredential);
  const allowedPaths = gatewayBridgePaths(prefix, protocol);
  const upstreamTransport = upstream.protocol === 'https:' ? https : http;
  const sockets = new Set();
  const upstreamRequests = new Set();
  let activeRequests = 0;

  const server = http.createServer(
    {
      headersTimeout: 15_000,
      requestTimeout: BRIDGE_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 64 * 1024,
    },
    (request, response) => {
      const requestTarget = request.url ?? '';
      const healthPath = `/${prefix}/_forge_live_health`;
      if (request.method === 'GET' && requestTarget === healthPath) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (
        activeRequests >= MAX_BRIDGE_CONCURRENCY ||
        requestTarget.length > 4_096 ||
        !requestTarget.startsWith('/') ||
        request.headers.upgrade !== undefined
      ) {
        rejectBridgeRequest(request, response, 400);
        return;
      }

      let parsedTarget;
      try {
        parsedTarget = new URL(requestTarget, 'http://forge-bridge.invalid');
      } catch {
        rejectBridgeRequest(request, response, 400);
        return;
      }
      if (
        request.method !== 'POST' ||
        !allowedPaths.has(parsedTarget.pathname) ||
        !authorizedBridgeRequest(
          request.headers.authorization,
          expectedAuthorizationDigest,
        )
      ) {
        rejectBridgeRequest(request, response, 403);
        return;
      }
      const contentLength = request.headers['content-length'];
      if (
        typeof contentLength === 'string' &&
        (!/^[0-9]+$/.test(contentLength) ||
          Number(contentLength) > MAX_BRIDGE_REQUEST_BYTES)
      ) {
        rejectBridgeRequest(request, response, 413);
        return;
      }

      activeRequests += 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        activeRequests -= 1;
      };
      response.once('close', finish);
      response.once('finish', finish);

      const upstreamPath = gatewayBridgeUpstreamPath(
        upstream,
        parsedTarget,
        prefix,
      );
      const headers = sanitizedProxyHeaders(request.headers);
      headers.host = upstream.host;
      headers.authorization = `Bearer ${upstreamCredential}`;
      delete headers['x-api-key'];
      if (protocol === 'messages') filterAnthropicBetaHeader(headers);

      const upstreamRequest = upstreamTransport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: request.method,
          path: upstreamPath,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            sanitizedProxyHeaders(upstreamResponse.headers),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstreamRequests.add(upstreamRequest);
      upstreamRequest.once('close', () =>
        upstreamRequests.delete(upstreamRequest),
      );
      upstreamRequest.setTimeout(BRIDGE_REQUEST_TIMEOUT_MS, () => {
        upstreamRequest.destroy();
      });
      upstreamRequest.once('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end('gateway unavailable');
      });

      let requestBytes = 0;
      request.on('data', (chunk) => {
        requestBytes += chunk.byteLength;
        if (requestBytes > MAX_BRIDGE_REQUEST_BYTES) {
          upstreamRequest.destroy();
          if (!response.headersSent) response.writeHead(413);
          response.end();
          request.destroy();
          return;
        }
        if (!upstreamRequest.destroyed && !upstreamRequest.write(chunk)) {
          request.pause();
          upstreamRequest.once('drain', () => request.resume());
        }
      });
      request.once('end', () => {
        if (!upstreamRequest.destroyed) upstreamRequest.end();
      });
      request.once('aborted', () => upstreamRequest.destroy());
      request.once('error', () => upstreamRequest.destroy());
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.maxConnections = MAX_BRIDGE_CONCURRENCY * 2;

  await new Promise((resolve, reject) => {
    const startupError = (error) => reject(error);
    server.once('error', startupError);
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', startupError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeBridgeServer(server, sockets, upstreamRequests);
    throw new Error('The loopback gateway bridge did not bind a TCP port.');
  }

  return Object.freeze({
    server,
    port: address.port,
    credential: bridgeCredential,
    agentBaseUrl: `http://host.docker.internal:${address.port}/${prefix}`,
    healthUrl: `http://host.docker.internal:${address.port}/${prefix}/_forge_live_health`,
    close: () => closeBridgeServer(server, sockets, upstreamRequests),
  });
}

function authorizedBridgeRequest(rawAuthorization, expectedDigest) {
  if (typeof rawAuthorization !== 'string') return false;
  return timingSafeEqual(
    authorizationDigestValue(rawAuthorization),
    expectedDigest,
  );
}

function authorizationDigest(credential) {
  return authorizationDigestValue(`Bearer ${credential}`);
}

function authorizationDigestValue(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sanitizedProxyHeaders(input) {
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
      name.toLowerCase() !== 'host' &&
      name.toLowerCase() !== 'authorization' &&
      name.toLowerCase() !== 'x-api-key'
    ) {
      output[name] = value;
    }
  }
  return output;
}

function filterAnthropicBetaHeader(headers) {
  const raw = headers['anthropic-beta'];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const kept = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(
      (value) => value.length > 0 && !BLOCKED_ANTHROPIC_BETA_FLAGS.has(value),
    );
  if (kept.length === 0) delete headers['anthropic-beta'];
  else headers['anthropic-beta'] = kept.join(',');
}

function rejectBridgeRequest(request, response, status) {
  request.resume();
  response.writeHead(status);
  response.end();
}

async function closeBridgeServer(server, sockets, upstreamRequests) {
  for (const request of upstreamRequests) request.destroy();
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function assertDockerCanReachBridge(
  { bridge, dockerExecutable, platform, imageId, signal: executionSignal },
  runCommand = runBoundedCommand,
) {
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error('The bridge probe requires an immutable Docker image ID.');
  }
  const result = await runCommand(
    dockerExecutable,
    [
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      platform,
      '--entrypoint',
      '/usr/bin/curl',
      imageId,
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      bridge.healthUrl,
    ],
    AbortSignal.any([executionSignal, AbortSignal.timeout(30_000)]),
  );
  if (result.exitCode !== 0 || result.stdout !== '204') {
    throw new Error(
      'A Docker container could not reach the temporary loopback gateway bridge.',
    );
  }
}
