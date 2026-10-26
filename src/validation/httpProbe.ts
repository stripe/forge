import type { CompletionRequest } from '../contracts/completion.ts';
import type { CredentialReference } from '../contracts/credentials.ts';
import type { ModelProbe, ModelProbeOutcome } from '../contracts/modelProbe.ts';
import type { ModelRefV1 } from '../model/types.ts';

const MAX_RESPONSE_BYTES = 64 * 1024;

export function modelProbeRequest(model: ModelRefV1): CompletionRequest {
  return {
    runId: 'model-probe',
    purpose: 'judge',
    model,
    messages: [{ role: 'user', content: 'Return {"ok":true}.' }],
    maxTokens: 64,
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
    async run({ credentialResolver, signal }): Promise<ModelProbeOutcome> {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(
        Math.min(options.timeoutMs ?? 60_000, 60_000),
      );
      const boundedSignal = AbortSignal.any([signal, timeout]);
      let secret: string;
      try {
        secret = await credentialResolver.resolve(options.credential, {
          runId: 'model-probe',
          purpose: 'model-probe',
          signal: boundedSignal,
        });
        if (!secret || /[\u0000-\u001f\u007f]/.test(secret)) return 'auth';
      } catch {
        signal.throwIfAborted();
        return timeout.aborted ? 'timeout' : 'auth';
      }
      try {
        boundedSignal.throwIfAborted();
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
            signal: boundedSignal,
          },
        );
        if (!response.ok) {
          const outcome = classifyFailure(
            response,
            '',
            options.structured === true,
          );
          if (outcome !== 'other') {
            await response.body?.cancel().catch(() => undefined);
            return outcome;
          }
        }
        const raw = await readResponse(response, boundedSignal);
        if (!response.ok)
          return classifyFailure(response, raw, options.structured === true);
        try {
          return options.accepts(raw)
            ? 'ok'
            : options.structured
              ? 'missing_structured_output'
              : 'other';
        } catch {
          return options.structured ? 'missing_structured_output' : 'other';
        }
      } catch {
        signal.throwIfAborted();
        return timeout.aborted ? 'timeout' : 'other';
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
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error('Probe response exceeds bound.');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function classifyFailure(
  response: Response,
  raw: string,
  structured: boolean,
): ModelProbeOutcome {
  if (response.status === 401 || response.status === 403) return 'auth';
  if (
    response.status === 429 ||
    (response.status === 503 && response.headers.has('retry-after'))
  )
    return 'rate_limited';
  if (response.status === 408 || response.status === 504) return 'timeout';
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
      return 'other';
    error = parsed.error as Record<string, unknown>;
  } catch {
    return 'other';
  }
  const code = typeof error.code === 'string' ? error.code : error.type;
  const message = typeof error.message === 'string' ? error.message : '';
  if (
    code === 'model_not_found' ||
    code === 'unknown_model' ||
    code === 'invalid_model' ||
    (response.status === 404 &&
      (code === 'not_found_error' || /model/i.test(message))) ||
    (response.status === 400 &&
      /(?:model.*(?:does not exist|not found|unknown|not available)|not a valid model|invalid model (?:id|name)|(?:unknown|unrecognized) model)/i.test(
        message,
      ))
  )
    return 'unknown_model';
  if (
    structured &&
    (response.status === 400 || response.status === 422) &&
    /(?:structured.output|json.schema|response.format|output.config)/i.test(
      message,
    )
  )
    return 'missing_structured_output';
  return 'other';
}
