import type {
  CompletionMessage,
  CompletionResponse,
  StrictCompletionResponseSchema,
} from '../contracts/completion.ts';

export type InteractionHistoryMessage = CompletionMessage & {
  readonly role: 'user' | 'assistant';
};

/**
 * Model-neutral completion request emitted by engine-owned interaction logic.
 *
 * The caller binds the selected provider/model and any host credentials. Keeping
 * the system prompt separate makes that binding mechanical and prevents the
 * role-player from selecting its own model or transport.
 */
export interface InteractionCompletionRequest {
  readonly systemPrompt: string;
  readonly messages: readonly InteractionHistoryMessage[];
  readonly maxTokens: number;
  readonly responseSchema: StrictCompletionResponseSchema;
  readonly signal: AbortSignal;
  readonly retryOrdinal?: number;
}

export type InteractionCompletionInvoker = (
  request: InteractionCompletionRequest,
) => Promise<CompletionResponse>;
