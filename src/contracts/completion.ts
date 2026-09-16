import type {ModelRefV1} from '../model/types.js';

export interface CompletionMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly model: ModelRefV1;
  readonly messages: readonly CompletionMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface CompletionResponse {
  readonly content: string;
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

export interface CompletionProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Resolve a provider without teaching the lifecycle provider-specific names. */
export interface CompletionProviderResolver {
  resolve(model: ModelRefV1): CompletionProvider;
}
