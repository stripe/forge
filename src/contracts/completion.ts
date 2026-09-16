import type {CredentialRequirement} from './credentials.js';
import type {ModelRefV1} from '../model/types.js';

/** Score-affecting reason a host completion is requested. */
export type CompletionPurpose = 'role_player' | 'judge';

/** System instructions are carried separately from conversation history. */
export interface CompletionMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A named strict JSON Schema requested from the completion provider. */
export interface StrictCompletionResponseSchema {
  readonly name: string;
  readonly description?: string;
  readonly strict: true;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  readonly runId: string;
  readonly purpose: CompletionPurpose;
  readonly model: ModelRefV1;
  readonly systemPrompt?: string;
  readonly messages: readonly CompletionMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseSchema?: StrictCompletionResponseSchema;
  readonly signal: AbortSignal;
}

/** Provider-neutral, bounded reason that a completion stopped. */
export type CompletionStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded'
  | 'other';

export interface CompletionUsage {
  /** Total input tokens, including cache creation and cache reads. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from an existing provider cache. */
  readonly cachedInputTokens: number;
}

export interface CompletionResponse {
  readonly content: string;
  readonly stopReason: CompletionStopReason;
  readonly usage: CompletionUsage;
  readonly costUsd?: number;
}

/** Pure, authority-free declaration made before credential resolution. */
export interface CompletionProviderRequirements {
  readonly credentials: Readonly<Record<string, CredentialRequirement>>;
}

export interface CompletionProviderRequirementInput {
  readonly model: ModelRefV1;
  readonly purpose: CompletionPurpose;
}

/** Resolved values remain provider-owned and never enter plans or results. */
export type CompletionProviderCredentials = Readonly<Record<string, string>>;

export interface CompletionProviderPreflightInput {
  readonly runId: string;
  readonly model: ModelRefV1;
  readonly purpose: CompletionPurpose;
  readonly credentials: CompletionProviderCredentials;
  readonly signal: AbortSignal;
}

export interface CompletionProviderCallContext {
  readonly credentials: CompletionProviderCredentials;
}

export interface CompletionProvider {
  readonly id: string;
  readonly version: string;
  requirements(
    input: CompletionProviderRequirementInput,
  ): CompletionProviderRequirements;
  preflight?(input: CompletionProviderPreflightInput): Promise<void>;
  complete(
    request: CompletionRequest,
    context: CompletionProviderCallContext,
  ): Promise<CompletionResponse>;
}

/** Resolve a provider without teaching the lifecycle provider-specific names. */
export interface CompletionProviderResolver {
  resolve(model: ModelRefV1): CompletionProvider;
}
