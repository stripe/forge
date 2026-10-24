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

export const ANTHROPIC_MESSAGES_API_VERSION = '2023-06-01' as const;
export const ANTHROPIC_STRUCTURED_OUTPUT_FORMAT = 'json_schema' as const;
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com' as const;
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1_024;
export const ANTHROPIC_MAX_RESPONSE_BYTES = 1024 * 1024;
export const ANTHROPIC_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const ANTHROPIC_MAX_MESSAGE_BYTES = 1024 * 1024;
export const ANTHROPIC_MAX_TOKENS = 16_384;
/** Output floor for models that always think; thinking counts toward max_tokens. */
export const ANTHROPIC_ALWAYS_THINKING_MIN_MAX_TOKENS = 16_000;
export const ANTHROPIC_MAX_REQUEST_DURATION_MS = 5 * 60 * 1_000;
export const ANTHROPIC_API_KEY_CREDENTIAL = 'apiKey' as const;
export const ANTHROPIC_AUTH_TOKEN_CREDENTIAL = 'authToken' as const;

const MAX_BASE_URL_BYTES = 4_096;
const MAX_SCHEMA_DEPTH = 100;
const MAX_SCHEMA_NODES = 100_000;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CLAUDE_MODEL_VERSION =
  /(?:^|[./-])claude-(?:haiku|sonnet|opus)-(\d+)(?:[-.](\d{1,2}))?(?=$|[-./])/;
const CLAUDE_MODEL_FAMILY_VERSION =
  /(?:^|[./-])claude-(haiku|sonnet|opus)-(\d+)(?:[-.](\d{1,2}))?(?=$|[-./])/;
const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
]);

type FetchImplementation = typeof globalThis.fetch;

export interface AnthropicCompletionProviderOptions {
  /** Registry ID and required ModelRefV1.provider value. */
  readonly id?: string;
  /**
   * Messages-compatible service root. When present, Forge appends
   * `/v1/messages`. Custom endpoints default to bearer authentication.
   */
  readonly baseUrl?: string;
  /** Override the endpoint's authentication scheme explicitly. */
  readonly auth?: 'api-key' | 'bearer';
  readonly credential?: string | CredentialReference;
  /** May lower, but never raise, the five-minute provider bound. */
  readonly timeoutMs?: number;
  /** Injectable transport seam for tests and controlled hosts. */
  readonly fetch?: FetchImplementation;
}

export type AnthropicCompletionErrorCode =
  | 'aborted'
  | 'http_error'
  | 'invalid_credentials'
  | 'invalid_request'
  | 'invalid_response'
  | 'response_too_large'
  | 'timeout'
  | 'transport_error';

/** Provider failures expose only bounded classifications, never response bodies. */
export class AnthropicCompletionError extends Error {
  constructor(
    readonly code: AnthropicCompletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnthropicCompletionError';
  }
}

/**
 * Opus 4.7 and later and every Claude 5 model reject explicit sampling
 * parameters (Sonnet 5.5 rejects non-default values), so Forge omits
 * `temperature` for them and the model's default sampling applies.
 */
export function acceptsAnthropicSamplingTemperature(model: string): boolean {
  const match = CLAUDE_MODEL_FAMILY_VERSION.exec(model);
  if (!match) return true;
  const family = match[1];
  const major = Number(match[2]);
  const minor = Number(match[3] ?? 0);
  if (major >= 5) return false;
  return !(family === 'opus' && major === 4 && minor >= 7);
}

/**
 * Claude 5 models think adaptively whether or not `thinking` is sent, and
 * thinking tokens count toward `max_tokens`. Small caps sized for older models
 * can be spent entirely on thinking, leaving no text.
 */
export function alwaysThinksAnthropicModel(model: string): boolean {
  const match = CLAUDE_MODEL_FAMILY_VERSION.exec(model);
  return match !== null && Number(match[2]) >= 5;
}

/** Anthropic structured outputs require Claude 4.5 or newer. */
export function supportsAnthropicStructuredOutputModel(model: string): boolean {
  const version = CLAUDE_MODEL_VERSION.exec(model);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 5);
}

