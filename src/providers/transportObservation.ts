import {
  type CompletionTransportObservation,
  completionProviderErrorCodeSchema,
  MAX_COMPLETION_RETRY_WAIT_MS,
} from '../contracts/completionObservation.ts';

const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** Read only a bounded error envelope. Unrecognized values are discarded. */
export async function observeCompletionFailure(
  response: Response,
  provider: 'openai' | 'anthropic',
  signal: AbortSignal,
  now: number = Date.now(),
): Promise<CompletionTransportObservation> {
  const retryAfter = response.headers.get('retry-after');
  let retryMs: number | undefined;
  if (retryAfter !== null && retryAfter.length <= 128) {
    const date =
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
        retryAfter,
      )
        ? Date.parse(retryAfter)
        : Number.NaN;
    const value = /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Math.min(MAX_COMPLETION_RETRY_WAIT_MS, Number(retryAfter) * 1000)
      : date - now;
    if (Number.isFinite(value)) {
      retryMs = Math.round(
        Math.max(0, Math.min(MAX_COMPLETION_RETRY_WAIT_MS, value)),
      );
    }
  }
  const requestId = response.headers.get(
    provider === 'openai' ? 'x-request-id' : 'request-id',
  );
  let providerCode: CompletionTransportObservation['provider_error_code'];
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ERROR_BODY_BYTES) break;
        chunks.push(value);
      }
      if (size <= MAX_ERROR_BODY_BYTES) {
        const decoded = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        ) as unknown;
        if (
          decoded !== null &&
          typeof decoded === 'object' &&
          'error' in decoded
        ) {
          const envelope = decoded.error;
          if (envelope !== null && typeof envelope === 'object') {
            for (const key of ['code', 'type'] as const) {
              if (key in envelope) {
                const parsed = completionProviderErrorCodeSchema.safeParse(
                  (envelope as Record<string, unknown>)[key],
                );
                if (parsed.success) {
                  providerCode = parsed.data;
                  break;
                }
              }
            }
          }
        }
      }
    } catch {
      // Status and validated headers remain useful when the body is unreadable.
    } finally {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return Object.freeze({
    origin: 'host_transport',
    http_status: response.status,
    ...(retryMs === undefined ? {} : { retry_after_ms: retryMs }),
    ...(requestId !== null &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)
      ? { request_id: requestId }
      : {}),
    ...(providerCode === undefined
      ? {}
      : { provider_error_code: providerCode }),
  });
}
