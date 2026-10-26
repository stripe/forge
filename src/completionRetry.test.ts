import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  completionRetryDecision,
  INITIAL_COMPLETION_RETRY_STATE,
  waitForCompletionRetry,
} from './completionRetry.ts';
import { CompletionInvocationError } from './contracts/completion.ts';

const failure = (status: number, retryAfter?: number) =>
  new CompletionInvocationError('http_error', 'HTTP failure', {
    origin: 'host_transport',
    http_status: status,
    ...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter }),
  });

describe('completion retry policy', () => {
  it('gives rate limits their own budget and leaves the fallback budget intact', () => {
    let state = INITIAL_COMPLETION_RETRY_STATE;
    const delays = [];
    for (let i = 0; i < 6; i += 1) {
      const next = completionRetryDecision(state, failure(429), false, 1);
      state = next.state;
      delays.push(next.decision.wait_ms);
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 64000]);
    assert.equal(
      completionRetryDecision(state, failure(429), false, 1).decision
        .disposition,
      'exhausted',
    );
    assert.equal(
      completionRetryDecision(state, failure(502), false, 1).decision.wait_ms,
      4000,
    );
  });

  it('uses the short schedule for stable client failures and the long fallback otherwise', () => {
    for (const error of [
      failure(400),
      failure(401),
      failure(403),
      failure(404),
      new CompletionInvocationError('invalid_credentials', 'invalid'),
    ]) {
      let state = INITIAL_COMPLETION_RETRY_STATE;
      for (const expected of [1000, 5000, 0]) {
        const next = completionRetryDecision(state, error, false, 1);
        state = next.state;
        assert.equal(next.decision.wait_ms, expected);
      }
    }
    for (const error of [
      failure(502),
      failure(503),
      new Error('unknown'),
      new CompletionInvocationError('timeout', 'timeout'),
    ]) {
      let state = INITIAL_COMPLETION_RETRY_STATE;
      for (const expected of [4000, 16000, 64000, 0]) {
        const next = completionRetryDecision(state, error, false, 1);
        state = next.state;
        assert.equal(next.decision.wait_ms, expected);
      }
    }
    assert.equal(
      completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        failure(503, 23000),
        false,
        0,
      ).decision.wait_ms,
      23000,
    );
    assert.equal(
      completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        failure(429),
        false,
        0,
      ).decision.wait_ms,
      1500,
    );
  });

  it('aborts the shared sleep without waiting for another attempt', async () => {
    const controller = new AbortController();
    const pending = waitForCompletionRetry(
      failure(429),
      { disposition: 'rate_limit_retry', wait_ms: 64000 },
      controller.signal,
      {},
    );
    controller.abort(new Error('stop retrying'));
    await assert.rejects(pending, /stop retrying/);
  });
  it('records only elapsed time when a rate-limit wait is interrupted', async () => {
    const controller = new AbortController();
    let elapsed = 0;
    const decisions: unknown[] = [];
    await assert.rejects(
      waitForCompletionRetry(
        failure(429),
        { disposition: 'rate_limit_retry', wait_ms: 64000 },
        controller.signal,
        {
          now: () => elapsed,
          sleep: async () => {
            elapsed = 123;
            controller.abort(new Error('stop'));
          },
          onRetryDecision: (_error, decision) => decisions.push(decision),
        },
      ),
      /stop/,
    );
    assert.deepEqual(decisions, [
      { disposition: 'rate_limit_retry', wait_ms: 123 },
    ]);
  });
});