/** Native Node.js fetch-based Messages provider with no ambient credential reads. */
export function createAnthropicCompletionProvider(
  options: AnthropicCompletionProviderOptions = {},
): CompletionProvider {
  const id = options.id ?? 'anthropic';
  if (!isSafeSimpleIdentifier(id)) {
    throw new TypeError(
      'Anthropic completion provider id must be a safe identifier.',
    );
  }
  const compatibleEndpoint = options.baseUrl !== undefined;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
  );
  const endpoint = `${baseUrl}/v1/messages`;
  const auth = options.auth ?? (compatibleEndpoint ? 'bearer' : 'api-key');
  if (auth !== 'api-key' && auth !== 'bearer') {
    throw new TypeError('Anthropic auth must be api-key or bearer.');
  }
  const credentialName =
    auth === 'bearer'
      ? ANTHROPIC_AUTH_TOKEN_CREDENTIAL
      : ANTHROPIC_API_KEY_CREDENTIAL;
  const credential = normalizeCredentialReference(
    options.credential,
    auth === 'bearer' ? 'anthropic.auth-token' : 'anthropic.api-key',
  );
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('Anthropic completion provider requires Node fetch.');
  }
  const requirements = Object.freeze({
    credentials: Object.freeze({
      [credentialName]: Object.freeze({ reference: credential }),
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
      endpoint_mode: compatibleEndpoint ? 'custom' : 'default',
    }),
    requirements(input: CompletionProviderRequirementInput) {
      validateCapability(input);
      return requirements;
    },
    async preflight(input: CompletionProviderPreflightInput): Promise<void> {
      throwIfAborted(input.signal);
      validateCapability(input);
      resolveCredential(input.credentials, credentialName);
      throwIfAborted(input.signal);
    },
    async complete(
      request: CompletionRequest,
      context: { credentials: CompletionProviderCredentials },
    ): Promise<CompletionResponse> {
      throwIfAborted(request.signal);
      validateCapability(request);
      validateRequest(request);
      const secret = resolveCredential(context.credentials, credentialName);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([request.signal, timeoutSignal]);
      const headers: Record<string, string> = {
        accept: 'application/json',
        'anthropic-version': ANTHROPIC_MESSAGES_API_VERSION,
        'content-type': 'application/json',
        ...(auth === 'bearer'
          ? { authorization: `Bearer ${secret}` }
          : { 'x-api-key': secret }),
      };
      const body = serializeRequest(request);

      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers,
          body,
          signal,
        });
      } catch {
        throw transportError(request.signal, timeoutSignal);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new AnthropicCompletionError(
          'http_error',
          `Anthropic completion request failed with HTTP ${response.status}.`,
        );
      }

      let raw: string;
      try {
        raw = await readBoundedResponse(response, signal);
      } catch (error) {
        if (error instanceof AnthropicCompletionError) throw error;
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
    throw new TypeError('Anthropic baseUrl must be a bounded HTTP(S) URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Anthropic baseUrl must be a valid HTTP(S) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Anthropic baseUrl must use HTTP or HTTPS.');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError(
      'Anthropic baseUrl may use plaintext HTTP only for a loopback host.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(
      'Anthropic baseUrl must not contain credentials, a query, or a fragment.',
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
  const timeout = value ?? ANTHROPIC_MAX_REQUEST_DURATION_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > ANTHROPIC_MAX_REQUEST_DURATION_MS
  ) {
    throw new TypeError(
      `Anthropic timeoutMs must be an integer from 1 to ${ANTHROPIC_MAX_REQUEST_DURATION_MS}.`,
    );
  }
  return timeout;
}

function assertPurpose(
  value: unknown,
): asserts value is 'role_player' | 'judge' {
  if (value !== 'role_player' && value !== 'judge') {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion purpose is invalid.',
    );
  }
}

function assertModel(model: ModelRefV1, providerId: string): void {
  if (
    !model ||
    model.provider !== providerId ||
    !isSafeMetadata(model.model, 1_024)
  ) {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion model does not match this provider.',
    );
  }
  if (!supportsAnthropicStructuredOutputModel(model.model)) {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic Forge completions require Claude 4.5 or newer structured outputs.',
    );
  }
}

function validateRequest(request: CompletionRequest): void {
  if (!isSafeMetadata(request.runId, 1_024)) {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion runId is invalid.',
    );
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion requires at least one message.',
    );
  }
  for (const message of request.messages) {
    if (
      !message ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      message.content.length === 0 ||
      Buffer.byteLength(message.content, 'utf8') >
        ANTHROPIC_MAX_MESSAGE_BYTES ||
      message.content.includes('\0')
    ) {
      throw new AnthropicCompletionError(
        'invalid_request',
        'Anthropic completion contains an invalid message.',
      );
    }
  }
  if (
    request.systemPrompt !== undefined &&
    (request.systemPrompt.length === 0 ||
      Buffer.byteLength(request.systemPrompt, 'utf8') >
        ANTHROPIC_MAX_MESSAGE_BYTES ||
      request.systemPrompt.includes('\0'))
  ) {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion system prompt is invalid.',
    );
  }
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 1)
  ) {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion temperature must be between 0 and 1.',
    );
  }
  if (
    request.maxTokens !== undefined &&
    (!Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens <= 0 ||
      request.maxTokens > ANTHROPIC_MAX_TOKENS)
  ) {
    throw new AnthropicCompletionError(
      'invalid_request',
      `Anthropic completion maxTokens must be an integer from 1 to ${ANTHROPIC_MAX_TOKENS}.`,
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
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion response schema is invalid.',
    );
  }
  try {
    assertJsonValue(schema.schema, new Set(), { nodes: 0 }, 0);
  } catch {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion response schema is not bounded JSON.',
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
    throw new AnthropicCompletionError(
      'invalid_credentials',
      'Anthropic completion credentials are missing or invalid.',
    );
  }
  return value;
}

function effectiveMaxTokens(request: CompletionRequest): number {
  const requested = request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  return alwaysThinksAnthropicModel(request.model.model)
    ? Math.max(requested, ANTHROPIC_ALWAYS_THINKING_MIN_MAX_TOKENS)
    : requested;
}

