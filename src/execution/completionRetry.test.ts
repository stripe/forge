import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { CompletionInvocationError } from '../contracts/completion.ts';
import { judgeCriteria } from '../evaluation/criterionJudge.ts';
import { createJudgeTranscriptProjection } from '../evaluation/judgeTranscript.ts';
import { scoreEvaluation } from '../evaluation/score.ts';
import { AvaRolePlayer } from '../interaction/ava.ts';
import { createAnthropicCompletionProvider } from '../providers/anthropic/index.ts';
import { createOpenAICompletionProvider } from '../providers/openai/index.ts';
import { parseEvaluationResult } from '../results/parse.ts';
import { MAX_COMPLETION_CALL_SUMMARIES } from '../results/types.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  type ScriptedCompletionStep,
} from '../testing/index.ts';
import {
  completionBindingFor,
  prepareCompletionRuntime,
} from './completionRuntime.ts';

const model = { provider: 'scripted', model: 'test' };
const transcript = createJudgeTranscriptProjection({
  schema_version: 'ATIF-v1.8',
  agent: { name: 'fake', version: '1' },
  steps: [{ step_id: 1, source: 'user', message: 'Do the task.' }],
});
const answer = {
  content:
    '{"answers":{"criterion":{"type":"choice","choice":"met","probabilities":{"met":1,"not_met":0,"insufficient_evidence":0},"confidence":1,"explanation":"Done."}}}',
  stopReason: 'end_turn' as const,
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
};
const signal = new AbortController().signal;
const limited = (status = 429, wait?: number) =>
  new CompletionInvocationError('http_error', 'Unavailable', {
    origin: 'host_transport',
    http_status: status,
    request_id: 'request_synthetic',
    provider_error_code: 'rate_limit_error',
    ...(wait === undefined ? {} : { retry_after_ms: wait }),
  });

async function runtime(
  responses: readonly ScriptedCompletionStep[],
  purpose: 'judge' | 'role_player' = 'judge',
) {
  const scripted = createScriptedCompletionProvider({
    id: model.provider,
    responses,
  });
  const prepared = await prepareCompletionRuntime({
    runId: 'retry-test',
    bindings: [
      completionBindingFor(
        new Map([[model.provider, scripted.provider]]),
        purpose,
        model,
      ),
    ],
    credentialResolver: createStaticCredentialResolver(),
    signal,
  });
  return { prepared, scripted };
}

