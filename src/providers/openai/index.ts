import type {
  CompletionProvider,
  CompletionProviderCredentials,
  CompletionProviderPreflightInput,
  CompletionProviderRequirementInput,
  CompletionRequest,
  CompletionResponse,
  CompletionStopReason,
  StrictCompletionResponseSchema,
} from '../../contracts/completion.ts';
import {
  type CredentialReference,
  credentialReference,
} from '../../contracts/credentials.ts';
import { isSafeMetadata, isSafeSimpleIdentifier } from '../../model/paths.ts';
import type { ModelRefV1 } from '../../model/types.ts';
import { FORGE_VERSION } from '../../version.ts';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1' as const;
export const OPENAI_MAX_RESPONSE_BYTES = 1024 * 1024;
export const OPENAI_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TOKENS = 128_000;
const DEFAULT_MAX_TOKENS = 16_000;
const MAX_REQUEST_DURATION_MS = 5 * 60 * 1_000;
const MAX_BASE_URL_BYTES = 4_096;
const MAX_SCHEMA_DEPTH = 100;
const MAX_SCHEMA_NODES = 100_000;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export interface OpenAICompletionProviderOptions {
  readonly id?: string;
  /** Complete API root, including `/v1` when required; appends `/responses`. */
  readonly baseUrl?: string;
  readonly credential?: string | CredentialReference;
  /** May lower, but never raise, the five-minute provider bound. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export type OpenAICompletionErrorCode =
  | 'aborted'
  | 'http_error'
  | 'invalid_credentials'
  | 'invalid_request'
  | 'invalid_response'
  | 'response_too_large'
  | 'timeout'
  | 'transport_error';

/** Provider failures expose only bounded classifications, never response bodies. */
export class OpenAICompletionError extends Error {
  constructor(
    readonly code: OpenAICompletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAICompletionError';
  }
}

/** Native Responses transport; credentials and endpoint are explicit host inputs. */
export function createOpenAICompletionProvider(
  options: OpenAICompletionProviderOptions = {},
): CompletionProvider {
  const id = options.id ?? 'openai';
  if (!isSafeSimpleIdentifier(id)) {
    throw new TypeError(
      'OpenAI completion provider id must be a safe identifier.',
    );
  }
  const endpoint = `${normalizeBaseUrl(options.baseUrl ?? OPENAI_DEFAULT_BASE_URL)}/responses`;
  const credential = normalizeCredentialReference(
    options.credential,
    'openai.completion-api-key',
  );
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('OpenAI completion provider requires Node fetch.');
  }
  const requirements = Object.freeze({
    credentials: Object.freeze({
      apiKey: Object.freeze({ reference: credential }),
    }),
  });
  const validateCapability = (
    input: CompletionProviderRequirementInput,
  ): void => {
    assertPurpose(input.purpose);
    assertModel(input.model, id);
  };
  return Object.freeze({
    id,
    version: FORGE_VERSION,
    metadata: Object.freeze({
      endpoint_mode: options.baseUrl === undefined ? 'default' : 'custom',
    }),
    requirements(input: CompletionProviderRequirementInput) {
      validateCapability(input);
      return requirements;
    },
    async preflight(input: CompletionProviderPreflightInput): Promise<void> {
      throwIfAborted(input.signal);
      validateCapability(input);
      resolveCredential(input.credentials, 'apiKey');
      throwIfAborted(input.signal);
    },
    async complete(
      request: CompletionRequest,
      context: { credentials: CompletionProviderCredentials },
    ): Promise<CompletionResponse> {
      throwIfAborted(request.signal);
      validateCapability(request);
      validateRequest(request);
      const body = serializeRequest(request);
      const secret = resolveCredential(context.credentials, 'apiKey');
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([request.signal, timeoutSignal]);
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${secret}`,
          },
          body,
          signal,
        });
      } catch {
        throw transportError(request.signal, timeoutSignal);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new OpenAICompletionError(
          'http_error',
          `OpenAI completion request failed with HTTP ${response.status}.`,
        );
      }
      let raw: string;
      try {
        raw = await readBoundedResponse(response, signal);
      } catch (error) {
        if (error instanceof OpenAICompletionError) throw error;
        throw transportError(request.signal, timeoutSignal);
      }
      return parseResponse(raw, request.responseSchema !== undefined);
    },
  });
}

function normalizeCredentialReference(
  configured: string | CredentialReference | undefined,
  fallback: string,
): CredentialReference {
  if (configured === undefined) return credentialReference(fallback);
  return typeof configured === 'string'
    ? credentialReference(configured)
    : configured;
}

function normalizeBaseUrl(value: string): string {
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? MAX_REQUEST_DURATION_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_REQUEST_DURATION_MS
  ) {
    throw new TypeError(
      `OpenAI timeoutMs must be an integer from 1 to ${MAX_REQUEST_DURATION_MS}.`,
    );
  }
  return timeout;
}

function assertPurpose(
  value: unknown,
): asserts value is 'role_player' | 'judge' {
  if (value !== 'role_player' && value !== 'judge') {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion purpose is invalid.',
    );
  }
}

function assertModel(model: ModelRefV1, providerId: string): void {
  if (
    !model ||
    model.provider !== providerId ||
    !isSafeMetadata(model.model, 1_024)
  ) {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion model does not match this provider.',
    );
  }
}

function validateRequest(request: CompletionRequest): void {
  if (!isSafeMetadata(request.runId, 1_024)) {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion runId is invalid.',
    );
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion requires at least one message.',
    );
  }
  for (const message of request.messages) {
    if (
      !message ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      message.content.length === 0 ||
      Buffer.byteLength(message.content, 'utf8') > MAX_MESSAGE_BYTES ||
      message.content.includes('\0')
    ) {
      throw new OpenAICompletionError(
        'invalid_request',
        'OpenAI completion contains an invalid message.',
      );
    }
  }
  if (
    request.systemPrompt !== undefined &&
    (request.systemPrompt.length === 0 ||
      Buffer.byteLength(request.systemPrompt, 'utf8') > MAX_MESSAGE_BYTES ||
      request.systemPrompt.includes('\0'))
  ) {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion system prompt is invalid.',
    );
  }
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 1)
  ) {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion temperature must be between 0 and 1.',
    );
  }
  if (
    request.maxTokens !== undefined &&
    (!Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens <= 0 ||
      request.maxTokens > MAX_TOKENS)
  ) {
    throw new OpenAICompletionError(
      'invalid_request',
      `OpenAI completion maxTokens must be an integer from 1 to ${MAX_TOKENS}.`,
    );
  }
  if (request.responseSchema !== undefined) {
    validateResponseSchema(request.responseSchema);
  }
}

function validateResponseSchema(schema: StrictCompletionResponseSchema): void {
  if (
    schema?.strict !== true ||
    !SCHEMA_NAME.test(schema.name) ||
    !isRecord(schema.schema) ||
    (schema.description !== undefined &&
      (!isSafeMetadata(schema.description, 4_096) ||
        schema.description.includes('\0')))
  ) {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion response schema is invalid.',
    );
  }
  try {
    assertJsonValue(schema.schema, new Set(), { nodes: 0 }, 0);
  } catch {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion response schema is not bounded JSON.',
    );
  }
}

function assertJsonValue(
  value: unknown,
  ancestors: Set<object>,
  count: { nodes: number },
  depth: number,
): void {
  count.nodes += 1;
  if (count.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
    throw new TypeError('JSON value exceeds its structural bound.');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== 'object') throw new TypeError('Value is not JSON.');
  if (ancestors.has(value)) throw new TypeError('JSON value is cyclic.');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertJsonValue(entry, ancestors, count, depth + 1);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON object has a custom prototype.');
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!isSafeMetadata(key, 1_024))
        throw new TypeError('JSON key is invalid.');
      assertJsonValue(entry, ancestors, count, depth + 1);
    }
  }
  ancestors.delete(value);
}

function resolveCredential(
  credentials: CompletionProviderCredentials,
  expectedName: string,
): string {
  const names = Object.keys(credentials);
  const value = credentials[expectedName];
  if (
    names.length !== 1 ||
    names[0] !== expectedName ||
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OpenAICompletionError(
      'invalid_credentials',
      'OpenAI completion credentials are missing or invalid.',
    );
  }
  return value;
}

/** GPT-5+ and o-series models spend the output budget on reasoning too. */
function isReasoningModel(model: string): boolean {
  return /(?:^|[/])(?:gpt-(?:[5-9]|[1-9]\d)|o[1-9])(?:[.\-/]|$)/.test(model);
}

function serializeRequest(request: CompletionRequest): string {
  try {
    const reasoning = isReasoningModel(request.model.model);
    const requested = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const serialized = JSON.stringify({
      model: request.model.model,
      store: false,
      max_output_tokens: reasoning
        ? Math.max(requested, DEFAULT_MAX_TOKENS)
        : requested,
      input: request.messages,
      ...(request.systemPrompt === undefined
        ? {}
        : { instructions: request.systemPrompt }),
      ...(request.temperature === undefined || reasoning
        ? {}
        : { temperature: request.temperature }),
      ...(request.responseSchema === undefined
        ? {}
        : {
            text: {
              format: {
                type: 'json_schema',
                name: request.responseSchema.name,
                strict: true,
                ...(request.responseSchema.description === undefined
                  ? {}
                  : { description: request.responseSchema.description }),
                schema: projectOpenAISchema(request.responseSchema.schema),
              },
            },
          }),
    });
    if (Buffer.byteLength(serialized, 'utf8') > OPENAI_MAX_REQUEST_BYTES)
      throw new TypeError();
    return serialized;
  } catch {
    throw new OpenAICompletionError(
      'invalid_request',
      'OpenAI completion request could not be serialized.',
    );
  }
}

/** Uniqueness is checked by Forge locally; it is not a Responses grammar keyword. */
function projectOpenAISchema(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'uniqueItems') continue;
    if (
      (key === 'properties' || key === '$defs' || key === 'definitions') &&
      isRecord(value)
    ) {
      projected[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          isRecord(child) ? projectOpenAISchema(child) : child,
        ]),
      );
    } else if (
      (key === 'items' || key === 'additionalProperties') &&
      isRecord(value)
    ) {
      projected[key] = projectOpenAISchema(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      projected[key] = value.map((child) =>
        isRecord(child) ? projectOpenAISchema(child) : child,
      );
    } else {
      projected[key] = value;
    }
  }
  return projected;
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OpenAICompletionError(
      'invalid_response',
      'OpenAI completion returned an empty response body.',
    );
  }
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
      if (bytes > OPENAI_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OpenAICompletionError(
          'response_too_large',
          'OpenAI completion response exceeded its byte limit.',
        );
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseResponse(raw: string, structured: boolean): CompletionResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidResponse();
  }
  if (
    !isRecord(value) ||
    value.object !== 'response' ||
    !Array.isArray(value.output)
  )
    throw invalidResponse();
  let stopReason: CompletionStopReason;
  if (value.status === 'completed') stopReason = 'end_turn';
  else if (
    value.status === 'incomplete' &&
    isRecord(value.incomplete_details)
  ) {
    stopReason =
      value.incomplete_details.reason === 'max_output_tokens'
        ? 'max_tokens'
        : value.incomplete_details.reason === 'content_filter'
          ? 'refusal'
          : 'other';
  } else throw invalidResponse();
  const text: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item)) throw invalidResponse();
    if (item.type === 'reasoning') continue;
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      !Array.isArray(item.content)
    )
      throw invalidResponse();
    for (const block of item.content) {
      if (!isRecord(block)) throw invalidResponse();
      if (block.type === 'refusal' && typeof block.refusal === 'string')
        stopReason = 'refusal';
      else if (block.type === 'output_text' && typeof block.text === 'string')
        text.push(block.text);
      else throw invalidResponse();
    }
  }
  const content = text.join('');
  if (structured && stopReason === 'end_turn') {
    try {
      JSON.parse(content);
    } catch {
      throw invalidResponse();
    }
  }
  const usage = value.usage;
  if (!isRecord(usage)) throw invalidResponse();
  const input = nonnegativeInteger(usage.input_tokens);
  const output = nonnegativeInteger(usage.output_tokens);
  if (
    usage.input_tokens_details !== undefined &&
    !isRecord(usage.input_tokens_details)
  )
    throw invalidResponse();
  const cached = optionalNonnegativeInteger(
    usage.input_tokens_details?.cached_tokens,
  );
  if (
    input === undefined ||
    output === undefined ||
    cached === undefined ||
    cached > input
  )
    throw invalidResponse();
  const costUsd = optionalCost(usage.cost_usd);
  if (costUsd === null) throw invalidResponse();
  return Object.freeze({
    content,
    stopReason,
    usage: Object.freeze({
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
    }),
    ...(costUsd === undefined ? {} : { costUsd }),
  });
}

function nonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return value === undefined ? 0 : nonnegativeInteger(value);
}

function optionalCost(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): OpenAICompletionError {
  return new OpenAICompletionError(
    'invalid_response',
    'OpenAI completion returned an invalid response.',
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OpenAICompletionError(
      'aborted',
      'OpenAI completion request was aborted.',
    );
  }
}

function transportError(
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): OpenAICompletionError {
  if (callerSignal.aborted) {
    return new OpenAICompletionError(
      'aborted',
      'OpenAI completion request was aborted.',
    );
  }
  if (timeoutSignal.aborted) {
    return new OpenAICompletionError(
      'timeout',
      'OpenAI completion request timed out.',
    );
  }
  return new OpenAICompletionError(
    'transport_error',
    'OpenAI completion transport failed.',
  );
}
