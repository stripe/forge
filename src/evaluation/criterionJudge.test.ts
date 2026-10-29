import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { REQUIREMENT_LEVELS } from '../model/types.ts';
import { parseEvaluationResult } from '../results/parse.ts';
import {
  buildCriterionJudgePrompt,
  CRITERION_JUDGMENT_RESPONSE_SCHEMA,
  type CriterionCompletionInvoker,
  type CriterionCompletionRequest,
  judgeCriteria,
  MAX_CRITERION_EXPLANATION_CHARACTERS,
  MAX_CRITERION_JUDGE_ATTEMPTS,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
  parseCriterionJudgment,
} from './criterionJudge.ts';
import { createJudgeTranscriptProjection } from './judgeTranscript.ts';
import { scoreEvaluation } from './score.ts';

const noRetryWait = {
  waitBeforeRetry: async (): Promise<void> => undefined,
};

const EMPTY_TRANSCRIPT = createJudgeTranscriptProjection({
  schema_version: 'ATIF-v1.8',
  agent: { name: 'test-agent', version: '1' },
  steps: [{ step_id: 1, source: 'system', message: 'not judge evidence' }],
});

function visibleTranscript(message: string) {
  return createJudgeTranscriptProjection({
    schema_version: 'ATIF-v1.8',
    agent: { name: 'test-agent', version: '1' },
    steps: [{ step_id: 1, source: 'user', message }],
  });
}

function valid(passed = true, explanation = 'yes'): string {
  return JSON.stringify({ results: [{ index: 0, passed, explanation }] });
}