describe('completion retry integration', () => {
  for (const retryAfter of [undefined, 20000]) {
    it(`recovers after the first simulated minute of 429s (Retry-After ${retryAfter})`, async () => {
      let elapsed = 0;
      const { prepared } = await runtime(
        Array.from({ length: 7 }, () => () => {
          throw limited(429, retryAfter);
        }),
      );
      const binding = prepared.provider('judge');
      const complete = binding.complete;
      const scriptedProvider = {
        ...binding,
        complete: (...args: Parameters<typeof complete>) =>
          elapsed < 60000 ? complete(...args) : Promise.resolve(answer),
      };
      const observed = await prepareCompletionRuntime({
        runId: 'minute-test',
        bindings: [
          completionBindingFor(
            new Map([[model.provider, scriptedProvider]]),
            'judge',
            model,
          ),
        ],
        credentialResolver: createStaticCredentialResolver(),
        signal,
      });
      const result = await judgeCriteria(
        { transcript, criteria: ['Done'], signal },
        async (request) =>
          (await observed.invoke('judge', request, request.signal)).content,
        {
          now: () => elapsed,
          random: () => 1,
          sleep: async (milliseconds) => {
            elapsed += milliseconds;
          },
          onRetryDecision: observed.recordRetryDecision,
        },
      );
      assert.equal(result[0]!.passed, true);
      assert.equal(elapsed, retryAfter === undefined ? 62000 : 60000);
      assert.equal(observed.totals.rate_limit_wait_ms, elapsed);
      assert.equal(observed.calls[0]!.http_status, 429);
      assert.equal(observed.calls[0]!.request_id, 'request_synthetic');
      assert.equal(observed.calls[0]!.provider_error_code, 'rate_limit_error');
      assert.equal(observed.calls[0]!.disposition, 'rate_limit_retry');
      assert.equal(observed.calls.at(-1)!.status, 'succeeded');
      assert.deepEqual(
        observed.calls.map((call) => call.retry_ordinal),
        observed.calls.map((_, index) => index),
      );
    });
  }

  it('keeps concurrent judge ordinals independent and measures 503 waits', async () => {
    let elapsed = 0;
    const { prepared } = await runtime([limited(503, 23000), answer, answer]);
    const judgments = await judgeCriteria(
      { transcript, criteria: ['First', 'Second'], signal },
      async (request) =>
        (await prepared.invoke('judge', request, request.signal)).content,
      {
        now: () => elapsed,
        random: () => 1,
        sleep: async (ms) => {
          elapsed += ms;
        },
        onRetryDecision: prepared.recordRetryDecision,
      },
    );
    assert.equal(
      judgments.every((result) => result.passed),
      true,
    );
    assert.deepEqual(
      prepared.calls.map((call) => call.retry_ordinal),
      [0, 0, 1],
    );
    assert.equal(prepared.totals.rate_limit_wait_ms, 23000);
  });

  it('commits the same Ava error outcome when the rate-limit budget runs out', async () => {
    let elapsed = 0;
    const { prepared, scripted } = await runtime(
      Array.from({ length: 7 }, () => limited()),
      'role_player',
    );
    const turn = await new AvaRolePlayer(
      { task: 'Do the task.', signal },
      (request) => prepared.invoke('role_player', request, request.signal),
      {
        now: () => elapsed,
        random: () => 1,
        sleep: async (ms) => {
          elapsed += ms;
        },
        onRetryDecision: prepared.recordRetryDecision,
      },
    ).nextTurn();
    assert.equal(turn.error?.errorType, 'request_error');
    assert.equal(turn.error?.attempts, 7);
    assert.equal(scripted.calls.length, 7);
    assert.equal(prepared.calls.at(-1)!.disposition, 'exhausted');
    assert.equal(prepared.totals.rate_limit_wait_ms, 126000);
  });

  for (const [status, attempts, elapsedMs] of [
    [502, 4, 84000],
    [503, 4, 84000],
    [400, 3, 6000],
  ] as const) {
    it(`exhausts HTTP ${status} with the expected waits and a criterion error`, async () => {
      let elapsed = 0;
      const { prepared } = await runtime(
        Array.from({ length: attempts }, () => limited(status)),
      );
      const results = await judgeCriteria(
        { transcript, criteria: ['Done'], signal },
        async (request) =>
          (await prepared.invoke('judge', request, request.signal)).content,
        {
          now: () => elapsed,
          random: () => 1,
          sleep: async (ms) => {
            elapsed += ms;
          },
          onRetryDecision: prepared.recordRetryDecision,
        },
      );
      assert.equal(results[0]!.error?.type, 'request_error');
      assert.equal(results[0]!.error?.attempts, attempts);
      assert.equal(elapsed, elapsedMs);
      assert.equal(prepared.totals.rate_limit_wait_ms, 0);
      assert.equal(prepared.calls.at(-1)!.disposition, 'exhausted');
    });
  }

  for (const purpose of ['judge', 'role_player'] as const) {
    it(`bounds all three retry budgets for ${purpose} and keeps the terminal result readable`, async () => {
      const outputFailure = () =>
        new CompletionInvocationError('invalid_output', 'Malformed output');
      const { prepared } = await runtime(
        [
          ...Array.from({ length: 6 }, () => limited()),
          ...Array.from({ length: 3 }, () => limited(502)),
          ...Array.from({ length: 3 }, outputFailure),
        ],
        purpose,
      );
      let elapsed = 0;
      const waits: number[] = [];
      const options = {
        now: () => elapsed,
        random: () => 1,
        sleep: async (ms: number) => {
          elapsed += ms;
          waits.push(ms);
        },
        onRetryDecision: prepared.recordRetryDecision,
      };
      if (purpose === 'judge') {
        const results = await judgeCriteria(
          { transcript, criteria: ['Done'], signal },
          async (request) =>
            (await prepared.invoke(purpose, request, request.signal)).content,
          options,
        );
        assert.equal(results[0]!.error?.attempts, 12);
        const evaluation = scoreEvaluation(results, []);
        assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
      } else {
        const turn = await new AvaRolePlayer(
          { task: 'Do the task.', signal },
          (request) => prepared.invoke(purpose, request, request.signal),
          options,
        ).nextTurn();
        assert.equal(turn.error?.attempts, 12);
      }
      assert.deepEqual(
        waits,
        [2000, 4000, 8000, 16000, 32000, 64000, 4000, 16000, 64000, 1000, 5000],
      );
      assert.equal(prepared.calls.length, 12);
      assert.equal(prepared.calls.at(-1)!.retry_ordinal, 11);
      assert.equal(prepared.calls.at(-1)!.disposition, 'exhausted');
      assert.equal(prepared.totals.rate_limit_wait_ms, 126000);
    });
  }

  it('bounds retained records while counting omitted calls and their waits', async () => {
    const { prepared } = await runtime(
      Array.from({ length: MAX_COMPLETION_CALL_SUMMARIES + 2 }, () =>
        limited(),
      ),
    );
    for (let index = 0; index < MAX_COMPLETION_CALL_SUMMARIES + 2; index += 1) {
      try {
        await prepared.invoke('judge', { messages: [] }, signal);
      } catch (error) {
        prepared.recordRetryDecision(error, {
          disposition: 'rate_limit_retry',
          wait_ms: 1000,
        });
      }
    }
    assert.equal(prepared.calls.length, MAX_COMPLETION_CALL_SUMMARIES);
    assert.deepEqual(prepared.totals, {
      calls: MAX_COMPLETION_CALL_SUMMARIES + 2,
      failed: MAX_COMPLETION_CALL_SUMMARIES + 2,
      omitted: 2,
      rate_limit_wait_ms: (MAX_COMPLETION_CALL_SUMMARIES + 2) * 1000,
    });
  });
});

