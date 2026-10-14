import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createJudgeTranscriptProjection} from './judgeTranscript.js';
import {scoreEvaluation} from './score.js';
import {
  CRITERION_JUDGMENT_RESPONSE_SCHEMA,
  MAX_CRITERION_EXPLANATION_CHARACTERS,
  MAX_CRITERION_JUDGE_ATTEMPTS,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
  buildCriterionJudgePrompt,
  judgeCriteria,
  parseCriterionJudgment,
  type CriterionCompletionRequest,
  type CriterionCompletionInvoker,
} from './criterionJudge.js';

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

describe('judgeCriteria', () => {
  it('invokes one strict structured completion with the complete evidence prompt', async () => {
    const requests: CriterionCompletionRequest[] = [];
    const invoke: CriterionCompletionInvoker = async (request) => {
      requests.push(request);
      return valid();
    };

    const results = await judgeCriteria(
      {
        transcript: visibleTranscript('THE_TRANSCRIPT'),
        criteria: ['THE_CRITERION'],
        exampleAnswer: 'THE_EXAMPLE',
        workspaceText: 'THE_WORKSPACE',
      },
      invoke,
    );

    assert.deepEqual(results, [
      {criterion: 'THE_CRITERION', passed: true, explanation: 'yes'},
    ]);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.temperature, 0);
    assert.equal(request.maxTokens, 1024);
    assert.equal(request.responseSchema, CRITERION_JUDGMENT_RESPONSE_SCHEMA);
    assert.deepEqual(request.messages, [
      {role: 'user', content: 'Return the requested structured judgment.'},
    ]);
    assert.match(
      request.systemPrompt,
      /THE_TRANSCRIPT[\s\S]*THE_WORKSPACE[\s\S]*THE_EXAMPLE[\s\S]*THE_CRITERION/,
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

  it('judges text only and preserves ordered labels and scoring inclusion for every criterion', async () => {
    const requests: CriterionCompletionRequest[] = [];
    const results = await judgeCriteria({transcript: EMPTY_TRANSCRIPT, criteria: [
      {label: 'correctness', value: 'Correct answer'},
      {label: 'source', value: 'Read page A', include_in_score: false},
      {label: 'source', value: 'Read page B', include_in_score: false},
      'Legacy criterion',
    ]}, async (request) => {
      requests.push(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return valid(!request.systemPrompt.includes('Read page A'));
    });
    assert.equal(requests.length, 4);
    for (const request of requests) assert.doesNotMatch(request.systemPrompt, /correctness|include_in_score|\[object Object\]/);
    assert.deepEqual(results, [
      {criterion: 'Correct answer', label: 'correctness', include_in_score: true, passed: true, explanation: 'yes'},
      {criterion: 'Read page A', label: 'source', include_in_score: false, passed: false, explanation: 'yes'},
      {criterion: 'Read page B', label: 'source', include_in_score: false, passed: true, explanation: 'yes'},
      {criterion: 'Legacy criterion', passed: true, explanation: 'yes'},
    ]);
  });

  it('omits the optional example and workspace sections', () => {
    const prompt = buildCriterionJudgePrompt(
      {transcript: visibleTranscript('TRANSCRIPT')},
      'CRITERION',
    );

    assert.doesNotMatch(prompt, /Example correct answer/);
    assert.doesNotMatch(prompt, /## Workspace Files/);
    assert.match(
      prompt,
      /Only mark the criterion as passed if the assistant explicitly addressed it/,
    );
    assert.match(prompt, /TRANSCRIPT[\s\S]*CRITERION/);
  });

  it('rejects an arbitrary transcript string at the public judging boundary', async () => {
    let calls = 0;
    await assert.rejects(
      judgeCriteria(
        {
          transcript: {transcriptJson: '[]\n'} as never,
          criteria: ['criterion'],
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
      judgeCriteria(
        {
          transcript: EMPTY_TRANSCRIPT,
          criteria: ['criterion'],
          workspaceText: 'w'.repeat(MAX_CRITERION_JUDGE_PROMPT_BYTES),
        },
        async () => {
          calls += 1;
          return valid();
        },
        noRetryWait,
      ),
      new RegExp(`${MAX_CRITERION_JUDGE_PROMPT_BYTES}-byte limit`),
    );
    assert.equal(calls, 0);
  });

  it('bounds concurrency at four while preserving authored result order', async () => {
    const criteria = Array.from({length: 10}, (_, index) => `CRITERION_${index}`);
    let active = 0;
    let maximumActive = 0;
    const invoke: CriterionCompletionInvoker = async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const prompt = request.systemPrompt;
      const index = criteria.findIndex((criterion) =>
        prompt.includes(`Success Criterion:\n${criterion}\n`),
      );
      return valid(index % 2 === 0, `result ${index}`);
    };

    const results = await judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria},
      invoke,
    );

    assert.equal(maximumActive, 4);
    assert.deepEqual(
      results,
      criteria.map((criterion, index) => ({
        criterion,
        passed: index % 2 === 0,
        explanation: `result ${index}`,
      })),
    );
  });

  it('retries malformed output only for the affected criterion', async () => {
    const attempts = new Map<string, number>();
    const invoke: CriterionCompletionInvoker = async (request) => {
      const prompt = request.systemPrompt;
      const criterion = ['first', 'second', 'third'].find((candidate) =>
        prompt.includes(`Success Criterion:\n${candidate}\n`),
      )!;
      const attempt = (attempts.get(criterion) ?? 0) + 1;
      attempts.set(criterion, attempt);
      return criterion === 'second' && attempt === 1
        ? '{}'
        : valid(true, criterion);
    };

    const results = await judgeCriteria(
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: ['first', 'second', 'third'],
      },
      invoke,
      noRetryWait,
    );

    assert.deepEqual(
      results,
      ['first', 'second', 'third'].map((criterion) => ({
        criterion,
        passed: true,
        explanation: criterion,
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
    const invoke: CriterionCompletionInvoker = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transport failed');
      return valid(true, 'recovered');
    };

    const results = await judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion']},
      invoke,
      noRetryWait,
    );

    assert.equal(calls, 2);
    assert.deepEqual(results, [
      {criterion: 'criterion', passed: true, explanation: 'recovered'},
    ]);
  });

  it('throws the final exhausted transport error', async () => {
    let calls = 0;
    const invoke: CriterionCompletionInvoker = async () => {
      calls += 1;
      throw new Error('transport failed');
    };

    await assert.rejects(
      judgeCriteria(
        {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion']},
        invoke,
        noRetryWait,
      ),
      /transport failed/,
    );
    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
  });

  it('cancels peer judgments after one transport failure is exhausted', async () => {
    let failingCalls = 0;
    let peerCalls = 0;
    let peerAborted = false;
    const transportFailure = new Error('transport failed');

    await assert.rejects(
      judgeCriteria(
        {transcript: EMPTY_TRANSCRIPT, criteria: ['failing', 'peer']},
        async (request) => {
          if (request.systemPrompt.includes('Success Criterion:\nfailing\n')) {
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

    assert.equal(failingCalls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.equal(peerCalls, 1);
    assert.equal(peerAborted, true);
  });

  it('fails closed after three malformed responses without retaining raw output', async () => {
    let calls = 0;
    const invoke: CriterionCompletionInvoker = async () => {
      calls += 1;
      return 'secret malformed output';
    };

    const results = await judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion']},
      invoke,
      noRetryWait,
    );

    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        criterion: 'criterion',
        passed: false,
        explanation:
          'Judge response was not valid JSON. (unavailable after 3 attempts)',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(results), /secret malformed output/);
  });

  it('retains an exhausted malformed criterion in the score denominator alongside a successful peer', async () => {
    let failedCalls = 0;
    const results = await judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['unavailable', 'successful']},
      async (request) => {
        if (request.systemPrompt.includes('Success Criterion:\nsuccessful\n')) {
          return valid(true, 'completed');
        }
        failedCalls += 1;
        if (failedCalls === 1) throw new Error('private transient failure');
        return failedCalls === 2 ? '{}' : 'private malformed response';
      },
      noRetryWait,
    );

    assert.equal(failedCalls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        criterion: 'unavailable', passed: false,
        explanation: 'Judge response was not valid JSON. (unavailable after 3 attempts)',
      },
      {criterion: 'successful', passed: true, explanation: 'completed'},
    ]);
    const evaluation = scoreEvaluation(results, [{name: 'file', passed: true}]);
    assert.equal(evaluation.score, 0.5);
    assert.equal(evaluation.judging_criteria_total, 2);
    assert.equal(evaluation.judging_criteria_passed, 1);
    assert.equal(evaluation.status, 'partial');
    assert.doesNotMatch(JSON.stringify(evaluation), /private/);
  });

  it('propagates a final transport failure even after earlier malformed responses', async () => {
    const failure = new Error('final transport failure');
    let calls = 0;
    await assert.rejects(judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion']},
      async () => {
        calls += 1;
        if (calls === MAX_CRITERION_JUDGE_ATTEMPTS) throw failure;
        return '{}';
      },
      noRetryWait,
    ), (error: unknown) => error === failure);
    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
  });

  it('treats an explanation too large for the result artifact as malformed', async () => {
    let calls = 0;
    const oversized = 'x'.repeat(MAX_CRITERION_EXPLANATION_CHARACTERS + 1);
    const results = await judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion']},
      async () => {
        calls += 1;
        return valid(true, oversized);
      },
      noRetryWait,
    );

    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        criterion: 'criterion',
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
    const invoke: CriterionCompletionInvoker = async () => {
      calls += 1;
      controller.abort(reason);
      throw reason;
    };

    await assert.rejects(
      judgeCriteria(
        {
          transcript: EMPTY_TRANSCRIPT,
          criteria: ['criterion'],
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
    await assert.rejects(judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion'], signal: controller.signal},
      async () => {
        calls += 1;
        setImmediate(() => controller.abort(reason));
        return '{}';
      },
    ), (error: unknown) => error === reason);
    assert.equal(calls, 1);
  });

  it('does not invoke a completion for an empty criterion list', async () => {
    let calls = 0;
    const results = await judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: []},
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
    const pending = judgeCriteria(
      {transcript: EMPTY_TRANSCRIPT, criteria: ['criterion']},
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

describe('parseCriterionJudgment', () => {
  it('accepts JSON explanations containing Markdown backticks and escaped characters', () => {
    const explanation = '  Missing `cancel_url`; expected "https://example.com/cancel".\nCheck C:\\checkout.  ';
    assert.deepEqual(parseCriterionJudgment(valid(false, explanation), 'criterion'), {
      criterion: 'criterion',
      passed: false,
      explanation: explanation.trim(),
    });
  });

  it('rejects illegal backslash-backtick escapes in an explanation', () => {
    const raw = '{"results":[{"index":0,"passed":true,"explanation":"Missing \\`cancel_url\\`."}]}';
    assert.deepEqual(parseCriterionJudgment(raw, 'criterion'), {
      criterion: 'criterion',
      passed: false,
      explanation: 'Judge response was not valid JSON.',
    });
  });

  it('does not recover JSON from prose or code fences', () => {
    for (const raw of [
      'prose {"results":[{"index":0,"passed":true,"explanation":"ok"}]}',
      '```json\n{"results":[{"index":0,"passed":true,"explanation":"ok"}]}\n```',
    ]) {
      assert.deepEqual(parseCriterionJudgment(raw, 'criterion'), {
        criterion: 'criterion',
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
      assert.deepEqual(parseCriterionJudgment(JSON.stringify(response), 'g'), {
        criterion: 'g',
        passed: false,
        explanation: 'Judge response did not match the required schema.',
      });
    }
  });
});
