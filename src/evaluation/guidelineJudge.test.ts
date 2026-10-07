import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createJudgeTranscriptProjection} from './judgeTranscript.js';
import {scoreEvaluation} from './score.js';
import {
  GUIDELINE_JUDGMENT_RESPONSE_SCHEMA,
  MAX_GUIDELINE_EXPLANATION_CHARACTERS,
  MAX_GUIDELINE_JUDGE_ATTEMPTS,
  MAX_GUIDELINE_JUDGE_PROMPT_BYTES,
  buildGuidelineJudgePrompt,
  judgeGuidelines,
  parseGuidelineJudgment,
  type GuidelineCompletionRequest,
  type GuidelineCompletionInvoker,
} from './guidelineJudge.js';

const noRetryWait = {
  waitBeforeRetry: async (): Promise<void> => undefined,
};

const EMPTY_TRANSCRIPT = createJudgeTranscriptProjection({
  schema_version: 'ATIF-v1.8',
  agent: {name: 'test-agent', version: '1'},
  steps: [{step_id: 1, source: 'system', message: 'not judge evidence'}],
});

function visibleTranscript(message: string) {
  return createJudgeTranscriptProjection({
    schema_version: 'ATIF-v1.8',
    agent: {name: 'test-agent', version: '1'},
    steps: [{step_id: 1, source: 'user', message}],
  });
}

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
        transcript: visibleTranscript('THE_TRANSCRIPT'),
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
    assert.match(request.systemPrompt, /private reasoning/);
    assert.match(request.systemPrompt, /copied context/);
    assert.match(
      request.systemPrompt,
      /Identically named keys[\s\S]*inside actual tool arguments or result content remain/,
    );
    assert.match(
      request.systemPrompt,
      /Do not infer omitted material or reward its possible presence or quality/,
    );
    assert.match(
      request.systemPrompt,
      /Image and audio objects are path references only/,
    );
    assert.ok(request.signal instanceof AbortSignal);
  });

  it('omits the optional example and workspace sections', () => {
    const prompt = buildGuidelineJudgePrompt(
      {transcript: visibleTranscript('TRANSCRIPT')},
      'GUIDELINE',
    );

    assert.doesNotMatch(prompt, /Example correct answer/);
    assert.doesNotMatch(prompt, /## Workspace Files/);
    assert.match(
      prompt,
      /Only mark the guideline as passed if the assistant explicitly addressed it/,
    );
    assert.match(prompt, /TRANSCRIPT[\s\S]*GUIDELINE/);
  });

  it('rejects an arbitrary transcript string at the public judging boundary', async () => {
    let calls = 0;
    await assert.rejects(
      judgeGuidelines(
        {
          transcript: {transcriptJson: '[]\n'} as never,
          guidelines: ['guideline'],
        },
        async () => {
          calls += 1;
          return valid();
        },
      ),
    );
    assert.equal(calls, 0);
  });

  it('rejects an oversized final prompt before invoking or retrying a provider', async () => {
    let calls = 0;
    await assert.rejects(
      judgeGuidelines(
        {
          transcript: EMPTY_TRANSCRIPT,
          guidelines: ['guideline'],
          workspaceText: 'w'.repeat(MAX_GUIDELINE_JUDGE_PROMPT_BYTES),
        },
        async () => {
          calls += 1;
          return valid();
        },
        noRetryWait,
      ),
      new RegExp(`${MAX_GUIDELINE_JUDGE_PROMPT_BYTES}-byte limit`),
    );
    assert.equal(calls, 0);
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
      {transcript: EMPTY_TRANSCRIPT, guidelines},
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
        transcript: EMPTY_TRANSCRIPT,
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
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline']},
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
        {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline']},
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
        {transcript: EMPTY_TRANSCRIPT, guidelines: ['failing', 'peer']},
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
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline']},
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

  it('retains an exhausted malformed guideline in the score denominator alongside a successful peer', async () => {
    let failedCalls = 0;
    const results = await judgeGuidelines(
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['unavailable', 'successful']},
      async (request) => {
        if (request.systemPrompt.includes('Success Guideline:\nsuccessful\n')) {
          return valid(true, 'completed');
        }
        failedCalls += 1;
        if (failedCalls === 1) throw new Error('private transient failure');
        return failedCalls === 2 ? '{}' : 'private malformed response';
      },
      noRetryWait,
    );

    assert.equal(failedCalls, MAX_GUIDELINE_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        guideline: 'unavailable', passed: false,
        explanation: 'Judge response was not valid JSON. (unavailable after 3 attempts)',
      },
      {guideline: 'successful', passed: true, explanation: 'completed'},
    ]);
    const evaluation = scoreEvaluation(results, [{name: 'file', passed: true}]);
    assert.equal(evaluation.score, 0.5);
    assert.equal(evaluation.guidelines_total, 2);
    assert.equal(evaluation.guidelines_passed, 1);
    assert.equal(evaluation.status, 'partial');
    assert.doesNotMatch(JSON.stringify(evaluation), /private/);
  });

  it('propagates a final transport failure even after earlier malformed responses', async () => {
    const failure = new Error('final transport failure');
    let calls = 0;
    await assert.rejects(judgeGuidelines(
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline']},
      async () => {
        calls += 1;
        if (calls === MAX_GUIDELINE_JUDGE_ATTEMPTS) throw failure;
        return '{}';
      },
      noRetryWait,
    ), (error: unknown) => error === failure);
    assert.equal(calls, MAX_GUIDELINE_JUDGE_ATTEMPTS);
  });

  it('treats an explanation too large for the result artifact as malformed', async () => {
    let calls = 0;
    const oversized = 'x'.repeat(MAX_GUIDELINE_EXPLANATION_CHARACTERS + 1);
    const results = await judgeGuidelines(
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline']},
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
          transcript: EMPTY_TRANSCRIPT,
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

  it('cancels the real retry wait without starting another completion', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during retry wait');
    let calls = 0;
    await assert.rejects(judgeGuidelines(
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline'], signal: controller.signal},
      async () => {
        calls += 1;
        setImmediate(() => controller.abort(reason));
        return '{}';
      },
    ), (error: unknown) => error === reason);
    assert.equal(calls, 1);
  });

  it('does not invoke a completion for an empty guideline list', async () => {
    let calls = 0;
    const results = await judgeGuidelines(
      {transcript: EMPTY_TRANSCRIPT, guidelines: []},
      async () => {
        calls += 1;
        return valid();
      },
    );

    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it('uses the default one-second and five-second retry waits', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    let calls = 0;
    const pending = judgeGuidelines(
      {transcript: EMPTY_TRANSCRIPT, guidelines: ['guideline']},
      async () => {calls += 1; return '{}';},
    );
    const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
    await nextTurn();
    assert.equal(calls, 1);
    t.mock.timers.tick(999);
    await nextTurn();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(calls, 2);
    t.mock.timers.tick(4_999);
    await nextTurn();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    const results = await pending;
    assert.equal(calls, 3);
    assert.equal(results[0]?.passed, false);
  });
});

describe('parseGuidelineJudgment', () => {
  it('accepts JSON explanations containing Markdown backticks and escaped characters', () => {
    const explanation = '  Missing `cancel_url`; expected "https://example.com/cancel".\nCheck C:\\checkout.  ';
    assert.deepEqual(parseGuidelineJudgment(valid(false, explanation), 'guideline'), {
      guideline: 'guideline',
      passed: false,
      explanation: explanation.trim(),
    });
  });

  it('rejects illegal backslash-backtick escapes in an explanation', () => {
    const raw = '{"results":[{"index":0,"passed":true,"explanation":"Missing \\`cancel_url\\`."}]}';
    assert.deepEqual(parseGuidelineJudgment(raw, 'guideline'), {
      guideline: 'guideline',
      passed: false,
      explanation: 'Judge response was not valid JSON.',
    });
  });

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

  it('fails closed for extra fields, the wrong index, blank explanations, and wrong result counts', () => {
    const entry = {index: 0, passed: true, explanation: 'ok'};
    for (const response of [
      {results: [{...entry, extra: true}]},
      {results: [{...entry, index: 1}]},
      {results: [{...entry, explanation: ''}]},
      {results: [{...entry, explanation: '   '}]},
      {results: [{...entry, explanation: '\t\r\n'}]},
      {results: [entry], extra: true},
      {results: []},
      {results: [entry, entry]},
    ]) {
      assert.deepEqual(parseGuidelineJudgment(JSON.stringify(response), 'g'), {
        guideline: 'g',
        passed: false,
        explanation: 'Judge response did not match the required schema.',
      });
    }
  });
});
