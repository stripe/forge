import { z } from 'zod';
import type { StrictCompletionResponseSchema } from '../contracts/completion.ts';
import type {
  ChoiceAnswer,
  ChoiceAssessment,
  DecisionRequest,
} from '../contracts/decision.ts';

export const MAX_DECISION_EXPLANATION_CHARACTERS = 64 * 1024;
export const MAX_ASSESSMENT_ARGUMENT_CHARACTERS = 4 * 1024;
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
  'assessments',
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
  // SystemOne answers carry `confidence` and no explanation; LLM answers the
  // reverse. Verbalized answers state per-option probabilities in `assessments`.
  requireDecisionKeys(
    value,
    ['type', 'choice'],
    [
      'type',
      'choice',
      'probabilities',
      'confidence',
      'explanation',
      'assessments',
    ],
  );
  if (value.type !== 'choice') throw new InvalidDecisionResponseError();
  if (typeof value.choice !== 'string' || !options.includes(value.choice))
    throw new InvalidDecisionResponseError('unknown_choice');
  const assessments =
    value.assessments === undefined
      ? undefined
      : parseAssessments(value.assessments, options);
  let probabilities: Record<string, number>;
  if (value.probabilities !== undefined)
    probabilities = parseProbabilities(value.probabilities, options);
  else if (assessments !== undefined) probabilities = assessments.probabilities;
  else throw new InvalidDecisionResponseError('invalid_schema');
  if (
    assessments !== undefined &&
    options.some(
      (option) =>
        Math.abs(probabilities[option]! - assessments.probabilities[option]!) >
        DECISION_PROBABILITY_TOLERANCE,
    )
  )
    throw new InvalidDecisionResponseError('assessments');
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
    ...(assessments === undefined
      ? {}
      : { assessments: assessments.assessments }),
  };
}

/** A complete distribution; rounded sums within tolerance are normalized. */
function parseProbabilities(
  value: unknown,
  options: readonly string[],
): Record<string, number> {
  requireDecisionKeys(value, options, options, 'missing_option');
  const values = options.map((option) => value[option]);
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
  return Object.fromEntries(
    options.map((option, index) => [option, values[index]! / sum]),
  );
}

/**
 * One assessment per option. Each probability is stated per option, so their
 * sum is not required to be 1; the distribution is their normalization.
 */
function parseAssessments(
  value: unknown,
  options: readonly string[],
): {
  assessments: Record<string, ChoiceAssessment>;
  probabilities: Record<string, number>;
} {
  requireDecisionKeys(value, options, options, 'missing_option');
  const argument = z
    .string()
    .trim()
    .min(1)
    .max(MAX_ASSESSMENT_ARGUMENT_CHARACTERS);
  const assessments: Record<string, ChoiceAssessment> = {};
  for (const option of options) {
    const entry = value[option];
    requireDecisionKeys(entry, ['for', 'against', 'probability']);
    const p = entry.probability;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
      throw new InvalidDecisionResponseError('probability_range');
    const reasons = [
      argument.safeParse(entry.for),
      argument.safeParse(entry.against),
    ];
    if (!reasons.every((reason) => reason.success))
      throw new InvalidDecisionResponseError('assessments');
    assessments[option] = {
      for: reasons[0]!.data!,
      against: reasons[1]!.data!,
      probability: p,
    };
  }
  const sum = options.reduce(
    (total, option) => total + assessments[option]!.probability,
    0,
  );
  if (sum <= 0) throw new InvalidDecisionResponseError('probabilities_sum');
  return {
    assessments,
    probabilities: Object.fromEntries(
      options.map((option) => [option, assessments[option]!.probability / sum]),
    ),
  };
}

/**
 * How an LLM judge answers: `standard` states one distribution and an
 * explanation; `verbalized` first argues every option and states a probability
 * for each, and the distribution is their normalization.
 */
export type DecisionJudgeMode = 'standard' | 'verbalized';
export const DECISION_JUDGE_MODES: readonly DecisionJudgeMode[] = [
  'standard',
  'verbalized',
];

export function decisionResponseSchema(
  questions: DecisionRequest['questions'],
  mode: DecisionJudgeMode = 'standard',
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
                mode === 'verbalized'
                  ? verbalizedAnswerSchema(options)
                  : standardAnswerSchema(options),
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

const explanationSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_DECISION_EXPLANATION_CHARACTERS,
} as const;

function standardAnswerSchema(options: readonly string[]) {
  return {
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
      explanation: explanationSchema,
    },
    required: ['type', 'choice', 'probabilities', 'explanation'],
    additionalProperties: false,
  };
}

/** Assessments precede the choice, so each option is argued before deciding. */
function verbalizedAnswerSchema(options: readonly string[]) {
  const argument = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_ASSESSMENT_ARGUMENT_CHARACTERS,
  };
  return {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'choice' },
      assessments: {
        type: 'object',
        properties: Object.fromEntries(
          options.map((option) => [
            option,
            {
              type: 'object',
              properties: {
                for: argument,
                against: argument,
                probability: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['for', 'against', 'probability'],
              additionalProperties: false,
            },
          ]),
        ),
        required: options,
        additionalProperties: false,
      },
      choice: { type: 'string', enum: options },
      explanation: explanationSchema,
    },
    required: ['type', 'assessments', 'choice', 'explanation'],
    additionalProperties: false,
  };
}
