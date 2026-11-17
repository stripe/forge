import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  completionRetryDecision,
  INITIAL_COMPLETION_RETRY_STATE,
  MAX_COMPLETION_ATTEMPTS,
  retryCompletion,
  waitForCompletionRetry,
} from './completionRetry.ts';
import { CompletionInvocationError } from './contracts/completion.ts';
import {
  COMPLETION_PROVIDER_ERROR_CLASS,
  type CompletionProviderErrorCode,
  completionProviderErrorCodeSchema,
} from './contracts/completionObservation.ts';
import { observeCompletionFailure } from './providers/transportObservation.ts';
import { MAX_RECORDED_COMPLETION_ATTEMPTS } from './results/types.ts';

const failure = (status: number, retryAfter?: number) =>
  new CompletionInvocationError('http_error', 'HTTP failure', {
    origin: 'host_transport',
    http_status: status,
    ...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter }),
  });

describe('completion retry policy', () => {
  it('fits inside the attempt bound owned by saved results', () => {
    assert.ok(MAX_COMPLETION_ATTEMPTS <= MAX_RECORDED_COMPLETION_ATTEMPTS);
  });

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

  it('never lets zero, past, or small Retry-After hints shorten scheduled backoff', async () => {
    for (const status of [429, 503]) {
      for (const header of ['0', '0.001', 'Wed, 31 Dec 2025 00:00:00 GMT']) {
        const observation = await observeCompletionFailure(
          new Response('{}', { status, headers: { 'retry-after': header } }),
          'openai',
          new AbortController().signal,
          Date.parse('2026-01-01T00:00:00Z'),
        );
        const error = new CompletionInvocationError(
          'http_error',
          'Unavailable',
          observation,
        );
        let state = INITIAL_COMPLETION_RETRY_STATE;
        const waits = [];
        for (let index = 0; index < 6; index += 1) {
          const next = completionRetryDecision(state, error, false, 1);
          waits.push(next.decision.wait_ms);
          assert.equal(next.decision.disposition, 'rate_limit_retry');
          state = next.state;
        }
        assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000, 64000]);
        assert.equal(
          completionRetryDecision(state, error, false, 1).decision.disposition,
          'exhausted',
        );
      }
    }
  });

  it('gives short and long failures independent budgets in either order', () => {
    for (const shortFirst of [false, true]) {
      const groups = [
        { error: failure(502), parse: false, waits: [4000, 16000, 64000] },
        { error: undefined, parse: true, waits: [1000, 5000] },
      ];
      if (shortFirst) groups.reverse();
      let state = INITIAL_COMPLETION_RETRY_STATE;
      for (const { error, parse, waits } of groups) {
        for (const wait of waits) {
          const next = completionRetryDecision(state, error, parse, 1);
          assert.equal(next.decision.disposition, 'retry');
          assert.equal(next.decision.wait_ms, wait);
          state = next.state;
        }
        assert.equal(
          completionRetryDecision(state, error, parse, 1).decision.disposition,
          'exhausted',
        );
      }
      assert.equal(state.ordinal, 5);
    }
  });

  it('stops immediately for permanent quota failures even with Retry-After', () => {
    for (const hint of [undefined, 64000]) {
      const error = new CompletionInvocationError('http_error', 'Unavailable', {
        origin: 'host_transport',
        http_status: 429,
        provider_error_code: 'insufficient_quota',
        ...(hint === undefined ? {} : { retry_after_ms: hint }),
      });
      const next = completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        error,
        false,
        1,
      );
      assert.deepEqual(next.decision, { disposition: 'exhausted', wait_ms: 0 });
      assert.equal(next.state, INITIAL_COMPLETION_RETRY_STATE);
    }
  });

  it('uses a bounded fallback for invalid observations or non-finite random values', () => {
    for (const random of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      assert.equal(
        completionRetryDecision(
          INITIAL_COMPLETION_RETRY_STATE,
          failure(429),
          false,
          random,
        ).decision.wait_ms,
        2000,
      );
    }
    assert.equal(
      completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        failure(429, Number.NaN),
        false,
        1,
      ).decision.wait_ms,
      4000,
    );
  });

  it('keeps retry execution and abort reasons independent of failed observation callbacks', async () => {
    const signal = new AbortController().signal;
    for (const disposition of ['retry', 'exhausted'] as const) {
      await waitForCompletionRetry(1, { disposition, wait_ms: 0 }, signal, {
        sleep: async () => {},
        onRetryDecision:
          disposition === 'retry'
            ? async () => {
                throw new Error('observer unavailable');
              }
            : () => {
                throw new Error('observer unavailable');
              },
      });
    }
    const controller = new AbortController();
    await assert.rejects(
      waitForCompletionRetry(
        1,
        { disposition: 'retry', wait_ms: 1000 },
        controller.signal,
        {
          sleep: async () => {
            controller.abort(new Error('original abort'));
          },
          onRetryDecision: () => {
            throw new Error('observer unavailable');
          },
        },
      ),
      /original abort/,
    );
  });

  it('leaves wait measurements unknown when the observation clock fails or moves backward', async () => {
    let backwardsClock = 10;
    for (const now of [
      () => {
        const value = backwardsClock;
        backwardsClock = 0;
        return value;
      },
      () => Number.NaN,
      () => {
        throw new Error('clock unavailable');
      },
    ]) {
      let slept = false;
      let observations = 0;
      await waitForCompletionRetry(
        1,
        { disposition: 'retry', wait_ms: 1000 },
        new AbortController().signal,
        {
          now,
          sleep: async () => {
            slept = true;
          },
          onRetryDecision: () => {
            observations += 1;
          },
        },
      );
      assert.equal(slept, true);
      assert.equal(observations, 0);
    }
  });

  it('aborts the shared sleep without waiting for another attempt', async () => {
    const controller = new AbortController();
    const pending = waitForCompletionRetry(
      1,
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
        1,
        { disposition: 'rate_limit_retry', wait_ms: 64000 },
        controller.signal,
        {
          now: () => elapsed,
          sleep: async () => {
            elapsed = 123;
            controller.abort(new Error('stop'));
          },
          onRetryDecision: (_sequence, decision) => decisions.push(decision),
        },
      ),
      /stop/,
    );
    assert.deepEqual(decisions, [
      { disposition: 'rate_limit_retry', wait_ms: 123 },
    ]);
  });

  it('classifies every recognized provider error code', () => {
    for (const code of completionProviderErrorCodeSchema.options) {
      assert.ok(code in COMPLETION_PROVIDER_ERROR_CLASS, code);
    }
    // Rate-limit and server-fault codes follow the HTTP status, not the code.
    const coded = (status: number, code: CompletionProviderErrorCode) =>
      completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        new CompletionInvocationError('http_error', 'Failed', {
          origin: 'host_transport',
          http_status: status,
          provider_error_code: code,
        }),
        false,
        1,
      ).decision;
    assert.deepEqual(coded(429, 'rate_limit_exceeded'), {
      disposition: 'rate_limit_retry',
      wait_ms: 2000,
    });
    assert.deepEqual(coded(500, 'rate_limit_exceeded'), {
      disposition: 'retry',
      wait_ms: 4000,
    });
    assert.deepEqual(coded(500, 'invalid_api_key'), {
      disposition: 'retry',
      wait_ms: 1000,
    });
    assert.deepEqual(coded(529, 'overloaded_error'), {
      disposition: 'retry',
      wait_ms: 4000,
    });
    assert.deepEqual(coded(500, 'insufficient_quota'), {
      disposition: 'exhausted',
      wait_ms: 0,
    });
  });

  it('does not start a wait that would reach the remaining run time', () => {
    const decide = (remaining: number) =>
      completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        failure(429),
        false,
        1,
        remaining,
      );
    assert.deepEqual(decide(2000).decision, {
      disposition: 'exhausted',
      wait_ms: 0,
    });
    assert.equal(decide(2000).state, INITIAL_COMPLETION_RETRY_STATE);
    assert.deepEqual(decide(2001).decision, {
      disposition: 'rate_limit_retry',
      wait_ms: 2000,
    });
    // A Retry-After floor counts toward the wait that must fit.
    assert.equal(
      completionRetryDecision(
        INITIAL_COMPLETION_RETRY_STATE,
        failure(429, 30000),
        false,
        1,
        10000,
      ).decision.disposition,
      'exhausted',
    );
  });

  describe('retryCompletion', () => {
    const signal = new AbortController().signal;
    const failing = async () => ({
      ok: false as const,
      error: failure(429),
      parseFailure: false,
    });

    it('returns the first success and counts attempts on exhaustion', async () => {
      const waits: number[] = [];
      const sleep = async (ms: number) => {
        waits.push(ms);
      };
      assert.deepEqual(
        await retryCompletion(signal, { sleep, random: () => 1 }, async (n) =>
          n < 3 ? failing() : { ok: true, value: n },
        ),
        { ok: true, value: 3 },
      );
      assert.deepEqual(waits, [2000, 4000]);
      const exhausted = await retryCompletion(
        signal,
        { sleep, random: () => 1 },
        failing,
      );
      assert.equal(exhausted.ok, false);
      assert.equal(exhausted.ok ? 0 : exhausted.attempts, 7);
    });

    it('stops retrying once the next wait would cross the deadline', async () => {
      let elapsed = 0;
      const waits: number[] = [];
      const exhausted = await retryCompletion(
        signal,
        {
          now: () => elapsed,
          deadline: 7000,
          random: () => 1,
          sleep: async (ms) => {
            waits.push(ms);
            elapsed += ms;
          },
        },
        failing,
      );
      // 2 s + 4 s fit; the 8 s wait would pass the 7 s deadline.
      assert.deepEqual(waits, [2000, 4000]);
      assert.equal(exhausted.ok, false);
      assert.equal(exhausted.ok ? 0 : exhausted.attempts, 3);
    });

    it('prefers sleep over the legacy waitBeforeRetry seam', async () => {
      const sleeps: number[] = [];
      const legacy: number[] = [];
      const options = {
        random: () => 1,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        waitBeforeRetry: async (attempt: number) => {
          legacy.push(attempt);
        },
      };
      await retryCompletion(signal, options, async (n) =>
        n < 2 ? failing() : { ok: true, value: n },
      );
      assert.deepEqual(sleeps, [2000]);
      assert.deepEqual(legacy, []);
      await retryCompletion(
        signal,
        { random: () => 1, waitBeforeRetry: options.waitBeforeRetry },
        async (n) => (n < 2 ? failing() : { ok: true, value: n }),
      );
      assert.deepEqual(legacy, [1]);
    });
  });
});
