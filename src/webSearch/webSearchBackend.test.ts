import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  parseSearchResponse,
  parseSearchUsage,
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
