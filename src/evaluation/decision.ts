import { z } from 'zod';
import type { StrictCompletionResponseSchema } from '../contracts/completion.ts';
import {
  type DecisionJudgeMethod,
  MAX_VERBALIZED_SAMPLING_CANDIDATES,
} from '../model/judgeMethod.ts';

export const MAX_DECISION_EXPLANATION_CHARACTERS = 64 * 1024;
export const MAX_ASSESSMENT_ARGUMENT_CHARACTERS = 4 * 1024;
/** Canonical saved distributions and near-tie comparisons. */
export const DECISION_PROBABILITY_TOLERANCE = 0.000001;

export interface ChoiceQuestion<Option extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<Option, string>>;
}

/**
 * One verbalized-sampling candidate: a complete answer (how it reads the
 * question and state, why, and the option it selects) with its probability.
 */
export interface ChoiceCandidate<Option extends string = string> {
  readonly reading: string;
  readonly rationale: string;
  readonly label: Option;
  readonly probability: number;
}

export interface ChoiceAnswer<Option extends string = string> {
  readonly type: 'choice';
  /** An option with the highest probability. */
  readonly choice: Option;
  readonly probabilities: Readonly<Record<Option, number>>;
  /** Certainty from 0 to 1: the largest option probability unless reported. */
  readonly confidence: number;
  readonly explanation?: string;
  /**
   * Verbalized-sampling candidates. `probabilities` sums them per option and
   * the choice is its maximum.
   */
  readonly candidates: readonly ChoiceCandidate<Option>[];
}

export const DECISION_REJECTION_REASONS = [
  'invalid_json',
  'invalid_schema',
  'unknown_key',
  'missing_answer',
  'missing_option',
  'probability_range',
  'probabilities_sum',
  'choice_not_argmax',
  'unknown_choice',
  'explanation',
  'candidates',
] as const;
export type DecisionRejectionReason =
  (typeof DECISION_REJECTION_REASONS)[number];

export class InvalidDecisionResponseError extends Error {
  constructor(readonly reason: DecisionRejectionReason = 'invalid_schema') {
    super(
      reason === 'invalid_json'
        ? 'Judge response was not valid JSON.'
        : `Judge response rejected: ${reason}.`,
    );
    this.name = 'InvalidDecisionResponseError';
  }
}

/** A dispatch check failed; the request must not be retried. */
export class DecisionDispatchError extends Error {
  constructor(readonly failure: unknown) {
    super('Decision request validation failed.');
  }
}

/** A saved distribution sums to 1, names a maximal choice, and is in range. */
export function choiceDistributionIsValid(
  answer: Pick<ChoiceAnswer, 'choice' | 'probabilities' | 'confidence'>,
): boolean {
  const values = Object.values(answer.probabilities);
  const maximum = Math.max(...values);
  return (
    values.length > 0 &&
    values.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <=
      DECISION_PROBABILITY_TOLERANCE &&
    Object.hasOwn(answer.probabilities, answer.choice) &&
    maximum - answer.probabilities[answer.choice]! <=
      DECISION_PROBABILITY_TOLERANCE &&
    Number.isFinite(answer.confidence) &&
    answer.confidence >= 0 &&
    answer.confidence <= 1
  );
}

function isDecisionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireDecisionKeys(
  value: unknown,
  required: readonly string[],
  allowed = required,
  missing: DecisionRejectionReason = 'invalid_schema',
): asserts value is Record<string, unknown> {
  if (!isDecisionRecord(value)) throw new InvalidDecisionResponseError();
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new InvalidDecisionResponseError('unknown_key');
  if (required.some((key) => !Object.hasOwn(value, key)))
    throw new InvalidDecisionResponseError(missing);
}

function parseChoiceAnswer(
  value: unknown,
  options: readonly string[],
): ChoiceAnswer {
  // A sampling answer lists `candidates` and leaves the choice to the
  // aggregated distribution; a stated choice must agree with it.
  requireDecisionKeys(
    value,
    ['type', 'candidates'],
    ['type', 'choice', 'confidence', 'explanation', 'candidates'],
  );
  if (value.type !== 'choice') throw new InvalidDecisionResponseError();
  const { candidates, probabilities: aggregated } = parseCandidates(
    value.candidates,
    options,
  );
  const maximum = Math.max(...Object.values(aggregated));
  let choice: string;
  if (value.choice !== undefined) {
    if (typeof value.choice !== 'string' || !options.includes(value.choice))
      throw new InvalidDecisionResponseError('unknown_choice');
    if (maximum - aggregated[value.choice]! > DECISION_PROBABILITY_TOLERANCE)
      throw new InvalidDecisionResponseError('choice_not_argmax');
    choice = value.choice;
  } else choice = sampledChoice(aggregated, maximum, candidates);
  // The saved distribution is the aggregate renormalized to sum to exactly
  // one, as sampling judgments have always been saved. Confidence stays the
  // aggregate's maximum, so the two can differ in the last digits.
  const total = options.reduce((sum, option) => sum + aggregated[option]!, 0);
  const probabilities = Object.fromEntries(
    options.map((option) => [option, aggregated[option]! / total]),
  );
  let confidence = maximum;
  if (value.confidence !== undefined) {
    if (
      typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1
    )
      throw new InvalidDecisionResponseError('probability_range');
    confidence = value.confidence;
  }
  let explanation: string | undefined;
  if (value.explanation !== undefined) {
    const parsed = z
      .string()
      .trim()
      .min(1)
      .max(MAX_DECISION_EXPLANATION_CHARACTERS)
      .safeParse(value.explanation);
    if (!parsed.success) throw new InvalidDecisionResponseError('explanation');
    explanation = parsed.data;
  }
  return {
    type: 'choice',
    choice,
    probabilities,
    confidence,
    ...(explanation === undefined ? {} : { explanation }),
    candidates,
  };
}

