import type {
  CompletionProvider,
  CompletionProviderCredentials,
  CompletionProviderRequirements,
  CompletionPurpose,
  CompletionRequest,
  CompletionResponse,
  CompletionStopReason,
  StrictCompletionResponseSchema,
} from '../contracts/completion.ts';
import type {
  CompletionProviderCollection,
  ForgeComposition,
} from '../contracts/composition.ts';
import type {
  CredentialReference,
  CredentialResolver,
} from '../contracts/credentials.ts';
import {
  type CompletionProviderMetadata,
  completionProviderMetadataSchema,
} from '../contracts/metadata.ts';
import type { ModelRefV1, ResolvedRunPlanV1 } from '../model/types.ts';
import type { CompletionCallSummaryV1 } from '../results/types.ts';
import { boundedErrorMessage } from '../security/errorMessage.ts';
import { redactSecrets } from '../security/redaction.ts';

const SAFE_PROVIDER_METADATA = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,255}$/;
const SAFE_CREDENTIAL_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MAX_COMPLETION_CONTENT_BYTES = 1024 * 1024;
const COMPLETION_STOP_REASONS = new Set<CompletionStopReason>([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
  'other',
]);

export interface CompletionPromptInput {
  readonly systemPrompt?: string;
  readonly messages: CompletionRequest['messages'];
  readonly maxTokens?: number;
  readonly responseSchema?: StrictCompletionResponseSchema;
}

export interface CompletionBinding {
  readonly purpose: CompletionPurpose;
  readonly model: ModelRefV1;
  readonly provider: CompletionProvider;
  readonly identity: {
    readonly id: string;
    readonly version: string;
    readonly metadata?: CompletionProviderMetadata;
  };
  readonly requirements: CompletionProviderRequirements;
}

export interface PreparedCompletionRuntime {
  readonly secrets: readonly string[];
  readonly calls: readonly CompletionCallSummaryV1[];
  has(purpose: CompletionPurpose): boolean;
  model(purpose: CompletionPurpose): ModelRefV1;
  provider(purpose: CompletionPurpose): CompletionProvider;
  invoke(
    purpose: CompletionPurpose,
    prompt: CompletionPromptInput,
    signal: AbortSignal,
  ): Promise<CompletionResponse>;
}

export class CompletionConfigurationError extends Error {
  readonly code = 'completion_configuration_error' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CompletionConfigurationError';
  }
}

/** Pure provider selection and requirement validation for one resolved plan. */
export function completionBindingsForPlan(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
): readonly CompletionBinding[] {
  const requested: Array<{ purpose: CompletionPurpose; model: ModelRefV1 }> =
    [];
  if (plan.role_player !== undefined) {
    requested.push({ purpose: 'role_player', model: plan.role_player });
  }
  if (plan.evaluation.judge !== undefined) {
    requested.push({ purpose: 'judge', model: plan.evaluation.judge });
  }
  if (requested.length === 0) return Object.freeze([]);

  const collection = composition.completionProviders;
  if (collection === undefined) {
    throw new CompletionConfigurationError(
      'The run plan requires completion providers, but none are registered.',
    );
  }

  return Object.freeze(
    requested.map(({ purpose, model }) => {
      const provider = resolveProvider(collection, model);
      assertProvider(provider, model);
      const metadata = completionProviderMetadataSchema
        .optional()
        .parse(provider.metadata);
      const identity = Object.freeze({
        id: provider.id,
        version: provider.version,
        ...(metadata === undefined ? {} : { metadata }),
      });
      const requirements = normalizeRequirements(
        provider.requirements({ model, purpose }),
      );
      return Object.freeze({
        purpose,
        model: Object.freeze({ ...model }),
        provider,
        identity,
        requirements,
      });
    }),
  );
}

