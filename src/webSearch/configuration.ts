import { isLoopbackHostname } from '../providers/openai/baseUrl.ts';

export const DEFAULT_WEB_SEARCH_BASE_URL = 'https://api.openai.com';

/** Pure host configuration validation; diagnostics never include the URL. */
export function validateWebSearchBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('FORGE_WEB_SEARCH_BASE_URL must be a valid URL.');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError(
      'FORGE_WEB_SEARCH_BASE_URL must use HTTPS (HTTP is allowed for loopback tests) without credentials, a query, or a fragment.',
    );
}
