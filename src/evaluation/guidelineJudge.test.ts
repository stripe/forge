import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  GUIDELINE_JUDGMENT_RESPONSE_SCHEMA,
  GUIDELINE_JUDGE_RETRY_DELAYS_MS,
  MAX_GUIDELINE_EXPLANATION_CHARACTERS,
  MAX_GUIDELINE_JUDGE_ATTEMPTS,
  buildGuidelineJudgePrompt,
  judgeGuidelines,
  parseGuidelineJudgment,
  type GuidelineCompletionRequest,
  type GuidelineCompletionInvoker,
} from './guidelineJudge.js';

const noRetryWait = {
  waitBeforeRetry: async (): Promise<void> => undefined,
};

function valid(
  passed = true,
  explanation = 'yes',
): string {
  return JSON.stringify({results: [{index: 0, passed, explanation}]});
}

describe('judgeGuidelines', () => {
  it('invokes one strict structured completion with the complete evidence prompt', async () => {
    const requests: GuidelineCompletionRequest[] = [];
    const invoke: GuidelineCompletionInvoker = async (request) => {
      requests.push(request);
      return valid();
    };

    const results = await judgeGuidelines(
      {
        transcriptJson: 'THE_TRANSCRIPT',
        guidelines: ['THE_GUIDELINE'],
        exampleAnswer: 'THE_EXAMPLE',
        workspaceText: 'THE_WORKSPACE',
      },
      invoke,
    );

    assert.deepEqual(results, [
      {guideline: 'THE_GUIDELINE', passed: true, explanation: 'yes'},
    ]);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.temperature, 0);
    assert.equal(request.maxTokens, 1024);
    assert.equal(request.responseSchema, GUIDELINE_JUDGMENT_RESPONSE_SCHEMA);
    assert.deepEqual(request.messages, [
      {role: 'user', content: 'Return the requested structured judgment.'},
    ]);
    assert.match(
      request.systemPrompt,
      /THE_TRANSCRIPT[\s\S]*THE_WORKSPACE[\s\S]*THE_EXAMPLE[\s\S]*THE_GUIDELINE/,
    );
    assert.ok(request.signal instanceof AbortSignal);
  });

  it('omits the optional example and workspace sections', () => {
    const prompt = buildGuidelineJudgePrompt(
      {transcriptJson: 'TRANSCRIPT'},
      'GUIDELINE',
    );

    assert.doesNotMatch(prompt, /Example correct answer/);
    assert.match(
      prompt,
      /Only mark the guideline as passed if the assistant explicitly addressed it/,
    );
    assert.match(prompt, /TRANSCRIPT[\s\S]*GUIDELINE/);
  });

  it('bounds concurrency at four while preserving authored result order', async () => {
    const guidelines = Array.from({length: 10}, (_, index) => `GUIDELINE_${index}`);
    let active = 0;
    let maximumActive = 0;
    const invoke: GuidelineCompletionInvoker = async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const prompt = request.systemPrompt;
      const index = guidelines.findIndex((guideline) =>
        prompt.includes(`Success Guideline:\n${guideline}\n`),
      );
      return valid(index % 2 === 0, `result ${index}`);
    };

    const results = await judgeGuidelines(
      {transcriptJson: '[]', guidelines},
      invoke,
    );

    assert.equal(maximumActive, 4);
    assert.deepEqual(
      results,
      guidelines.map((guideline, index) => ({
        guideline,
        passed: index % 2 === 0,
        explanation: `result ${index}`,
      })),
    );
  });

  it('retries malformed output only for the affected guideline', async () => {
    const attempts = new Map<string, number>();
    const invoke: GuidelineCompletionInvoker = async (request) => {
      const prompt = request.systemPrompt;
      const guideline = ['first', 'second', 'third'].find((candidate) =>
        prompt.includes(`Success Guideline:\n${candidate}\n`),
      )!;
      const attempt = (attempts.get(guideline) ?? 0) + 1;
      attempts.set(guideline, attempt);
      return guideline === 'second' && attempt === 1
        ? '{}'
        : valid(true, guideline);
    };

    const results = await judgeGuidelines(
      {
        transcriptJson: '[]',
        guidelines: ['first', 'second', 'third'],
      },
      invoke,
      noRetryWait,
    );

    assert.deepEqual(
      results,
      ['first', 'second', 'third'].map((guideline) => ({
        guideline,
        passed: true,
        explanation: guideline,
      })),
    );
    assert.deepEqual(
      attempts,
      new Map([
        ['first', 1],
        ['second', 2],
        ['third', 1],
      ]),
    );
  });

  it('retries transport errors and accepts a later valid response', async () => {
    let calls = 0;
    const invoke: GuidelineCompletionInvoker = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transport failed');
      return valid(true, 'recovered');
    };

    const results = await judgeGuidelines(
      {transcriptJson: '[]', guidelines: ['guideline']},
      invoke,
      noRetryWait,
    );

    assert.equal(calls, 2);
    assert.deepEqual(results, [
      {guideline: 'guideline', passed: true, explanation: 'recovered'},
    ]);
  });

  it('throws the final exhausted transport error', async () => {
    let calls = 0;
    const invoke: GuidelineCompletionInvoker = async () => {
      calls += 1;
      throw new Error('transport failed');
    };

    await assert.rejects(
      judgeGuidelines(
        {transcriptJson: '[]', guidelines: ['guideline']},
        invoke,
        noRetryWait,
      ),
      /transport failed/,
    );
    assert.equal(calls, MAX_GUIDELINE_JUDGE_ATTEMPTS);
  });

  it('cancels peer judgments after one transport failure is exhausted', async () => {
    let failingCalls = 0;
    let peerCalls = 0;
    let peerAborted = false;
    const transportFailure = new Error('transport failed');

    await assert.rejects(
      judgeGuidelines(
        {transcriptJson: '[]', guidelines: ['failing', 'peer']},
        async (request) => {
          if (request.systemPrompt.includes('Success Guideline:\nfailing\n')) {
            failingCalls += 1;
            throw transportFailure;
          }
          peerCalls += 1;
          return new Promise<string>((_resolve, reject) => {
            const onAbort = (): void => {
              peerAborted = true;
              reject(request.signal.reason);
            };
            request.signal.addEventListener('abort', onAbort, {once: true});
            if (request.signal.aborted) onAbort();
          });
        },
        noRetryWait,
      ),
      (error: unknown) => error === transportFailure,
    );

    assert.equal(failingCalls, MAX_GUIDELINE_JUDGE_ATTEMPTS);
    assert.equal(peerCalls, 1);
    assert.equal(peerAborted, true);
  });

  it('fails closed after three malformed responses without retaining raw output', async () => {
    let calls = 0;
    const invoke: GuidelineCompletionInvoker = async () => {
      calls += 1;
      return 'secret malformed output';
    };

    const results = await judgeGuidelines(
      {transcriptJson: '[]', guidelines: ['guideline']},
      invoke,
      noRetryWait,
    );

    assert.equal(calls, MAX_GUIDELINE_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        guideline: 'guideline',
        passed: false,
        explanation:
          'Judge response was not valid JSON. (unavailable after 3 attempts)',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(results), /secret malformed output/);
  });

  it('treats an explanation too large for the result artifact as malformed', async () => {
    let calls = 0;
    const oversized = 'x'.repeat(MAX_GUIDELINE_EXPLANATION_CHARACTERS + 1);
    const results = await judgeGuidelines(
      {transcriptJson: '[]', guidelines: ['guideline']},
      async () => {
        calls += 1;
        return valid(true, oversized);
      },
      noRetryWait,
    );

    assert.equal(calls, MAX_GUIDELINE_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        guideline: 'guideline',
        passed: false,
        explanation:
          'Judge response did not match the required schema. (unavailable after 3 attempts)',
      },
    ]);
  });

  it('does not retry an aborted completion', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    let calls = 0;
    const invoke: GuidelineCompletionInvoker = async () => {
      calls += 1;
      controller.abort(reason);
      throw reason;
    };

    await assert.rejects(
      judgeGuidelines(
        {
          transcriptJson: '[]',
          guidelines: ['guideline'],
          signal: controller.signal,
        },
        invoke,
        noRetryWait,
      ),
      (error: unknown) => error === reason,
    );
    assert.equal(calls, 1);
  });

  it('does not invoke a completion for an empty guideline list', async () => {
    let calls = 0;
    const results = await judgeGuidelines(
      {transcriptJson: '[]', guidelines: []},
      async () => {
        calls += 1;
        return valid();
      },
    );

    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it('uses the fixed one-second and five-second retry schedule', async () => {
    const waits: number[] = [];
    const results = await judgeGuidelines(
      {transcriptJson: '[]', guidelines: ['guideline']},
      async () => '{}',
      {
        waitBeforeRetry: async (attempt) => {
          waits.push(GUIDELINE_JUDGE_RETRY_DELAYS_MS[attempt - 1]!);
        },
      },
    );

    assert.deepEqual(waits, [1_000, 5_000]);
    assert.equal(results[0]?.passed, false);
  });
});

describe('parseGuidelineJudgment', () => {
  it('does not recover JSON from prose or code fences', () => {
    for (const raw of [
      'prose {"results":[{"index":0,"passed":true,"explanation":"ok"}]}',
      '```json\n{"results":[{"index":0,"passed":true,"explanation":"ok"}]}\n```',
    ]) {
      assert.deepEqual(parseGuidelineJudgment(raw, 'guideline'), {
        guideline: 'guideline',
        passed: false,
        explanation: 'Judge response was not valid JSON.',
      });
    }
  });

  it('rejects extra fields, the wrong index, and blank explanations', () => {
    for (const result of [
      {index: 0, passed: true, explanation: 'ok', extra: true},
      {index: 1, passed: true, explanation: 'ok'},
      {index: 0, passed: true, explanation: '   '},
    ]) {
      assert.equal(
        parseGuidelineJudgment(JSON.stringify({results: [result]}), 'g').passed,
        false,
      );
    }
  });
});
