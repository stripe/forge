import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {CompletionResponse} from '../contracts/completion.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.js';
import {
  completionBindingsForPlan,
  prepareCompletionRuntime,
} from './completionRuntime.js';

const MODEL = {provider: 'test-provider', model: 'judge-model'} as const;

describe('completion runtime', () => {
  it('records concurrent calls in invocation order rather than settlement order', async () => {
    let resolveFirst!: (response: CompletionResponse) => void;
    let resolveSecond!: (response: CompletionResponse) => void;
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        () => new Promise((resolve) => { resolveFirst = resolve; }),
        () => new Promise((resolve) => { resolveSecond = resolve; }),
      ],
    });
    const prepared = await prepareCompletionRuntime({
      runId: 'completion-order-1',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          successGuidelines: ['One guideline'],
          judge: MODEL,
        }),
        composition(provider.provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      signal: new AbortController().signal,
    });

    const first = prepared.invoke('judge', prompt('first'), new AbortController().signal);
    const second = prepared.invoke('judge', prompt('second'), new AbortController().signal);
    resolveSecond(response(2));
    await second;
    resolveFirst(response(1));
    await first;

    assert.deepEqual(
      prepared.calls.map(({sequence, cost_usd}) => ({sequence, cost_usd})),
      [
        {sequence: 1, cost_usd: 1},
        {sequence: 2, cost_usd: 2},
      ],
    );
  });

  it('rejects a provider stop reason outside the public contract', async () => {
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        {
          ...response(1),
          stopReason: 'provider-internal-value',
        } as unknown as CompletionResponse,
      ],
    });
    const prepared = await prepareCompletionRuntime({
      runId: 'completion-validation-1',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          successGuidelines: ['One guideline'],
          judge: MODEL,
        }),
        composition(provider.provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      signal: new AbortController().signal,
    });

    await assert.rejects(
      prepared.invoke('judge', prompt('invalid'), new AbortController().signal),
      /Completion provider call failed/,
    );
    assert.deepEqual(prepared.calls.map(({status, error_code}) => ({status, error_code})), [
      {status: 'failed', error_code: 'completion_failed'},
    ]);
  });

  it('does not expose provider error details outside the completion boundary', async () => {
    const secret = 'provider-error-secret';
    const providerError = Object.assign(
      new Error(`upstream response contained ${secret}`),
      {code: secret},
    );
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [providerError],
    });
    const prepared = await prepareCompletionRuntime({
      runId: 'completion-error-redaction-1',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          successGuidelines: ['One guideline'],
          judge: MODEL,
        }),
        composition(provider.provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      redactionSecrets: [secret],
      signal: new AbortController().signal,
    });

    let captured: unknown;
    try {
      await prepared.invoke(
        'judge',
        prompt('failure'),
        new AbortController().signal,
      );
    } catch (error) {
      captured = error;
    }

    assert.ok(captured instanceof Error);
    assert.doesNotMatch(captured.message, new RegExp(secret));
    assert.equal(
      (captured as Error & {code?: string}).code,
      'completion_failed',
    );
    assert.equal('cause' in captured, false);
    assert.deepEqual(prepared.calls, [
      {
        sequence: 1,
        purpose: 'judge',
        provider: 'test-provider',
        provider_version: '1',
        model: 'judge-model',
        status: 'failed',
        stop_reason: null,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
        cost_usd: null,
        error_code: 'completion_failed',
      },
    ]);
  });
});

function composition(provider: ReturnType<typeof createScriptedCompletionProvider>['provider']) {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter();
  return {
    runtime: runtime.adapter,
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    setupExtensions: new Map(),
    completionProviders: new Map([[provider.id, provider]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createMemoryArtifactStore().store,
  };
}

function prompt(content: string) {
  return {
    messages: [{role: 'user' as const, content}],
  };
}

function response(costUsd: number): CompletionResponse {
  return {
    content: '{}',
    stopReason: 'end_turn',
    usage: {inputTokens: 1, outputTokens: 1, cachedInputTokens: 0},
    costUsd,
  };
}
