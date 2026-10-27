import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createCompletionDecisionModel,
  type DecisionCompletionRequest,
} from './completionDecisionModel.ts';

describe('completion decision adapter', () => {
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
          answers: Object.fromEntries([['__proto__', answer]]),
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
          content: JSON.stringify({ answers }),
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
          'Judge response did not match the required schema.',
        );
        return true;
      },
    );
  });
});