function serializeRequest(request: CompletionRequest): string {
  try {
    const serialized = JSON.stringify({
      model: request.model.model,
      max_tokens: effectiveMaxTokens(request),
      messages: request.messages,
      ...(request.systemPrompt === undefined
        ? {}
        : { system: request.systemPrompt }),
      ...(request.temperature === undefined ||
      !acceptsAnthropicSamplingTemperature(request.model.model)
        ? {}
        : { temperature: request.temperature }),
      ...(request.responseSchema === undefined
        ? {}
        : {
            output_config: {
              format: {
                type: ANTHROPIC_STRUCTURED_OUTPUT_FORMAT,
                schema: projectAnthropicSchema(request.responseSchema.schema),
              },
            },
          }),
    });
    if (Buffer.byteLength(serialized, 'utf8') > ANTHROPIC_MAX_REQUEST_BYTES) {
      throw new TypeError('Request exceeds its byte limit.');
    }
    return serialized;
  } catch {
    throw new AnthropicCompletionError(
      'invalid_request',
      'Anthropic completion request could not be serialized.',
    );
  }
}

/**
 * Anthropic's constrained-decoding grammar omits several validation-only JSON
 * Schema keywords. Forge retains them in its provider-neutral request and
 * enforces them locally, while projecting only the supported grammar here.
 */
function projectAnthropicSchema(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === 'minItems' && value !== 0 && value !== 1) continue;
    if (
      (key === 'properties' ||
        key === 'patternProperties' ||
        key === '$defs' ||
        key === 'definitions') &&
      isRecord(value)
    ) {
      projected[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          isRecord(child) ? projectAnthropicSchema(child) : child,
        ]),
      );
      continue;
    }
    if (
      (key === 'items' ||
        key === 'contains' ||
        key === 'not' ||
        key === 'if' ||
        key === 'then' ||
        key === 'else' ||
        key === 'propertyNames') &&
      isRecord(value)
    ) {
      projected[key] = projectAnthropicSchema(value);
      continue;
    }
    if (
      (key === 'allOf' ||
        key === 'anyOf' ||
        key === 'oneOf' ||
        key === 'prefixItems') &&
      Array.isArray(value)
    ) {
      projected[key] = value.map((child) =>
        isRecord(child) ? projectAnthropicSchema(child) : child,
      );
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AnthropicCompletionError(
      'invalid_response',
      'Anthropic completion returned an empty response body.',
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    signal.throwIfAborted();
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > ANTHROPIC_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AnthropicCompletionError(
        'response_too_large',
        'Anthropic completion response exceeded its byte limit.',
      );
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
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
    value.type !== 'message' ||
    value.role !== 'assistant'
  ) {
    throw invalidResponse();
  }
  if (!Array.isArray(value.content) || value.content.length === 0) {
    throw invalidResponse();
  }
  const text: string[] = [];
  for (const block of value.content) {
    // Thinking blocks carry no answer (their text is omitted by default).
    if (
      isRecord(block) &&
      (block.type === 'thinking' || block.type === 'redacted_thinking')
    )
      continue;
    if (
      !isRecord(block) ||
      block.type !== 'text' ||
      typeof block.text !== 'string'
    ) {
      throw invalidResponse();
    }
    text.push(block.text);
  }
  const content = text.join('');
  if (structured) {
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
  const cacheCreation = optionalNonnegativeInteger(
    usage.cache_creation_input_tokens,
  );
  const cacheRead = optionalNonnegativeInteger(usage.cache_read_input_tokens);
  if (
    input === undefined ||
    output === undefined ||
    cacheCreation === undefined ||
    cacheRead === undefined
  ) {
    throw invalidResponse();
  }
  const totalInput = input + cacheCreation + cacheRead;
  if (!Number.isSafeInteger(totalInput)) throw invalidResponse();
  const stopReason = normalizeStopReason(value.stop_reason);
  if (stopReason === undefined) throw invalidResponse();
  const costUsd = optionalCost(usage.cost_usd);
  if (costUsd === null) throw invalidResponse();
  return Object.freeze({
    content,
    stopReason,
    usage: Object.freeze({
      inputTokens: totalInput,
      outputTokens: output,
      cachedInputTokens: cacheRead,
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

function normalizeStopReason(value: unknown): CompletionStopReason | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  switch (value) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
    case 'refusal':
    case 'model_context_window_exceeded':
      return value;
    default:
      return 'other';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): AnthropicCompletionError {
  return new AnthropicCompletionError(
    'invalid_response',
    'Anthropic completion returned an invalid response.',
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AnthropicCompletionError(
      'aborted',
      'Anthropic completion request was aborted.',
    );
  }
}

function transportError(
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): AnthropicCompletionError {
  if (callerSignal.aborted) {
    return new AnthropicCompletionError(
      'aborted',
      'Anthropic completion request was aborted.',
    );
  }
  if (timeoutSignal.aborted) {
    return new AnthropicCompletionError(
      'timeout',
      'Anthropic completion request timed out.',
    );
  }
  return new AnthropicCompletionError(
    'transport_error',
    'Anthropic completion transport failed.',
  );
}
