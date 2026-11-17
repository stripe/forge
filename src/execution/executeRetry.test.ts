import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { CompletionInvocationError } from '../contracts/completion.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
  type ScriptedCompletionStep,
} from '../testing/index.ts';
import { executeEvalWithTestHooks } from './execute.ts';

const MODEL = { provider: 'test-provider', model: 'model' } as const;
const verdict = JSON.stringify({
  results: [{ index: 0, passed: true, explanation: 'Done.' }],
});
const limited = (retryAfterMs?: number) =>
  new CompletionInvocationError('http_error', 'Rate limited', {
    origin: 'host_transport',
    http_status: 429,
    provider_error_code: 'rate_limit_error',
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
  });

async function run(
  responses: readonly ScriptedCompletionStep[],
  plan: Parameters<typeof executeEvalWithTestHooks>[0]['plan'],
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
) {
  const agent = createScriptedAgentAdapter();
  const provider = createScriptedCompletionProvider({
    id: MODEL.provider,
    responses,
  });
  const waits: number[] = [];
  let elapsed = 0;
  const completed = await executeEvalWithTestHooks(
    {
      runId: 'retry-wiring',
      plan,
      composition: {
        runtime: createFakeRuntimeAdapter().adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createMemoryArtifactStore().store,
      },
    },
    {
      completionRetry: {
        now: () => elapsed,
        random: () => 1,
        sleep:
          sleep ??
          (async (ms) => {
            waits.push(ms);
            elapsed += ms;
          }),
      },
    },
  );
  return { completed, waits };
}

describe('retry evidence through executeEval', () => {
  it('commits the judge retry record and measured rate-limit wait', async () => {
    const { completed, waits } = await run(
      [limited(5000), verdict],
      createTestResolvedRunPlan({
        prompt: 'Do the task.',
        judgingCriteria: ['The task is done.'],
        judge: MODEL,
      }),
    );
    assert.deepEqual(waits, [5000]);
    assert.equal(completed.result.evaluation.judging_criteria[0]?.passed, true);
    const [failed, succeeded] = completed.result.completion_calls;
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.http_status, 429);
    assert.deepEqual(failed?.retry, {
      decision: 'rate_limit_retry',
      wait_ms: 5000,
    });
    assert.equal(succeeded?.retry_ordinal, 1);
    assert.equal(succeeded?.retry, undefined);
    assert.deepEqual(completed.result.completion_call_totals, {
      calls: 2,
      failed: 1,
      omitted: 0,
      rate_limit_wait_ms: 5000,
    });
  });

  it('records role-player retries in the same totals', async () => {
    const { completed, waits } = await run(
      [
        limited(),
        JSON.stringify({
          user_needs: [{ description: 'Finish the task', status: 'remaining' }],
          message: 'Please do the task.',
        }),
        JSON.stringify({ remaining_need_ids: [], message: '' }),
      ],
      createTestResolvedRunPlan({
        mode: 'multi_turn',
        prompt: 'Do the task.',
        rolePlayer: MODEL,
      }),
    );
    assert.deepEqual(waits, [2000]);
    assert.equal(
      completed.result.completion_calls[0]?.retry?.decision,
      'rate_limit_retry',
    );
    assert.equal(
      completed.result.completion_call_totals?.rate_limit_wait_ms,
      2000,
    );
  });

  it('commits a judge error instead of losing the run when a wait would pass the run timeout', async () => {
    const plan = createTestResolvedRunPlan({
      prompt: 'Do the task.',
      judgingCriteria: ['The task is done.'],
      judge: MODEL,
    });
    // The stand-in sleep only ends when the run signal aborts, as a real wait
    // that outlasts the run timeout would.
    const { completed } = await run(
      [limited(), limited(), verdict],
      { ...plan, limits: { run_timeout_ms: 100 } },
      (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const criterion = completed.result.evaluation.judging_criteria[0];
    assert.equal(criterion?.passed, null);
    assert.equal(criterion?.error?.type, 'request_error');
    assert.equal(completed.result.completion_calls.length, 1);
    assert.equal(
      completed.result.completion_calls[0]?.retry?.decision,
      'exhausted',
    );
  });
});