describe('judgeCriteria', () => {
  it('uses canonical criterion text in prompts and valid result artifacts at the size limit', async () => {
    const value = 'x'.repeat(64 * 1024);
    const criterion = {
      requirement_level: 'SHOULD' as const,
      value: ` \n${value}\t `,
    };
    for (const raw of [valid(), '{}']) {
      const results = await judgeCriteria(
        { transcript: EMPTY_TRANSCRIPT, criteria: [criterion] },
        async (request) => {
          assert.ok(
            request.systemPrompt.includes(`Success Criterion:\n${value}\n`),
          );
          return raw;
        },
        noRetryWait,
      );
      assert.equal(results[0]?.criterion, value);
      const evaluation = scoreEvaluation(results, []);
      assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    }
    assert.equal(criterion.value, ` \n${value}\t `);
  });

  it('preserves each requirement level on successful and unavailable judgments', async () => {
    const criteria = REQUIREMENT_LEVELS.map((requirement_level) => ({
      requirement_level,
      value: `The implementation ${requirement_level} create a subscription.`,
    }));
    for (const available of [true, false]) {
      const results = await judgeCriteria(
        { transcript: EMPTY_TRANSCRIPT, criteria },
        async () => (available ? valid() : '{}'),
        noRetryWait,
      );
      assert.deepEqual(
        results.map((result) => result.requirement_level),
        REQUIREMENT_LEVELS,
      );
      assert.ok(
        results.every((result) => result.passed === (available ? true : null)),
      );
    }
  });

  it('validates every classification before starting any judge calls', async () => {
    let calls = 0;
    await assert.rejects(
      judgeCriteria(
        {
          transcript: EMPTY_TRANSCRIPT,
          criteria: [
            'Creates a subscription.',
            {
              requirement_level: 'MUST' as const,
              value: 'Do not create another subscription.',
            },
          ],
        },
        async () => {
          calls += 1;
          return valid();
        },
      ),
      /MUST criteria must use the uppercase RFC keyword MUST/,
    );
    assert.equal(calls, 0);
  });

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
      {
        criterion: 'THE_CRITERION',
        requirement_level: 'SHOULD' as const,
        passed: true,
        explanation: 'yes',
      },
    ]);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.temperature, 0);
    assert.equal(request.maxTokens, 1024);
    assert.equal(request.responseSchema, CRITERION_JUDGMENT_RESPONSE_SCHEMA);
    assert.deepEqual(request.messages, [
      { role: 'user', content: 'Return the requested structured judgment.' },
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
    const results = await judgeCriteria(
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: [
          {
            requirement_level: 'SHOULD' as const,
            label: 'correctness',
            value: 'Correct answer',
          },
          {
            label: 'source',
            value: 'Read page A',
            requirement_level: 'OPTIONAL' as const,
          },
          {
            label: 'source',
            value: 'Does not read page B',
            requirement_level: 'OPTIONAL' as const,
          },
          'Optional behavior',
        ],
      },
      async (request) => {
        requests.push(request);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return valid(!request.systemPrompt.includes('Read page A'));
      },
    );
    assert.equal(requests.length, 4);
    for (const request of requests)
      assert.doesNotMatch(
        request.systemPrompt,
        /correctness|requirement_level|\[object Object\]/,
      );
    assert.deepEqual(results, [
      {
        criterion: 'Correct answer',
        label: 'correctness',
        requirement_level: 'SHOULD' as const,
        passed: true,
        explanation: 'yes',
      },
      {
        criterion: 'Read page A',
        label: 'source',
        requirement_level: 'OPTIONAL' as const,
        passed: false,
        explanation: 'yes',
      },
      {
        criterion: 'Does not read page B',
        label: 'source',
        requirement_level: 'OPTIONAL' as const,
        passed: true,
        explanation: 'yes',
      },
      {
        criterion: 'Optional behavior',
        requirement_level: 'SHOULD' as const,
        passed: true,
        explanation: 'yes',
      },
    ]);
  });

  it('omits the optional example and workspace sections', () => {
    const prompt = buildCriterionJudgePrompt(
      { transcript: visibleTranscript('TRANSCRIPT') },
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
          transcript: { transcriptJson: '[]\n' } as never,
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
    const criteria = Array.from({ length: 10 }, (_, index) => ({
      requirement_level: 'SHOULD' as const,
      value: `CRITERION_${index}`,
    }));
    let active = 0;
    let maximumActive = 0;
    const invoke: CriterionCompletionInvoker = async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const prompt = request.systemPrompt;
      const index = criteria.findIndex((criterion) =>
        prompt.includes(`Success Criterion:\n${criterion.value}\n`),
      );
      return valid(index % 2 === 0, `result ${index}`);
    };

    const results = await judgeCriteria(
      { transcript: EMPTY_TRANSCRIPT, criteria },
      invoke,
    );

    assert.equal(maximumActive, 4);
    assert.deepEqual(
      results,
      criteria.map((criterion, index) => ({
        criterion: criterion.value,
        requirement_level: 'SHOULD' as const,
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
        requirement_level: 'SHOULD' as const,
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
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: ['criterion'],
      },
      invoke,
      noRetryWait,
    );

    assert.equal(calls, 2);
    assert.deepEqual(results, [
      {
        criterion: 'criterion',
        requirement_level: 'SHOULD' as const,
        passed: true,
        explanation: 'recovered',
      },
    ]);
  });

  it('records the final request error message without its stack or other properties', async () => {
    let calls = 0;
    const invoke: CriterionCompletionInvoker = async () => {
      calls += 1;
      throw Object.assign(new Error(`transport failed on attempt ${calls}`), {
        cause: 'private cause',
        response: 'private response',
      });
    };

    const results = await judgeCriteria(
      { transcript: EMPTY_TRANSCRIPT, criteria: ['criterion'] },
      invoke,
      noRetryWait,
    );
    assert.deepEqual(results, [
      {
        criterion: 'criterion',
        requirement_level: 'SHOULD',
        passed: null,
        error: {
          type: 'request_error',
          attempts: 3,
          message: 'transport failed on attempt 3',
        },
        explanation: 'Judge request failed after 3 attempts.',
      },
    ]);
    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
  });

  it('preserves peer judgments after one transport failure is exhausted', async () => {
    let failingCalls = 0;
    let peerCalls = 0;
    const transportFailure = new Error('transport failed');

    const results = await judgeCriteria(
      { transcript: EMPTY_TRANSCRIPT, criteria: ['failing', 'peer'] },
      async (request) => {
        if (request.systemPrompt.includes('Success Criterion:\nfailing\n')) {
          failingCalls += 1;
          throw transportFailure;
        }
        peerCalls += 1;
        assert.equal(request.signal.aborted, false);
        return valid(true, 'Peer passed.');
      },
      noRetryWait,
    );

    assert.equal(failingCalls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.equal(peerCalls, 1);
    assert.equal(results[0]!.passed, null);
    assert.deepEqual(results[1], {
      criterion: 'peer',
      requirement_level: 'SHOULD',
      passed: true,
      explanation: 'Peer passed.',
    });
  });

  it('records a parse error after three malformed responses without retaining raw output', async () => {
    let calls = 0;
    const invoke: CriterionCompletionInvoker = async () => {
      calls += 1;
      return 'secret malformed output';
    };

    const results = await judgeCriteria(
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: ['criterion'],
      },
      invoke,
      noRetryWait,
    );

    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.deepEqual(results, [
      {
        criterion: 'criterion',
        requirement_level: 'SHOULD' as const,
        passed: null,
        error: {
          type: 'parse_error',
          attempts: 3,
          message: 'Judge response was not valid JSON.',
        },
        explanation:
          'Judge response was not valid JSON. (unavailable after 3 attempts)',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(results), /secret malformed output/);
  });

  it('excludes an exhausted malformed criterion from the score denominator alongside a successful peer', async () => {
    let failedCalls = 0;
    const results = await judgeCriteria(
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: ['unavailable', 'successful'],
      },
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
        criterion: 'unavailable',
        requirement_level: 'SHOULD' as const,
        passed: null,
        error: {
          type: 'parse_error',
          attempts: 3,
          message: 'Judge response was not valid JSON.',
        },
        explanation:
          'Judge response was not valid JSON. (unavailable after 3 attempts)',
      },
      {
        criterion: 'successful',
        requirement_level: 'SHOULD' as const,
        passed: true,
        explanation: 'completed',
      },
    ]);
    const evaluation = scoreEvaluation(results, [
      { name: 'file', passed: true },
    ]);
    assert.equal(evaluation.score, 1);
    assert.equal(evaluation.judging_criteria_total, 2);
    assert.equal(evaluation.judging_criteria_passed, 1);
    assert.equal(evaluation.judging_criteria_errored, 1);
    assert.equal(evaluation.status, 'judge_error');
    assert.doesNotMatch(JSON.stringify(evaluation), /private/);
  });

  it('classifies a final request failure after earlier malformed responses', async () => {
    const failure = new Error('final transport failure');
    let calls = 0;
    const results = await judgeCriteria(
      { transcript: EMPTY_TRANSCRIPT, criteria: ['criterion'] },
      async () => {
        calls += 1;
        if (calls === MAX_CRITERION_JUDGE_ATTEMPTS) throw failure;
        return '{}';
      },
      noRetryWait,
    );
    assert.deepEqual(results[0]!.error, {
      type: 'request_error',
      attempts: 3,
      message: 'final transport failure',
    });
    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
  });

  it('treats an explanation too large for the result artifact as malformed', async () => {
    let calls = 0;
    const oversized = 'x'.repeat(MAX_CRITERION_EXPLANATION_CHARACTERS + 1);
    const results = await judgeCriteria(
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: ['criterion'],
      },
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
        requirement_level: 'SHOULD' as const,
        passed: null,
        error: {
          type: 'parse_error',
          attempts: 3,
          message:
            'Judge response did not match the required schema at response.results[0].explanation (too_big).',
        },
        explanation:
          'Judge response did not match the required schema. (unavailable after 3 attempts)',
      },
    ]);
  });

  it('aborts peer judgments without retrying a dispatch invariant failure', async () => {
    const invariant = new Error('Unsafe dispatch.');
    let invocations = 0;
    let retries = 0;
    await assert.rejects(
      judgeCriteria(
        { transcript: EMPTY_TRANSCRIPT, criteria: ['peer', 'unsafe'] },
        (request) => {
          invocations += 1;
          return new Promise<string>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        },
        {
          validateRequest(request) {
            if (request.systemPrompt.includes('Success Criterion:\nunsafe\n'))
              throw invariant;
          },
          waitBeforeRetry: async () => {
            retries += 1;
          },
        },
      ),
      (error: unknown) => error === invariant,
    );
    assert.equal(invocations, 1);
    assert.equal(retries, 0);
  });

  it('redacts request diagnostics for a custom invoker', async () => {
    const [result] = await judgeCriteria(
      { transcript: EMPTY_TRANSCRIPT, criteria: ['criterion'] },
      async () => {
        throw new Error('Denied for custom-secret.');
      },
      { ...noRetryWait, redactionSecrets: ['custom-secret'] },
    );
    assert.equal(result!.error!.message, 'Denied for [REDACTED].');
  });

  it('propagates cancellation even if the invocation returns a valid judgment', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    await assert.rejects(
      judgeCriteria(
        {
          transcript: EMPTY_TRANSCRIPT,
          criteria: ['criterion'],
          signal: controller.signal,
        },
        async () => {
          controller.abort(reason);
          return valid();
        },
        noRetryWait,
      ),
      (error: unknown) => error === reason,
    );
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
    await assert.rejects(
      judgeCriteria(
        {
          transcript: EMPTY_TRANSCRIPT,
          criteria: ['criterion'],
          signal: controller.signal,
        },
        async () => {
          calls += 1;
          setImmediate(() => controller.abort(reason));
          return '{}';
        },
      ),
      (error: unknown) => error === reason,
    );
    assert.equal(calls, 1);
  });

  it('does not invoke a completion for an empty criterion list', async () => {
    let calls = 0;
    const results = await judgeCriteria(
      { transcript: EMPTY_TRANSCRIPT, criteria: [] },
      async () => {
        calls += 1;
        return valid();
      },
    );

    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it('uses the default one-second and five-second retry waits', async (t) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    t.onTestFinished(() => {
      vi.useRealTimers();
    });
    let calls = 0;
    const pending = judgeCriteria(
      {
        transcript: EMPTY_TRANSCRIPT,
        criteria: ['criterion'],
      },
      async () => {
        calls += 1;
        return '{}';
      },
    );
    const nextTurn = () =>
      new Promise<void>((resolve) => setImmediate(resolve));
    await nextTurn();
    assert.equal(calls, 1);
    vi.advanceTimersByTime(999);
    await nextTurn();
    assert.equal(calls, 1);
    vi.advanceTimersByTime(1);
    await nextTurn();
    assert.equal(calls, 2);
    vi.advanceTimersByTime(4_999);
    await nextTurn();
    assert.equal(calls, 2);
    vi.advanceTimersByTime(1);
    const results = await pending;
    assert.equal(calls, 3);
    assert.equal(results[0]?.passed, null);
  });
});

