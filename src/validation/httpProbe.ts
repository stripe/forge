import type { CompletionRequest } from '../contracts/completion.ts';
import type { CredentialReference } from '../contracts/credentials.ts';
import type { ModelProbe, ModelProbeResult } from '../contracts/modelProbe.ts';
import type { ModelRefV1 } from '../model/types.ts';

import { MODEL_PROBE_LIMITS } from './limits.ts';

export function modelProbeRequest(model: ModelRefV1): CompletionRequest {
  return {
    runId: 'model-probe',
    purpose: 'judge',
    model,
    messages: [{ role: 'user', content: 'Return {"ok":true}.' }],
    maxTokens: MODEL_PROBE_LIMITS.outputTokens,
    responseSchema: {
      name: 'model_probe',
      strict: true,
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean', enum: [true] } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    signal: new AbortController().signal,
  };
}

export function isProbeObject(content: string): boolean {
  try {
    const value = JSON.parse(content);
    return value?.ok === true && Object.keys(value).length === 1;
  } catch {
    return false;
  }
}

/** Shared bounded HTTP shell; adapters/providers own routing, auth and wire format. */
export function createHttpModelProbe(options: {
  readonly endpoint: string;
  readonly model?: string;
  readonly credential: CredentialReference;
  readonly headers: (secret: string) => Readonly<Record<string, string>>;
  readonly body: string;
  readonly accepts: (raw: string) => boolean;
  readonly structured?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): ModelProbe {
  return Object.freeze<ModelProbe>({
    endpoint: options.endpoint,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    async run({ credentialResolver, signal }): Promise<ModelProbeResult> {
      signal.throwIfAborted();
      let secret: string;
      try {
        secret = await credentialResolver.resolve(options.credential, {
          runId: 'model-probe',
          purpose: 'model-probe',
          signal,
        });
        if (!secret || /[\u0000-\u001f\u007f]/.test(secret))
          return { outcome: 'auth', reason: 'credential_unavailable' };
      } catch {
        signal.throwIfAborted();
        return { outcome: 'auth', reason: 'credential_unavailable' };
      }
      let httpStatus: number | undefined;
      try {
        signal.throwIfAborted();
        const response = await (options.fetch ?? globalThis.fetch)(
          options.endpoint,
          {
            method: 'POST',
            redirect: 'manual',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...options.headers(secret),
            },
            body: options.body,
            signal,
          },
        );
        const status = response.status;
        httpStatus = status;
        if (!response.ok) {
          const result = classifyProbeHttpFailure(
            status,
            response.headers.has('retry-after'),
            '',
            options.structured === true,
            options.model,
          );
          if (result.outcome !== 'other') {
            void response.body?.cancel().catch(() => undefined);
            return result;
          }
        }
        const raw = await readResponse(response, signal);
        if (!response.ok)
          return classifyProbeHttpFailure(
            status,
            response.headers.has('retry-after'),
            raw,
            options.structured === true,
            options.model,
          );
        try {
          if (options.accepts(raw)) return { outcome: 'ok' };
          return options.structured
            ? {
                outcome: 'missing_structured_output',
                reason: 'invalid_structured_output',
                http_status: status,
              }
            : {
                outcome: 'other',
                reason: 'invalid_response',
                http_status: status,
              };
        } catch {
          return {
            outcome: 'other',
            reason: 'invalid_response',
            http_status: status,
          };
        }
      } catch {
        signal.throwIfAborted();
        return {
          outcome: 'other',
          reason:
            httpStatus === undefined ? 'transport_error' : 'invalid_response',
          ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
        };
      }
    },
  });
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MODEL_PROBE_LIMITS.responseBytes)
        throw new Error('Probe response exceeds bound.');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Interpret only status and recognized provider signals, never loose message matches. */
export function classifyProbeHttpFailure(
  status: number,
  hasRetryAfter: boolean,
  raw: string,
  structured: boolean,
  model?: string,
): ModelProbeResult {
  const failure = (outcome: ModelProbeResult['outcome']): ModelProbeResult => ({
    outcome,
    reason: 'http_error',
    http_status: status,
  });
  if (status === 401 || status === 403) return failure('auth');
  if (status === 429 || (status === 503 && hasRetryAfter))
    return failure('rate_limited');
  if (status === 408 || status === 504) return failure('timeout');
  let error: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('error' in parsed) ||
      !parsed.error ||
      typeof parsed.error !== 'object' ||
      Array.isArray(parsed.error)
    )
      return failure('other');
    error = parsed.error as Record<string, unknown>;
  } catch {
    return failure('other');
  }
  const codes = [error.code, error.type];
  if (
    [400, 404, 422].includes(status) &&
    (codes.some(
      (code) =>
        typeof code === 'string' &&
        ['model_not_found', 'unknown_model', 'invalid_model'].includes(code),
    ) ||
      (status === 404 &&
        error.type === 'not_found_error' &&
        model !== undefined &&
        error.message === `model: ${model}`))
  )
    return failure('unknown_model');
  if (
    structured &&
    [400, 422].includes(status) &&
    codes.some(
      (code) =>
        code === 'unsupported_parameter' || code === 'unsupported_value',
    ) &&
    typeof error.param === 'string' &&
    ['response_format', 'text.format', 'output_config'].includes(error.param)
  )
    return failure('missing_structured_output');
  return failure('other');
}
