import { z } from 'zod';
import type { StrictCompletionResponseSchema } from '../contracts/completion.ts';
import type {
  ChoiceAnswer,
  ChoiceAssessment,
  ChoiceCandidate,
  DecisionRequest,
} from '../contracts/decision.ts';

export const MAX_DECISION_EXPLANATION_CHARACTERS = 64 * 1024;
export const MAX_ASSESSMENT_ARGUMENT_CHARACTERS = 4 * 1024;
export const MIN_VERBALIZED_SAMPLING_CANDIDATES = 2;
export const MAX_VERBALIZED_SAMPLING_CANDIDATES = 10;
export const DEFAULT_VERBALIZED_SAMPLING_CANDIDATES = 5;
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
  // reverse. Option-critique answers state per-option probabilities in
  // `assessments`; verbalized-sampling answers list `candidates` and leave the
  // choice to the aggregated distribution.
  requireDecisionKeys(
    value,
    ['type'],
    [
      'type',
      'choice',
      'probabilities',
      'confidence',
      'explanation',
      'assessments',
      'candidates',
    ],
  );
  if (value.type !== 'choice') throw new InvalidDecisionResponseError();
  const assessments =
    value.assessments === undefined
      ? undefined
      : parseAssessments(value.assessments, options);
  const candidates =
    value.candidates === undefined
      ? undefined
      : parseCandidates(value.candidates, options);
  const derived = assessments?.probabilities ?? candidates?.probabilities;
  if (assessments !== undefined && candidates !== undefined)
    throw new InvalidDecisionResponseError('invalid_schema');
  let probabilities: Record<string, number>;
  if (value.probabilities !== undefined)
    probabilities = parseProbabilities(value.probabilities, options);
  else if (derived !== undefined) probabilities = derived;
  else throw new InvalidDecisionResponseError('invalid_schema');
  if (
    derived !== undefined &&
    options.some(
      (option) =>
        Math.abs(probabilities[option]! - derived[option]!) >
        DECISION_PROBABILITY_TOLERANCE,
    )
  )
    throw new InvalidDecisionResponseError(
      assessments === undefined ? 'candidates' : 'assessments',
    );
  const maximum = Math.max(...Object.values(probabilities));
  let choice: string;
  if (value.choice !== undefined) {
    if (typeof value.choice !== 'string' || !options.includes(value.choice))
      throw new InvalidDecisionResponseError('unknown_choice');
    if (maximum - probabilities[value.choice]! > DECISION_PROBABILITY_TOLERANCE)
      throw new InvalidDecisionResponseError('choice_not_argmax');
    choice = value.choice;
  } else if (candidates !== undefined) {
    choice = sampledChoice(probabilities, maximum, candidates.candidates);
  } else throw new InvalidDecisionResponseError('invalid_schema');
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
    ...(assessments === undefined
      ? {}
      : { assessments: assessments.assessments }),
    ...(candidates === undefined ? {} : { candidates: candidates.candidates }),
  };
}

/**
 * The aggregated maximum. An exact tie goes to the single most probable
 * candidate's label; a tie there too is rejected rather than broken by option
 * order, so no option is favored.
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
 * How an LLM judge answers each Choice question:
 * - `direct`: one distribution, no explanation (the SystemOne answer shape).
 * - `explained`: one distribution and one explanation (the default).
 * - `option-critique`: evidence for and against every option, with a
 *   probability per option; the distribution is their normalization.
 * - `verbalized-sampling`: `candidates` complete candidate answers with
 *   probabilities in one response; each option's probability is the sum over
 *   the candidates selecting it, and the choice is derived from that.
 */
export type DecisionJudgeMode =
  | 'direct'
  | 'explained'
  | 'option-critique'
  | 'verbalized-sampling';
export const DECISION_JUDGE_MODES: readonly DecisionJudgeMode[] = [
  'direct',
  'explained',
  'option-critique',
  'verbalized-sampling',
];
export const DEFAULT_DECISION_JUDGE_MODE: DecisionJudgeMode = 'explained';
/** Names recorded by earlier regrades. */
export const LEGACY_DECISION_JUDGE_MODES: Readonly<
  Record<string, DecisionJudgeMode>
> = Object.freeze({ standard: 'explained', verbalized: 'option-critique' });

/** A judge mode with its candidate count; only verbalized sampling has one. */
export interface DecisionJudgeMethod {
  readonly mode: DecisionJudgeMode;
  readonly candidates?: number;
}

/** Validate and default a mode and optional candidate count from config or flags. */
export function decisionJudgeMethod(
  mode: unknown = DEFAULT_DECISION_JUDGE_MODE,
  candidates?: unknown,
): DecisionJudgeMethod {
  if (!(DECISION_JUDGE_MODES as readonly unknown[]).includes(mode))
    throw new TypeError(
      `Judge mode must be one of: ${DECISION_JUDGE_MODES.join(', ')}.`,
    );
  if (mode !== 'verbalized-sampling') {
    if (candidates !== undefined)
      throw new TypeError(
        'Judge candidates apply only to verbalized-sampling.',
      );
    return { mode: mode as DecisionJudgeMode };
  }
  const count = candidates ?? DEFAULT_VERBALIZED_SAMPLING_CANDIDATES;
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < MIN_VERBALIZED_SAMPLING_CANDIDATES ||
    count > MAX_VERBALIZED_SAMPLING_CANDIDATES
  )
    throw new TypeError(
      `Judge candidates must be an integer from ${MIN_VERBALIZED_SAMPLING_CANDIDATES} to ${MAX_VERBALIZED_SAMPLING_CANDIDATES}.`,
    );
  return { mode: 'verbalized-sampling', candidates: count };
}

export function decisionResponseSchema(
  questions: DecisionRequest['questions'],
  method: DecisionJudgeMethod = { mode: DEFAULT_DECISION_JUDGE_MODE },
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
              return [id, answerSchema(options, method)];
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

function answerSchema(options: readonly string[], method: DecisionJudgeMethod) {
  switch (method.mode) {
    case 'direct':
      return distributionAnswerSchema(options, false);
    case 'explained':
      return distributionAnswerSchema(options, true);
    case 'option-critique':
      return optionCritiqueAnswerSchema(options);
    case 'verbalized-sampling':
      return verbalizedSamplingAnswerSchema(
        options,
        method.candidates ?? DEFAULT_VERBALIZED_SAMPLING_CANDIDATES,
      );
  }
}

function distributionAnswerSchema(
  options: readonly string[],
  explained: boolean,
) {
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
      ...(explained ? { explanation: explanationSchema } : {}),
    },
    required: [
      'type',
      'choice',
      'probabilities',
      ...(explained ? ['explanation'] : []),
    ],
    additionalProperties: false,
  };
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

/** Assessments precede the choice, so each option is argued before deciding. */
function optionCritiqueAnswerSchema(options: readonly string[]) {
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