/**
 * The aggregated maximum. A tie goes to the single most probable candidate's
 * label; a tie there too is rejected rather than broken by option order, so
 * no option is favored.
 */
function sampledChoice(
  probabilities: Record<string, number>,
  maximum: number,
  candidates: readonly ChoiceCandidate[],
): string {
  const tied = Object.keys(probabilities).filter(
    (option) =>
      maximum - probabilities[option]! <= DECISION_PROBABILITY_TOLERANCE,
  );
  if (tied.length === 1) return tied[0]!;
  const best = Math.max(
    ...candidates.map((candidate) => candidate.probability),
  );
  const leaders = new Set(
    candidates
      .filter(
        (candidate) =>
          best - candidate.probability <= DECISION_PROBABILITY_TOLERANCE &&
          tied.includes(candidate.label),
      )
      .map((candidate) => candidate.label),
  );
  if (leaders.size !== 1)
    throw new InvalidDecisionResponseError('choice_not_argmax');
  return [...leaders][0]!;
}

/**
 * Verbalized sampling: complete candidate answers with stated probabilities.
 * Each option's probability is the normalized sum over candidates selecting it.
 * The count is bounded here; the request schema asks for the chosen count.
 */
function parseCandidates(
  value: unknown,
  options: readonly string[],
): {
  candidates: ChoiceCandidate[];
  probabilities: Record<string, number>;
} {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_VERBALIZED_SAMPLING_CANDIDATES
  )
    throw new InvalidDecisionResponseError('candidates');
  const text = z.string().trim().min(1).max(MAX_ASSESSMENT_ARGUMENT_CHARACTERS);
  const candidates = value.map((entry): ChoiceCandidate => {
    requireDecisionKeys(entry, [
      'reading',
      'rationale',
      'label',
      'probability',
    ]);
    if (typeof entry.label !== 'string' || !options.includes(entry.label))
      throw new InvalidDecisionResponseError('unknown_choice');
    const p = entry.probability;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
      throw new InvalidDecisionResponseError('probability_range');
    const reading = text.safeParse(entry.reading);
    const rationale = text.safeParse(entry.rationale);
    if (!reading.success || !rationale.success)
      throw new InvalidDecisionResponseError('candidates');
    return {
      reading: reading.data,
      rationale: rationale.data,
      label: entry.label,
      probability: p,
    };
  });
  const sum = candidates.reduce((total, c) => total + c.probability, 0);
  if (sum <= 0) throw new InvalidDecisionResponseError('probabilities_sum');
  return {
    candidates,
    probabilities: Object.fromEntries(
      options.map((option) => [
        option,
        candidates
          .filter((candidate) => candidate.label === option)
          .reduce((total, candidate) => total + candidate.probability, 0) / sum,
      ]),
    ),
  };
}

export function decisionResponseSchema(
  questions: Readonly<Record<string, ChoiceQuestion>>,
  method: DecisionJudgeMethod,
): StrictCompletionResponseSchema {
  return {
    name: 'choice_decision',
    description: 'Choice answers keyed by the requested question IDs.',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(questions).map(([id, question]) => [
              id,
              verbalizedSamplingAnswerSchema(
                Object.keys(question.criteria),
                method.candidates,
              ),
            ]),
          ),
          required: Object.keys(questions),
          additionalProperties: false,
        },
      },
      required: ['answers'],
      additionalProperties: false,
    },
  };
}

export function parseDecisionAnswers(
  value: unknown,
  questions: Readonly<Record<string, ChoiceQuestion>>,
): Record<string, ChoiceAnswer> {
  requireDecisionKeys(value, ['answers']);
  requireDecisionKeys(
    value.answers,
    Object.keys(questions),
    undefined,
    'missing_answer',
  );
  const answers = value.answers;
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const choices = Object.keys(question.criteria);
      if (choices.length === 0)
        throw new TypeError('Choice questions require options.');
      return [id, parseChoiceAnswer(answers[id], choices)];
    }),
  );
}

/** Candidates only: the choice is derived, so the model never restates it. */
function verbalizedSamplingAnswerSchema(
  options: readonly string[],
  count: number,
) {
  const text = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_ASSESSMENT_ARGUMENT_CHARACTERS,
  };
  return {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'choice' },
      candidates: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          properties: {
            reading: text,
            rationale: text,
            label: { type: 'string', enum: options },
            probability: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['reading', 'rationale', 'label', 'probability'],
          additionalProperties: false,
        },
      },
    },
    required: ['type', 'candidates'],
    additionalProperties: false,
  };
}
