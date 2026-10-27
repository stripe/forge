import { z } from 'zod';
import type { StrictCompletionResponseSchema } from '../contracts/completion.ts';
import type { ChoiceAnswer, DecisionRequest } from '../contracts/decision.ts';

export const MAX_DECISION_EXPLANATION_CHARACTERS = 64 * 1024;
export const DECISION_PROBABILITY_TOLERANCE = 0.000001;

export class InvalidDecisionResponseError extends Error {
  constructor(kind: 'invalid_json' | 'invalid_schema' = 'invalid_schema') {
    super(
      kind === 'invalid_json'
        ? 'Judge response was not valid JSON.'
        : 'Judge response did not match the required schema.',
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
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <=
      DECISION_PROBABILITY_TOLERANCE &&
    answer.probabilities[answer.choice] === maximum &&
    Math.abs(answer.confidence - maximum) <= DECISION_PROBABILITY_TOLERANCE
  );
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function choiceAnswerSchema(options: readonly [string, ...string[]]) {
  const probability = z.number().finite().min(0).max(1);
  return z
    .object({
      type: z.literal('choice'),
      choice: z.enum(options),
      probabilities: z
        .unknown()
        .transform((value, context): Record<string, number> => {
          if (
            !hasExactKeys(value, options) ||
            options.some(
              (option) => !probability.safeParse(value[option]).success,
            )
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Invalid option probabilities.',
            });
            return z.NEVER;
          }
          return Object.fromEntries(
            options.map((option) => [option, value[option] as number]),
          );
        }),
      confidence: probability,
      explanation: z
        .string()
        .trim()
        .min(1)
        .max(MAX_DECISION_EXPLANATION_CHARACTERS),
    })
    .strict()
    .superRefine((answer, context) => {
      if (!choiceDistributionIsValid(answer)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid choice distribution or confidence.',
        });
      }
    });
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
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    explanation: {
                      type: 'string',
                      minLength: 1,
                      maxLength: MAX_DECISION_EXPLANATION_CHARACTERS,
                    },
                  },
                  required: [
                    'type',
                    'choice',
                    'probabilities',
                    'confidence',
                    'explanation',
                  ],
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
  const envelope = z.object({ answers: z.unknown() }).strict().safeParse(value);
  if (
    !envelope.success ||
    !hasExactKeys(envelope.data.answers, Object.keys(questions))
  )
    throw new InvalidDecisionResponseError();
  const answers = envelope.data.answers;
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      if (options.length === 0)
        throw new TypeError('Choice questions require options.');
      const parsed = choiceAnswerSchema(
        options as [string, ...string[]],
      ).safeParse(answers[id]);
      if (!parsed.success) throw new InvalidDecisionResponseError();
      return [id, parsed.data];
    }),
  );
}