/** Resolve provider-owned credentials and run optional preflight before Docker. */
export async function prepareCompletionRuntime(input: {
  readonly runId: string;
  readonly bindings: readonly CompletionBinding[];
  readonly credentialResolver: CredentialResolver;
  /** Other resolved run credentials which must be redacted from prompts. */
  readonly redactionSecrets?: readonly string[];
  readonly signal: AbortSignal;
}): Promise<PreparedCompletionRuntime> {
  const prepared = new Map<
    CompletionPurpose,
    {
      binding: CompletionBinding;
      credentials: CompletionProviderCredentials;
    }
  >();
  const secrets: string[] = [];
  for (const value of input.redactionSecrets ?? []) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0')
    ) {
      throw new TypeError(
        'Completion redaction secrets must be non-empty strings.',
      );
    }
    if (!secrets.includes(value)) secrets.push(value);
  }

  for (const binding of input.bindings) {
    input.signal.throwIfAborted();
    const credentials: Record<string, string> = {};
    for (const [name, requirement] of Object.entries(
      binding.requirements.credentials,
    )) {
      // Resolve independently for each score-affecting capability. A resolver
      // may authorize the same opaque reference differently by purpose.
      const value = await resolveCredential(
        input.credentialResolver,
        requirement.reference,
        input.runId,
        binding.purpose,
        name,
        input.signal,
      );
      defineRecordValue(credentials, name, value);
      if (!secrets.includes(value)) secrets.push(value);
    }
    const frozenCredentials = Object.freeze(credentials);
    if (binding.provider.preflight !== undefined) {
      await binding.provider.preflight({
        runId: input.runId,
        model: binding.model,
        purpose: binding.purpose,
        credentials: frozenCredentials,
        signal: input.signal,
      });
    }
    prepared.set(binding.purpose, { binding, credentials: frozenCredentials });
  }

  const callSlots: Array<CompletionCallSummaryV1 | undefined> = [];
  const required = (purpose: CompletionPurpose) => {
    const selected = prepared.get(purpose);
    if (selected === undefined) {
      throw new CompletionConfigurationError(
        `No prepared completion provider exists for ${purpose}.`,
      );
    }
    return selected;
  };

  return Object.freeze({
    secrets: Object.freeze([...secrets]),
    get calls() {
      return Object.freeze(
        callSlots.map((call) => {
          if (call === undefined) {
            throw new Error('A completion call is still in progress.');
          }
          return call;
        }),
      );
    },
    has: (purpose: CompletionPurpose) => prepared.has(purpose),
    model: (purpose: CompletionPurpose) => required(purpose).binding.model,
    provider: (purpose: CompletionPurpose) =>
      required(purpose).binding.provider,
    async invoke(
      purpose: CompletionPurpose,
      prompt: CompletionPromptInput,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const selected = required(purpose);
      const redactedPrompt = redactCompletionPrompt(prompt, secrets);
      const sequence = callSlots.length + 1;
      callSlots.push(undefined);
      try {
        const completed = await selected.binding.provider.complete(
          {
            runId: input.runId,
            purpose,
            model: selected.binding.model,
            ...redactedPrompt,
            signal,
          },
          { credentials: selected.credentials },
        );
        signal.throwIfAborted();
        const response = validateCompletionResponse(completed);
        const redactedResponse = redactSecrets(response.content, secrets);
        const safeResponse = Object.freeze({
          ...response,
          content: redactedResponse.value,
        });
        callSlots[sequence - 1] = completionCallSummary(
          sequence,
          selected.binding,
          'succeeded',
          safeResponse,
        );
        return safeResponse;
      } catch (error) {
        const errorCode = completionErrorCode(error, secrets);
        callSlots[sequence - 1] = completionCallSummary(
          sequence,
          selected.binding,
          'failed',
          undefined,
          errorCode,
        );
        if (signal.aborted) throw abortReason(signal);
        throw new CompletionInvocationError(
          errorCode,
          boundedErrorMessage(
            error,
            'Completion provider call failed.',
            secrets,
          ),
        );
      }
    },
  });
}

class CompletionInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompletionInvocationError';
  }
}

function resolveProvider(
  collection: CompletionProviderCollection,
  model: ModelRefV1,
): CompletionProvider {
  const provider =
    'resolve' in collection
      ? collection.resolve(model)
      : collection.get(model.provider);
  if (provider === undefined) {
    throw new CompletionConfigurationError(
      `No completion provider is registered for ${model.provider}.`,
    );
  }
  return provider;
}

function assertProvider(provider: CompletionProvider, model: ModelRefV1): void {
  if (provider.id !== model.provider) {
    throw new CompletionConfigurationError(
      `Completion provider ${provider.id} cannot serve ${model.provider}.`,
    );
  }
  if (
    !SAFE_PROVIDER_METADATA.test(provider.id) ||
    !SAFE_PROVIDER_METADATA.test(provider.version)
  ) {
    throw new CompletionConfigurationError(
      'Completion provider identifiers and versions must be bounded safe metadata.',
    );
  }
  if (
    typeof provider.requirements !== 'function' ||
    typeof provider.complete !== 'function'
  ) {
    throw new CompletionConfigurationError(
      'Completion provider methods are invalid.',
    );
  }
}