describe('parseCriterionJudgment', () => {
  it('returns canonical criterion text that survives artifact parsing at the size limit', () => {
    const value = 'x'.repeat(64 * 1024);
    const criterion = {
      requirement_level: 'SHOULD' as const,
      value: ` \n${value}\t `,
    };
    for (const raw of [valid(), '{}']) {
      const result = parseCriterionJudgment(raw, criterion);
      assert.equal(result.criterion, value);
      const evaluation = scoreEvaluation([result], []);
      assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    }
    assert.equal(criterion.value, ` \n${value}\t `);
  });

  it('accepts JSON explanations containing Markdown backticks and escaped characters', () => {
    const explanation =
      '  Missing `cancel_url`; expected "https://example.com/cancel".\nCheck C:\\checkout.  ';
    assert.deepEqual(
      parseCriterionJudgment(valid(false, explanation), 'criterion'),
      {
        criterion: 'criterion',
        requirement_level: 'SHOULD' as const,
        passed: false,
        explanation: explanation.trim(),
      },
    );
  });

  it('rejects illegal backslash-backtick escapes in an explanation', () => {
    const raw =
      '{"results":[{"index":0,"passed":true,"explanation":"Missing \\`cancel_url\\`."}]}';
    assert.deepEqual(parseCriterionJudgment(raw, 'criterion'), {
      criterion: 'criterion',
      requirement_level: 'SHOULD' as const,
      passed: null,
      error: {
        type: 'parse_error',
        attempts: 1,
        message: 'Judge response was not valid JSON.',
      },
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
        requirement_level: 'SHOULD' as const,
        passed: null,
        error: {
          type: 'parse_error',
          attempts: 1,
          message: 'Judge response was not valid JSON.',
        },
        explanation: 'Judge response was not valid JSON.',
      });
    }
  });

  it('reports parse errors for extra fields, the wrong index, blank explanations, and wrong result counts', () => {
    const entry = { index: 0, passed: true, explanation: 'ok' };
    for (const [response, diagnostic] of [
      [
        { results: [{ ...entry, extra: true }] },
        'response.results[0] (unrecognized_keys)',
      ],
      [
        { results: [{ ...entry, index: 1 }] },
        'response.results[0].index (invalid_value)',
      ],
      [
        { results: [{ ...entry, explanation: '' }] },
        'response.results[0].explanation (too_small)',
      ],
      [
        { results: [{ ...entry, explanation: '   ' }] },
        'response.results[0].explanation (too_small)',
      ],
      [
        { results: [{ ...entry, explanation: '\t\r\n' }] },
        'response.results[0].explanation (too_small)',
      ],
      [{ results: [entry], extra: true }, 'response (unrecognized_keys)'],
      [{ results: [] }, 'response.results (too_small)'],
      [{ results: [entry, entry] }, 'response.results (too_big)'],
    ] as const) {
      assert.deepEqual(parseCriterionJudgment(JSON.stringify(response), 'g'), {
        criterion: 'g',
        requirement_level: 'SHOULD' as const,
        passed: null,
        error: {
          type: 'parse_error',
          attempts: 1,
          message: `Judge response did not match the required schema at ${diagnostic}.`,
        },
        explanation: 'Judge response did not match the required schema.',
      });
    }
  });

  it('keeps unknown keys and received values out of schema diagnostics', () => {
    for (const response of [
      { results: [{ index: 'secret-index', passed: true, explanation: 'ok' }] },
      { results: [{ index: 0, passed: 'secret-pass', explanation: 'ok' }] },
      {
        results: [
          { index: 0, passed: true, explanation: 'ok', 'secret-key': true },
        ],
      },
    ]) {
      const result = parseCriterionJudgment(
        JSON.stringify(response),
        'criterion',
      );
      assert.match(
        result.error!.message,
        /required schema at response.results\[0\]/,
      );
      assert.doesNotMatch(JSON.stringify(result), /secret/);
    }
  });
});
