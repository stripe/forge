import assert from 'node:assert/strict';
import * as http from 'node:http';
import { it, vi } from 'vitest';
import {
  parseSearchResponse,
  parseSearchUsage,
  runWebSearch,
  searchRequest,
  validateQuery,
} from './webSearchBackend.ts';

it('fixes authority and validates queries without accepting agent configuration', () => {
  assert.deepEqual(JSON.parse(searchRequest('query')), {
    model: 'gpt-4.1-mini',
    input: 'query',
    tools: [{ type: 'web_search', external_web_access: false }],
    include: ['web_search_call.action.sources'],
  });
  for (const value of ['', '  ', null, {}, 'x'.repeat(4001)])
    assert.throws(() => validateQuery(value));
  assert.equal(validateQuery(' query '), 'query');
});

it.each(['failed', 'incomplete', 'in_progress'])(
  'rejects an HTTP 200 response with status %s even without an error field',
  async (status) => {
    const upstream = http.createServer((_request, response) => {
      response.end(
        JSON.stringify({
          status,
          output: [],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }),
      );
    });
    const options = await backendOptions(upstream);
    try {
      await assert.rejects(runWebSearch('query', options), /invalid response/);
    } finally {
      await closeUpstream(upstream);
    }
  },
);

it('accepts completed and absent response status', () => {
  for (const status of ['completed', undefined])
    assert.equal(
      parseSearchResponse(JSON.stringify({ status, output: [] })).searchCount,
      0,
    );
});

it.each([0, 1])(
  'bounds upstream responses to 4 MiB (excess bytes: %i)',
  async (excess) => {
    const empty = JSON.stringify({ output: [], padding: '' });
    const body = JSON.stringify({
      output: [],
      padding: 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(empty) + excess),
    });
    const upstream = http.createServer((_request, response) =>
      response.end(body),
    );
    const options = await backendOptions(upstream);
    try {
      const result = runWebSearch('query', options);
      if (excess) await assert.rejects(result, /Search backend/);
      else assert.deepEqual((await result).sources, []);
    } finally {
      await closeUpstream(upstream);
    }
  },
);

it('enforces the 120 s absolute deadline even while the upstream trickles bytes', async () => {
  let response!: http.ServerResponse;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const upstream = http.createServer((_request, incomingResponse) => {
    response = incomingResponse;
    response.write('{"output":[');
    started();
  });
  const options = await backendOptions(upstream);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let settled = false;
    const pending = runWebSearch('query', options);
    const rejected = assert.rejects(pending, /Search backend unavailable/);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await ready;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      response.write(' ');
      assert.equal(settled, false);
    }
    await vi.advanceTimersByTimeAsync(29_999);
    assert.equal(settled, false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    assert.equal(settled, true);
  } finally {
    vi.useRealTimers();
    await closeUpstream(upstream);
  }
});

async function backendOptions(upstream: http.Server) {
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    upstreamCredential: 'host-only',
    signal: new AbortController().signal,
  };
}

async function closeUpstream(upstream: http.Server) {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}

it('bounds and deduplicates sources, retaining only safe URLs and optional titles', () => {
  const sources = [
    { url: 'https://example.com/a', title: 'Title', text: 'private answer' },
    { url: 'https://example.com/a', title: 'Duplicate' },
    { url: 'https://user:password@example.com' },
    { url: 'javascript:alert(1)' },
    { url: 'invalid' },
    ...Array.from({ length: 300 }, (_, i) => ({
      url: `https://example.com/${i}`,
    })),
  ];
  const result = parseSearchResponse(
    JSON.stringify({
      output: [
        { type: 'web_search_call', action: { sources } },
        { type: 'web_search_call' },
        { type: 'message', content: [{ text: 'provider answer' }] },
      ],
    }),
  );
  assert.equal(result.sources.length, 200);
  assert.deepEqual(result.sources[0], {
    url: 'https://example.com/a',
    title: 'Title',
  });
  assert.equal(result.searchCount, 2);
  assert.equal(JSON.stringify(result).includes('private answer'), false);
});

it.each([511, 512, 513, 4096])(
  'bounds source titles to 512 characters (length: %i)',
  (length) => {
    const result = parseSearchResponse(
      JSON.stringify({
        output: [
          {
            type: 'web_search_call',
            action: {
              sources: [
                { url: 'https://example.com', title: 'x'.repeat(length) },
              ],
            },
          },
        ],
      }),
    );
    assert.equal(result.sources[0]!.title, 'x'.repeat(Math.min(length, 512)));
  },
);

it('makes missing, inconsistent, negative, overflowing and malformed token metadata nullable', () => {
  for (const value of [
    undefined,
    null,
    [],
    { input_tokens: '4', output_tokens: 1, total_tokens: 5 },
    { input_tokens: -1, output_tokens: 1, total_tokens: 0 },
    { input_tokens: 4, output_tokens: 1, total_tokens: 6 },
    {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 1,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    assert.deepEqual(parseSearchUsage(value), {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
    });
  }
  assert.deepEqual(
    parseSearchUsage({
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: -1 },
    }),
    {
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
      cached_input_tokens: null,
      reasoning_tokens: null,
    },
  );
});