function normalizeRequirements(
  requirements: CompletionProviderRequirements,
): CompletionProviderRequirements {
  if (
    !requirements ||
    typeof requirements !== 'object' ||
    Array.isArray(requirements)
  ) {
    throw new CompletionConfigurationError(
      'Completion provider requirements are invalid.',
    );
  }
  const credentials: Record<string, { reference: CredentialReference }> = {};
  for (const [name, requirement] of Object.entries(
    requirements.credentials ?? {},
  )) {
    if (!SAFE_CREDENTIAL_NAME.test(name)) {
      throw new CompletionConfigurationError(
        `Completion credential name is invalid: ${name}.`,
      );
    }
    if (
      requirement === null ||
      typeof requirement !== 'object' ||
      typeof requirement.reference !== 'string' ||
      requirement.reference.length === 0 ||
      requirement.reference.includes('\0')
    ) {
      throw new CompletionConfigurationError(
        `Completion credential requirement ${name} is invalid.`,
      );
    }
    defineRecordValue(
      credentials,
      name,
      Object.freeze({ reference: requirement.reference }),
    );
  }
  return Object.freeze({ credentials: Object.freeze(credentials) });
}

async function resolveCredential(
  resolver: CredentialResolver,
  reference: CredentialReference,
  runId: string,
  purpose: CompletionPurpose,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const value = await resolver.resolve(reference, {
    runId,
    purpose: `forge-eval:completion:${purpose}:${name}`,
    signal,
  });
  signal.throwIfAborted();
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(
      'Credential resolver returned an invalid completion credential.',
    );
  }
  return value;
}

function redactCompletionPrompt(
  prompt: CompletionPromptInput,
  secrets: readonly string[],
): CompletionPromptInput {
  const redacted = redactSecrets(
    {
      ...(prompt.systemPrompt === undefined
        ? {}
        : { systemPrompt: prompt.systemPrompt }),
      messages: prompt.messages,
    },
    secrets,
  );
  return {
    ...prompt,
    ...redacted.value,
  };
}

function validateCompletionResponse(
  response: CompletionResponse,
): CompletionResponse {
  if (
    !response ||
    typeof response.content !== 'string' ||
    Buffer.byteLength(response.content, 'utf8') >
      MAX_COMPLETION_CONTENT_BYTES ||
    !COMPLETION_STOP_REASONS.has(response.stopReason) ||
    !response.usage ||
    !nonnegativeInteger(response.usage.inputTokens) ||
    !nonnegativeInteger(response.usage.outputTokens) ||
    !nonnegativeInteger(response.usage.cachedInputTokens) ||
    (response.costUsd !== undefined &&
      (!Number.isFinite(response.costUsd) || response.costUsd < 0))
  ) {
    throw new TypeError('Completion provider returned an invalid response.');
  }
  return response;
}

function completionCallSummary(
  sequence: number,
  binding: CompletionBinding,
  status: 'succeeded' | 'failed',
  response?: CompletionResponse,
  errorCode?: string,
): CompletionCallSummaryV1 {
  return Object.freeze({
    sequence,
    purpose: binding.purpose,
    provider: binding.identity.id,
    provider_version: binding.identity.version,
    ...(binding.identity.metadata === undefined
      ? {}
      : { provider_metadata: binding.identity.metadata }),
    model: binding.model.model,
    status,
    stop_reason: response?.stopReason ?? null,
    input_tokens: response?.usage.inputTokens ?? null,
    output_tokens: response?.usage.outputTokens ?? null,
    cached_tokens: response?.usage.cachedInputTokens ?? null,
    cost_usd: response?.costUsd ?? null,
    error_code: errorCode ?? null,
  });
}

function completionErrorCode(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (
      typeof code === 'string' &&
      SAFE_PROVIDER_METADATA.test(code) &&
      !secrets.some((secret) => code.includes(secret))
    ) {
      return code;
    }
  }
  return 'completion_failed';
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function defineRecordValue<T>(
  record: Record<string, T>,
  name: string,
  value: T,
): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
