import { z } from 'zod';
import type { StrictCompletionResponseSchema } from '../contracts/completion.ts';
import type { ChoiceAnswer, DecisionRequest } from '../contracts/decision.ts';

export const MAX_DECISION_EXPLANATION_CHARACTERS = 64 * 1024;
/** Canonical saved distributions and near-tie comparisons. */
export const DECISION_PROBABILITY_TOLERANCE = 0.000001;
/** Rounded wire distributions are normalized within this band around 1. */
export const DECISION_PROBABILITY_SUM_TOLERANCE = 0.02;

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
    // Confidence is a separate SystemOne measure; it need not equal the maximum.
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
  // SystemOne answers carry `confidence` and no explanation; LLM answers the reverse.
  requireDecisionKeys(
    value,
    ['type', 'choice', 'probabilities'],
    ['type', 'choice', 'probabilities', 'confidence', 'explanation'],
  );
  if (value.type !== 'choice') throw new InvalidDecisionResponseError();
  if (typeof value.choice !== 'string' || !options.includes(value.choice))
    throw new InvalidDecisionResponseError('unknown_choice');
  requireDecisionKeys(value.probabilities, options, options, 'missing_option');
  const weights = value.probabilities;
  const values = options.map((option) => weights[option]);
  if (
    !values.every(
      (p): p is number =>
        typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1,
    )
  )
    throw new InvalidDecisionResponseError('probability_range');
  const sum = values.reduce((total, p) => total + p, 0);
  if (Math.abs(sum - 1) > DECISION_PROBABILITY_SUM_TOLERANCE + Number.EPSILON)
    throw new InvalidDecisionResponseError('probabilities_sum');
  const probabilities = Object.fromEntries(
    options.map((option, index) => [option, values[index]! / sum]),
  );
  const maximum = Math.max(...Object.values(probabilities));
  if (maximum - probabilities[value.choice]! > DECISION_PROBABILITY_TOLERANCE)
    throw new InvalidDecisionResponseError('choice_not_argmax');
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
    choice: value.choice,
    probabilities,
    confidence,
    ...(explanation === undefined ? {} : { explanation }),
  };
}

export function decisionResponseSchema(
  questions: DecisionRequest['questions'],
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
            Object.entries(questions).map(([id, question]) => {
              const options = Object.keys(question.criteria);
              return [
                id,
                {
                  type: 'object',
                  properties: {
                    type: { type: 'string', const: 'choice' },
                    choice: { type: 'string', enum: options },
                    probabilities: {
                      type: 'object',
                      properties: Object.fromEntries(
                        options.map((option) => [
                          option,
                          { type: 'number', minimum: 0, maximum: 1 },
                        ]),
                      ),
                      required: options,
                      additionalProperties: false,
                    },
                    explanation: {
                      type: 'string',
                      minLength: 1,
                      maxLength: MAX_DECISION_EXPLANATION_CHARACTERS,
                    },
                  },
                  required: ['type', 'choice', 'probabilities', 'explanation'],
                  additionalProperties: false,
                },
              ];
            }),
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
  questions: DecisionRequest['questions'],
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
