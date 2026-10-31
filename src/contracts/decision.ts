import type { ModelRefV1 } from '../model/types.ts';
import type { CompletionUsage } from './completion.ts';

export interface ChoiceQuestion<Option extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<Option, string>>;
}

/** The tagged question/answer unions currently support Choice only. */
export type DecisionQuestion = ChoiceQuestion;

/**
 * One option's verbalized assessment: the strongest evidence for and against
 * it, then the probability stated for it before any option is chosen.
 */
export interface ChoiceAssessment {
  readonly for: string;
  readonly against: string;
  readonly probability: number;
}

/**
 * One Choice answer in the SystemOne shape (`type`, `choice`, `probabilities`,
 * `confidence`), so decision-model and LLM-backed implementations are
 * interchangeable. Decision models return no explanation.
 */
export interface ChoiceAnswer<Option extends string = string> {
  readonly type: 'choice';
  /** An option with the highest probability. */
  readonly choice: Option;
  readonly probabilities: Readonly<Record<Option, number>>;
  /**
   * Certainty from 0 to 1, not a claim of correctness. A model may report it
   * independently; otherwise it is the largest option probability.
   */
  readonly confidence: number;
  readonly explanation?: string;
  /**
   * Verbalized assessments, one per option, from judges asked to argue each
   * option before deciding. `probabilities` is their normalized distribution.
   * Decision models omit them.
   */
  readonly assessments?: Readonly<Record<Option, ChoiceAssessment>>;
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
