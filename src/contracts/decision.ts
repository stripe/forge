import type { ModelRefV1 } from '../model/types.ts';
import type { CompletionUsage } from './completion.ts';

export interface ChoiceQuestion<Option extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<Option, string>>;
}

/** The tagged question/answer unions currently support Choice only. */
export type DecisionQuestion = ChoiceQuestion;

export interface ChoiceAnswer<Option extends string = string> {
  readonly type: 'choice';
  readonly choice: Option;
  readonly probabilities: Readonly<Record<Option, number>>;
  /** Largest option probability: concentration, not a claim of correctness. */
  readonly confidence: number;
  readonly explanation: string;
}

export type DecisionAnswer = ChoiceAnswer;

export interface DecisionRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly signal: AbortSignal;
  readonly retryOrdinal?: number;
}

export interface DecisionResponse {
  /** Optional host information; criterion judging does not consume or record it. */
  readonly model?: ModelRefV1 | null;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** Optional host information; execution records usage through its completion runtime. */
  readonly usage?: CompletionUsage | null;
}

/** Independent of completion transports, credentials, and Forge scoring. */
export interface DecisionModel {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}
