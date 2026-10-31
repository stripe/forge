import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createCompletionDecisionModel,
  type DecisionCompletionRequest,
} from './completionDecisionModel.ts';
import { decisionJudgeMethod } from './decision.ts';

describe('completion decision adapter', () => {
  it.each([
    { instructions: 'Choose.', criteria: {} },
    { instructions: ' ', criteria: { yes: 'Yes.' } },
    { instructions: 'Choose.', criteria: { yes: ' ' } },
  ])(
    'rejects an invalid choice question before invoking a completion provider: %j',
    async (question) => {
      let calls = 0;
      const adapter = createCompletionDecisionModel({
        invoke: async () => {
          calls += 1;
          return '{}';
        },
      });
      await assert.rejects(
        adapter.decide({
          state: 'State.',
          questions: {
            check: { type: 'choice', ...question },
          },
          signal: new AbortController().signal,
        }),
        /Decision request validation failed/,
      );
      assert.equal(calls, 0);
    },
  );
  it('asks option-critique judges to argue every option before choosing and normalizes their probabilities', async () => {
    const calls: DecisionCompletionRequest[] = [];
    const assess = (forText: string, probability: number) => ({
      for: forText,
      against: 'Some evidence points the other way.',
      probability,
    });
    const reply = (choice: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        answers: {
          check: {
            type: 'choice',
            assessments: {
              yes: assess('The tests pass.', 0.6),
              no: assess('One case is untested.', 0.3),
            },
            choice,
            explanation: 'Mostly supported.',
            ...extra,
          },
        },
      });
    const question = {
      type: 'choice' as const,
      instructions: 'Is it done?',
      criteria: { yes: 'Done.', no: 'Not done.' },
    };
    const decide = (body: string) =>
      createCompletionDecisionModel({
        method: { mode: 'option-critique' },
        invoke: async (request) => {
          calls.push(request);
          return body;
        },
      }).decide({
        state: 'State.',
        questions: { check: question },
        signal: new AbortController().signal,
      });
    const result = await decide(reply('yes'));
    const answer = result.answers.check!;
    // Stated per option, then normalized: 0.6 / 0.9 and 0.3 / 0.9.
    assert.ok(Math.abs(answer.probabilities.yes! - 2 / 3) < 1e-9);
    assert.ok(Math.abs(answer.probabilities.no! - 1 / 3) < 1e-9);
    assert.ok(Math.abs(answer.confidence - 2 / 3) < 1e-9);
    assert.equal(answer.assessments?.yes?.probability, 0.6);
    assert.equal(answer.assessments?.no?.for, 'One case is untested.');
    const [request] = calls;
    assert.match(request!.systemPrompt, /Assess every option before deciding/);
    assert.equal(request!.maxTokens, 4096);
    const schema = request!.responseSchema.schema as {
      properties: {
        answers: {
          properties: Record<
            string,
            { properties: object; required: string[] }
          >;
        };
      };
    };
    const answerSchema = schema.properties.answers.properties.check!;
    assert.deepEqual(Object.keys(answerSchema.properties), [
      'type',
      'assessments',
      'choice',
      'explanation',
    ]);
    assert.deepEqual(answerSchema.required, [
      'type',
      'assessments',
      'choice',
      'explanation',
    ]);
    await assert.rejects(decide(reply('no')), /choice_not_argmax/);
    await assert.rejects(
      decide(
        JSON.stringify({
          answers: {
            check: {
              type: 'choice',
              assessments: {
                yes: { ...assess('x', 0.6), against: ' ' },
                no: assess('y', 0.3),
              },
              choice: 'yes',
              explanation: 'x',
            },
          },
        }),
      ),
      /assessments/,
    );
    // The explained mode keeps its prompt, budget, and schema.
    calls.length = 0;
    await createCompletionDecisionModel({
      invoke: async (request) => {
        calls.push(request);
        return JSON.stringify({
          answers: {
            check: {
              type: 'choice',
              choice: 'yes',
              probabilities: { yes: 0.9, no: 0.1 },
              explanation: 'x',
            },
          },
        });
      },
    }).decide({
      state: 'State.',
      questions: { check: question },
      signal: new AbortController().signal,
    });
    assert.equal(calls[0]!.maxTokens, 1024);
    assert.doesNotMatch(calls[0]!.systemPrompt, /Assess every option/);
  });

  it('runs verbalized sampling: k candidates, per-option sums, and a derived choice', async () => {
    const calls: DecisionCompletionRequest[] = [];
    const question = {
      type: 'choice' as const,
      instructions: 'Is it done?',
      criteria: { yes: 'Done.', no: 'Not done.' },
    };
    const candidate = (label: string, probability: number) => ({
      reading: `A ${label} reading.`,
      rationale: `Why ${label}.`,
      label,
      probability,
    });
    const decide = (candidates: unknown[]) =>
      createCompletionDecisionModel({
        method: { mode: 'verbalized-sampling', candidates: 3 },
        invoke: async (request) => {
          calls.push(request);
          return JSON.stringify({
            answers: { check: { type: 'choice', candidates } },
          });
        },
      }).decide({
        state: 'State.',
        questions: { check: question },
        signal: new AbortController().signal,
      });
    const answer = (
      await decide([
        candidate('yes', 0.4),
        candidate('no', 0.35),
        candidate('yes', 0.25),
      ])
    ).answers.check!;
    assert.equal(answer.choice, 'yes');
    assert.ok(Math.abs(answer.probabilities.yes! - 0.65) < 1e-9);
    assert.ok(Math.abs(answer.probabilities.no! - 0.35) < 1e-9);
    assert.equal(answer.candidates?.length, 3);
    assert.equal(answer.explanation, undefined);
    const request = calls[0]!;
    assert.match(request.systemPrompt, /Generate 3 candidate answers/);
    assert.equal(request.maxTokens, 4096);
    const answerSchema = (
      request.responseSchema.schema as {
        properties: {
          answers: {
            properties: Record<
              string,
              {
                properties: Record<
                  string,
                  { minItems?: number; maxItems?: number }
                >;
                required: string[];
              }
            >;
          };
        };
      }
    ).properties.answers.properties.check!;
    assert.deepEqual(answerSchema.required, ['type', 'candidates']);
    assert.equal(answerSchema.properties.candidates!.minItems, 3);
    assert.equal(answerSchema.properties.candidates!.maxItems, 3);
    // Aggregate tie: the single most probable candidate decides.
    assert.equal(
      (
        await decide([
          candidate('no', 0.5),
          candidate('yes', 0.3),
          candidate('yes', 0.2),
        ])
      ).answers.check!.choice,
      'no',
    );
    // A tie at both levels is rejected rather than broken by option order.
    await assert.rejects(
      decide([candidate('yes', 0.5), candidate('no', 0.5), candidate('no', 0)]),
      /choice_not_argmax/,
    );
    await assert.rejects(decide([candidate('maybe', 1)]), /unknown_choice/);
    await assert.rejects(
      decide([{ ...candidate('yes', 1), rationale: ' ' }]),
      /candidates/,
    );
  });

  it('runs direct mode without an explanation and validates judge methods', async () => {
    const calls: DecisionCompletionRequest[] = [];
    const result = await createCompletionDecisionModel({
      method: { mode: 'direct' },
      invoke: async (request) => {
        calls.push(request);
        return JSON.stringify({
          answers: {
            check: {
              type: 'choice',
              choice: 'yes',
              probabilities: { yes: 0.7, no: 0.3 },
            },
          },
        });
      },
    }).decide({
      state: 'State.',
      questions: {
        check: {
          type: 'choice',
          instructions: 'Done?',
          criteria: { yes: 'Yes.', no: 'No.' },
        },
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.answers.check!.explanation, undefined);
    assert.equal(calls[0]!.maxTokens, 512);
    const required = (
      calls[0]!.responseSchema.schema as {
        properties: {
          answers: { properties: Record<string, { required: string[] }> };
        };
      }
    ).properties.answers.properties.check!.required;
    assert.deepEqual(required, ['type', 'choice', 'probabilities']);
    assert.deepEqual(decisionJudgeMethod(), { mode: 'explained' });
    assert.deepEqual(decisionJudgeMethod('verbalized-sampling'), {
      mode: 'verbalized-sampling',
      candidates: 5,
    });
    for (const [mode, candidates] of [
      ['sampled', undefined],
      ['explained', 3],
      ['verbalized-sampling', 1],
      ['verbalized-sampling', 11],
      ['verbalized-sampling', 2.5],
    ] as const)
      assert.throws(() => decisionJudgeMethod(mode, candidates));
  });

  it('preserves caller IDs and options that match object prototype names', async () => {
    const answer = {
      type: 'choice',
      choice: '__proto__',
      probabilities: Object.fromEntries([
        ['__proto__', 0.9],
        ['constructor', 0.1],
      ]),
      confidence: 0.9,
      explanation: 'The first option has the most support.',
    };
    const adapter = createCompletionDecisionModel({
      model: null,
      invoke: async () =>
        JSON.stringify({
          answers: Object.fromEntries([
            ['__proto__', { ...answer, confidence: undefined }],
          ]),
        }),
    });
    const result = await adapter.decide({
      state: 'State.',
      questions: Object.fromEntries([
        [
          '__proto__',
          {
            type: 'choice',
            instructions: 'Choose.',
            criteria: Object.fromEntries([
              ['__proto__', 'First.'],
              ['constructor', 'Second.'],
            ]),
          },
        ],
      ]),
      signal: new AbortController().signal,
    });
    assert.deepEqual(Object.keys(result.answers), ['__proto__']);
    assert.deepEqual(result.answers.__proto__, answer);
    assert.equal(Object.getPrototypeOf(result.answers), Object.prototype);
  });

  it('carries caller question IDs through strict output, model identity, and usage', async () => {
    const calls: DecisionCompletionRequest[] = [];
    const answers = {
      'route-7': {
        type: 'choice' as const,
        choice: 'left',
        probabilities: { left: 0.75, right: 0.25 },
        confidence: 0.75,
        explanation: 'The state supports the left route.',
      },
      check: {
        type: 'choice' as const,
        choice: 'ready',
        probabilities: { ready: 1, pending: 0 },
        confidence: 1,
        explanation: 'The check is done.',
      },
    };
    const model = { provider: 'synthetic', model: 'decision-test' };
    const usage = { inputTokens: 12, outputTokens: 34, cachedInputTokens: 5 };
    const adapter = createCompletionDecisionModel({
      model,
      invoke: async (request) => {
        calls.push(request);
        return {
          content: JSON.stringify({
            answers: Object.fromEntries(
              Object.entries(answers).map(
                ([id, { confidence: _confidence, ...answer }]) => [id, answer],
              ),
            ),
          }),
          usage,
          stopReason: 'end_turn',
        };
      },
    });
    const result = await adapter.decide({
      state: 'Route state and check state.',
      questions: {
        'route-7': {
          type: 'choice',
          instructions: 'Pick the route.',
          criteria: { left: 'Go left.', right: 'Go right.' },
        },
        check: {
          type: 'choice',
          instructions: 'Is the check ready?',
          criteria: { ready: 'Done.', pending: 'Not done.' },
        },
      },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { model, answers, usage });
    assert.match(calls[0]!.systemPrompt, /Route state and check state/);
    assert.match(calls[0]!.systemPrompt, /route-7/);
    const schema = calls[0]!.responseSchema.schema as {
      properties: {
        answers: { required: string[]; additionalProperties: boolean };
      };
    };
    assert.deepEqual(schema.properties.answers.required, ['route-7', 'check']);
    assert.equal(schema.properties.answers.additionalProperties, false);
  });

  it('rejects unknown answer IDs without copying their text into the error', async () => {
    const adapter = createCompletionDecisionModel({
      model: null,
      invoke: async () =>
        JSON.stringify({
          answers: { 'private-unknown-id': { type: 'choice' } },
        }),
    });
    await assert.rejects(
      adapter.decide({
        state: 'state',
        questions: {
          check: {
            type: 'choice',
            instructions: 'Pick.',
            criteria: { yes: 'Yes.', no: 'No.' },
          },
        },
        signal: new AbortController().signal,
      }),
      (error) => {
        assert.equal(
          (error as Error).message,
          'Judge response rejected: unknown_key.',
        );
        return true;
      },
    );
  });
});
