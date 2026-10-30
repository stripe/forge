import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseSearchResponse, searchRequest } from './webSearchBackend.ts';
import { startWebSearchService } from './webSearchService.ts';

const providerResult = {
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  },
  output: [
    {
      type: 'web_search_call',
      action: {
        sources: [
          { url: 'https://docs.stripe.com/rate-limits' },
          { url: 'https://docs.stripe.com/rate-limits' },
          { url: 'file:///etc/passwd' },
        ],
      },
    },
    { type: 'message', content: [{ text: 'withheld synthesized answer' }] },
  ],
};

describe('runner-owned search', () => {
  it('keeps consulted sources and zero-hit searches distinct from synthesized answers', () => {
    expect(parseSearchResponse(JSON.stringify(providerResult))).toEqual({
      sources: [{ url: 'https://docs.stripe.com/rate-limits' }],
      searchCount: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cached_input_tokens: 2,
        reasoning_tokens: 1,
      },
    });
    expect(parseSearchResponse('{"output":[]}')).toEqual({
      sources: [],
      searchCount: 0,
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
    });
    expect(() =>
      parseSearchResponse('{"error":{"message":"secret"}}'),
    ).toThrow();
  });

  it('authenticates MCP calls, fixes backend authority, and returns only discovery results', async () => {
    const requests: { body: string; authorization: string | undefined }[] = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        body: Buffer.concat(chunks).toString(),
        authorization: request.headers.authorization,
      });
      expect(request.url).toBe('/v1/responses');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(providerResult));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const service = await startWebSearchService({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      upstreamCredential: 'host-authority',
      agentHostname: '127.0.0.1',
      signal: new AbortController().signal,
    });
    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'call_web_search',
        arguments: { query: '  stripe rate limits  ' },
      },
    };
    try {
      expect(
        (await post(service.url, JSON.stringify(message), 'wrong')).status,
      ).toBe(403);
      expect(
        (
          await post(
            `${service.url}/other`,
            JSON.stringify(message),
            service.credential,
          )
        ).status,
      ).toBe(403);
      expect(requests).toHaveLength(0);
      const response = await post(
        service.url,
        JSON.stringify(message),
        service.credential,
      );
      const { result } = JSON.parse(response.body);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        query: 'stripe rate limits',
        results: [{ url: 'https://docs.stripe.com/rate-limits' }],
        searchCount: 1,
      });
      expect(response.body).not.toContain('withheld');
      expect(response.body).not.toContain('input_tokens');
      expect(service.usage()).toEqual({
        tool_calls: 1,
        search_count: 1,
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cached_input_tokens: 2,
        reasoning_tokens: 1,
      });
      expect(requests).toEqual([
        {
          body: searchRequest('stripe rate limits'),
          authorization: 'Bearer host-authority',
        },
      ]);
      const invalid = {
        ...message,
        params: {
          ...message.params,
          arguments: { query: 'query', model: 'other' },
        },
      };
      expect(
        JSON.parse(
          (await post(service.url, JSON.stringify(invalid), service.credential))
            .body,
        ).result.isError,
      ).toBe(true);
      expect(requests).toHaveLength(1);
      expect(
        (
          await post(
            service.url,
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
            }),
            service.credential,
          )
        ).status,
      ).toBe(202);
      expect(
        (await post(service.url, 'x'.repeat(33 * 1024), service.credential))
          .status,
      ).toBe(413);
    } finally {
      await service.close();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
    await expect(
      post(service.url, JSON.stringify(message), service.credential),
    ).rejects.toThrow();
  });

  it('reports backend failure safely and drains an active provider request on disposal', async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let count = 0;
    const upstream = http.createServer((_request, response) => {
      count += 1;
      if (count === 1) {
        response.writeHead(500);
        response.end('{"error":{"message":"secret-provider-detail"}}');
      } else started();
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const options = {
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      upstreamCredential: 'host-authority',
      agentHostname: '127.0.0.1',
      signal: new AbortController().signal,
    };
    const service = await startWebSearchService(options);
    const other = await startWebSearchService(options);
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call_web_search', arguments: { query: 'query' } },
    });
    try {
      const failed = await post(service.url, message, service.credential);
      expect(JSON.parse(failed.body).result.isError).toBe(true);
      expect(failed.body).not.toContain('secret-provider-detail');
      expect((await post(other.url, message, service.credential)).status).toBe(
        403,
      );
      const pending = post(service.url, message, service.credential).catch(
        () => undefined,
      );
      await active;
      await service.close();
      await pending;
      expect(
        (
          await post(
            other.url,
            JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
            other.credential,
          )
        ).status,
      ).toBe(200);
    } finally {
      await service.close();
      await other.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  });
});

function post(
  url: string,
  body: string,
  credential: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

it('records attempts and nulls unavailable backend usage without exposing provider text', async () => {
  let count = 0;
  const upstream = http.createServer((_request, response) => {
    count += 1;
    response.setHeader('content-type', 'application/json');
    response.end(
      count === 1
        ? JSON.stringify(providerResult)
        : count === 2
          ? JSON.stringify({
              ...providerResult,
              usage: { input_tokens: 'bad' },
            })
          : '{"invalid":"private-provider-text"}',
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const service = await startWebSearchService({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    upstreamCredential: 'host-only',
    agentHostname: '127.0.0.1',
    signal: new AbortController().signal,
  });
  const message = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'call_web_search', arguments: { query: 'query' } },
  });
  try {
    await post(service.url, message, service.credential);
    await post(service.url, message, service.credential);
    expect(service.usage()).toEqual({
      tool_calls: 2,
      search_count: 2,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
    });
    const third = await post(service.url, message, service.credential);
    expect(JSON.parse(third.body).result.isError).toBe(true);
    expect(third.body).not.toContain('private-provider-text');
    expect(service.usage().tool_calls).toBe(3);
    expect(service.usage().search_count).toBeNull();
  } finally {
    await Promise.all([service.close(), service.close()]);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it('limits concurrent requests to four and cancels them on teardown', async () => {
  let started = 0;
  let ready!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const upstream = http.createServer(() => {
    if (++started === 4) ready();
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const service = await startWebSearchService({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    upstreamCredential: 'host-only',
    agentHostname: '127.0.0.1',
    signal: new AbortController().signal,
  });
  const message = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'call_web_search', arguments: { query: 'query' } },
  });
  const pending = Array.from({ length: 4 }, () =>
    post(service.url, message, service.credential).catch(() => undefined),
  );
  try {
    await allStarted;
    expect((await post(service.url, message, service.credential)).status).toBe(
      429,
    );
    expect(started).toBe(4);
    await service.close();
    await Promise.all(pending);
  } finally {
    await service.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
