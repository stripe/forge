import * as http from 'node:http';
import * as https from 'node:https';

export const WEB_SEARCH_MODEL = 'gpt-4.1-mini';
export const MAX_QUERY_CHARS = 4000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 120_000;

export interface SearchResult {
  readonly sources: readonly {url: string; title?: string}[];
  readonly searchCount: number;
}

export class SearchInputError extends Error {}

export function validateQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new SearchInputError('query must be a non-empty string.');
  if (value.trim().length > MAX_QUERY_CHARS)
    throw new SearchInputError(
      `query must be at most ${MAX_QUERY_CHARS} characters.`,
    );
  return value.trim();
}

/** Fixed provider request: neither callers nor authored inputs select authority. */
export function searchRequest(query: string): string {
  return JSON.stringify({
    model: WEB_SEARCH_MODEL,
    input: query,
    tools: [{type: 'web_search', external_web_access: false}],
    include: ['web_search_call.action.sources'],
  });
}

/** Keep source discovery separate from the provider's synthesized answer. */
export function parseSearchResponse(raw: string): SearchResult {
  const payload: unknown = JSON.parse(raw);
  if (!isRecord(payload) || payload.error || !Array.isArray(payload.output))
    throw new Error('Search backend returned an invalid response.');
  const sources: {url: string; title?: string}[] = [];
  const seen = new Set<string>();
  let searchCount = 0;
  for (const item of payload.output) {
    if (isRecord(item) && item.type === 'web_search_call') {
      searchCount += 1;
      if (isRecord(item.action) && Array.isArray(item.action.sources)) {
        for (const entry of item.action.sources) {
          const source = toSource(entry);
          if (source && !seen.has(source.url) && sources.length < 200) {
            seen.add(source.url);
            sources.push(source);
          }
        }
      }
    }
  }
  return {sources, searchCount};
}

/** Host-only transport with a fixed upstream request and bounded response. */
export function runWebSearch(
  query: string,
  options: {
    readonly upstreamBaseUrl: string;
    readonly upstreamCredential: string;
    readonly signal: AbortSignal;
  },
): Promise<SearchResult> {
  const body = searchRequest(validateQuery(query));
  options.signal.throwIfAborted();
  const url = new URL(
    `${options.upstreamBaseUrl.replace(/\/$/, '')}/v1/responses`,
  );
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: 'POST',
        signal: options.signal,
        headers: {
          authorization: `Bearer ${options.upstreamCredential}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES)
            request.destroy(
              new Error('Search response exceeded its size limit.'),
            );
          else chunks.push(chunk);
        });
        response.once('error', () =>
          reject(new Error('Search backend unavailable.')),
        );
        response.once('aborted', () =>
          reject(new Error('Search backend unavailable.')),
        );
        response.once('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error('Search backend unavailable.'));
            return;
          }
          try {
            resolve(
              parseSearchResponse(Buffer.concat(chunks).toString('utf8')),
            );
          } catch {
            reject(new Error('Search backend returned an invalid response.'));
          }
        });
      },
    );
    // An absolute deadline also bounds a backend that continuously trickles bytes.
    const timer = setTimeout(
      () => request.destroy(new Error('Search timed out.')),
      SEARCH_TIMEOUT_MS,
    );
    request.once('close', () => clearTimeout(timer));
    request.once('error', () =>
      reject(
        new Error(
          options.signal.aborted
            ? 'Search cancelled.'
            : 'Search backend unavailable.',
        ),
      ),
    );
    request.end(body);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toSource(value: unknown): {url: string; title?: string} | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return undefined;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return undefined;
  return {
    url: value.url,
    ...(typeof value.title === 'string' && value.title
      ? {title: value.title}
      : {}),
  };
}