describe('built-in provider output retries through the completion runtime', () => {
  for (const providerId of ['openai', 'anthropic'] as const) {
    for (const purpose of ['role_player', 'judge'] as const) {
      for (const failureKind of [
        'invalid_output',
        'invalid_response',
        'insufficient_quota',
      ] as const) {
        const invalidEnvelope = failureKind === 'invalid_response';
        const quotaExhausted = failureKind === 'insufficient_quota';
        it(`${providerId} ${purpose} applies the retry policy to ${failureKind}`, async () => {
          let elapsed = 0;
          let requests = 0;
          const waits: number[] = [];
          const content = '{"results":[';
          const usage = {
            input_tokens: invalidEnvelope ? -1 : 1,
            output_tokens: 1,
          };
          const fetch: typeof globalThis.fetch = async () => {
            requests += 1;
            if (quotaExhausted)
              return Response.json(
                { error: { code: 'insufficient_quota' } },
                {
                  status: 429,
                  headers: { 'retry-after': '64' },
                },
              );
            return Response.json(
              providerId === 'openai'
                ? {
                    object: 'response',
                    status: 'completed',
                    output: [
                      {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: content }],
                      },
                    ],
                    usage,
                  }
                : {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'text', text: content }],
                    stop_reason: 'end_turn',
                    usage,
                  },
            );
          };
          const provider =
            providerId === 'openai'
              ? createOpenAICompletionProvider({
                  fetch,
                  credential: 'test-key',
                })
              : createAnthropicCompletionProvider({
                  fetch,
                  credential: 'test-key',
                });
          const prepared = await prepareCompletionRuntime({
            runId: 'output-retry-test',
            bindings: [
              completionBindingFor(new Map([[providerId, provider]]), purpose, {
                provider: providerId,
                model:
                  providerId === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-5',
              }),
            ],
            credentialResolver: createStaticCredentialResolver({
              'test-key': 'synthetic-secret',
            }),
            signal,
          });
          const options = {
            now: () => elapsed,
            random: () => 1,
            sleep: async (ms: number) => {
              elapsed += ms;
              waits.push(ms);
            },
            onRetryDecision: prepared.recordRetryDecision,
          };
          const attempts = quotaExhausted ? 1 : invalidEnvelope ? 4 : 3;
          if (purpose === 'role_player') {
            const turn = await new AvaRolePlayer(
              { task: 'Do the task.', signal },
              (request) => prepared.invoke(purpose, request, request.signal),
              options,
            ).nextTurn();
            assert.equal(turn.error?.errorType, 'request_error');
            assert.equal(turn.error?.attempts, attempts);
          } else {
            const results = await judgeCriteria(
              { transcript, criteria: ['Done'], signal },
              async (request) =>
                (await prepared.invoke(purpose, request, request.signal))
                  .content,
              options,
            );
            assert.equal(results[0]!.error?.type, 'request_error');
            assert.equal(results[0]!.error?.attempts, attempts);
          }
          assert.equal(requests, attempts);
          assert.deepEqual(
            waits,
            quotaExhausted
              ? []
              : invalidEnvelope
                ? [4000, 16000, 64000]
                : [1000, 5000],
          );
          assert.deepEqual(
            prepared.calls.map((call) => call.error_code),
            Array.from({ length: attempts }, () =>
              quotaExhausted ? 'http_error' : failureKind,
            ),
          );
          assert.deepEqual(
            prepared.calls.map((call) => call.retry_ordinal),
            Array.from({ length: attempts }, (_, index) => index),
          );
          assert.equal(prepared.calls.at(-1)!.disposition, 'exhausted');
          assert.equal(prepared.totals.rate_limit_wait_ms, 0);
          if (quotaExhausted)
            assert.equal(
              prepared.calls[0]!.provider_error_code,
              'insufficient_quota',
            );
        });
      }
    }
  }
});
