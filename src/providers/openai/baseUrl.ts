const MAX_BASE_URL_BYTES = 4_096;

/** Validates an OpenAI API root; plaintext HTTP is allowed only for loopback hosts. */
export function normalizeOpenAIBaseUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_BASE_URL_BYTES ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new TypeError('OpenAI baseUrl must be a bounded HTTP(S) URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('OpenAI baseUrl must be a valid HTTP(S) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('OpenAI baseUrl must use HTTP or HTTPS.');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError(
      'OpenAI baseUrl may use plaintext HTTP only for a loopback host.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(
      'OpenAI baseUrl must not contain credentials, a query, or a fragment.',
    );
  }
  return value.replace(/\/+$/, '');
}

/** The single loopback definition shared by the OpenAI provider and host web search. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}
