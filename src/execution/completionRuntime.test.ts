import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type {
  CompletionProvider,
  CompletionResponse,
} from '../contracts/completion.ts';
import { credentialReference } from '../contracts/credentials.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.ts';
import { FORGE_VERSION } from '../version.ts';
import {
  completionBindingsForPlan,
  prepareCompletionRuntime,
} from './completionRuntime.ts';

const MODEL = { provider: 'test-provider', model: 'judge-model' } as const;

describe('completion runtime', () => {
  it('snapshots independently versioned provider identity and configuration during preflight', async () => {
    const metadata = { endpoint_mode: 'custom' as 'default' | 'custom' };
    const scripted = createScriptedCompletionProvider({
      id: MODEL.provider,
      version: '3.4.1',
      responses: [response(1)],
    });
    const provider = { ...scripted.provider, metadata };
    const bindings = completionBindingsForPlan(
      createTestResolvedRunPlan({
        judgingCriteria: ['One criterion'],
        judge: MODEL,
      }),
      composition(provider),
    );
    metadata.endpoint_mode = 'default';
    provider.version = '3.4.2';
    const signal = new AbortController().signal;
    const prepared = await prepareCompletionRuntime({
      runId: 'provider-metadata-snapshot',
      bindings,
      credentialResolver: createStaticCredentialResolver(),
      signal,
    });
    await prepared.invoke('judge', prompt('judge it'), signal);
    assert.equal(prepared.calls[0]!.provider_version, '3.4.1');
    assert.deepEqual(prepared.calls[0]!.provider_metadata, {
      endpoint_mode: 'custom',
    });
    assert.equal(Object.isFrozen(prepared.calls[0]!.provider_metadata), true);
  });

  it('rejects malformed provider metadata before resolving credentials', () => {
    const scripted = createScriptedCompletionProvider({ id: MODEL.provider });
    for (const metadata of [
      null,
      { endpoint_mode: 'unknown' },
      { endpoint_mode: 'custom', endpoint: 'https://private.example.com' },
    ]) {
      const provider = { ...scripted.provider, metadata } as CompletionProvider;
      assert.throws(() =>
        completionBindingsForPlan(
          createTestResolvedRunPlan({
            judgingCriteria: ['One criterion'],
            judge: MODEL,
          }),
          composition(provider),
        ),
      );
      assert.deepEqual(scripted.calls, []);
    }
  });

  it('resolves shared credential references independently by purpose and redacts every resolved value', async () => {
    const secretsByPurpose = {
      role_player: 'role-player-authorized-secret',
      judge: 'judge-authorized-secret',
    };
    const agentSecret = 'independent-agent-secret';
    const secretText = `${agentSecret} ${secretsByPurpose.role_player} ${secretsByPurpose.judge}`;
    const requirements: string[] = [];
    const resolutions: string[] = [];
    const preflights: string[] = [];
    const dispatched: string[] = [];
    const provider: CompletionProvider = {
      id: 'test-provider',
      version: '1',
      requirements({ purpose }) {
        requirements.push(purpose);
        return {
          credentials: {
            token: { reference: credentialReference('shared.token') },
          },
        };
      },
      async preflight({ purpose, credentials }) {
        assert.ok(Object.isFrozen(credentials));
        assert.deepEqual(credentials, { token: secretsByPurpose[purpose] });
        preflights.push(purpose);
      },
      async complete(request, { credentials }) {
        assert.ok(Object.isFrozen(credentials));
        assert.deepEqual(credentials, {
          token: secretsByPurpose[request.purpose],
        });
        assert.equal(request.systemPrompt, '[REDACTED] [REDACTED] [REDACTED]');
        assert.deepEqual(request.messages, [
          { role: 'user', content: '[REDACTED] [REDACTED] [REDACTED]' },
        ]);
        dispatched.push(request.purpose);
        return { ...response(1), content: secretText };
      },
    };
    const bindings = completionBindingsForPlan(
      createTestResolvedRunPlan({
        mode: 'multi_turn',
        rolePlayer: MODEL,
        judgingCriteria: ['One criterion'],
        judge: MODEL,
      }),
      composition(provider),
    );
    assert.deepEqual(requirements, ['role_player', 'judge']);
    assert.equal(resolutions.length, 0);
    assert.equal(preflights.length, 0);
    const signal = new AbortController().signal;
    const prepared = await prepareCompletionRuntime({
      runId: 'purpose-credentials-1',
      bindings,
      credentialResolver: {
        async resolve(reference, { runId, purpose }) {
          assert.equal(reference, 'shared.token');
          assert.equal(runId, 'purpose-credentials-1');
          resolutions.push(purpose);
          return purpose === 'forge-eval:completion:role_player:token'
            ? secretsByPurpose.role_player
            : secretsByPurpose.judge;
        },
      },
      redactionSecrets: [agentSecret],
      signal,
    });
    assert.deepEqual(resolutions, [
      'forge-eval:completion:role_player:token',
      'forge-eval:completion:judge:token',
    ]);
    assert.deepEqual(preflights, ['role_player', 'judge']);
    assert.deepEqual(prepared.secrets, [
      agentSecret,
      secretsByPurpose.role_player,
      secretsByPurpose.judge,
    ]);

    const originalPrompt = { systemPrompt: secretText, ...prompt(secretText) };
    for (const purpose of ['role_player', 'judge'] as const) {
      assert.equal(prepared.has(purpose), true);
      assert.equal(prepared.provider(purpose), provider);
      assert.deepEqual(prepared.model(purpose), MODEL);
      const completed = await prepared.invoke(purpose, originalPrompt, signal);
      assert.equal(completed.content, '[REDACTED] [REDACTED] [REDACTED]');
    }
    assert.deepEqual(dispatched, ['role_player', 'judge']);
    assert.equal(originalPrompt.systemPrompt, secretText);
    assert.equal(originalPrompt.messages[0]?.content, secretText);
    assert.deepEqual(
      prepared.calls.map(({ purpose, status }) => ({ purpose, status })),
      [
        { purpose: 'role_player', status: 'succeeded' },
        { purpose: 'judge', status: 'succeeded' },
      ],
    );
    for (const secret of prepared.secrets) {
      assert.equal(JSON.stringify(prepared.calls).includes(secret), false);
    }
  });

  it('rejects a provider response arriving after cancellation without recording successful usage', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled the completion');
    let deliverResponse!: (response: CompletionResponse) => void;
    let invocations = 0;
    const scripted = createScriptedCompletionProvider({ id: 'test-provider' });
    const provider: CompletionProvider = {
      ...scripted.provider,
      // The engine must enforce cancellation even when a provider does not.
      async complete() {
        invocations += 1;
        return new Promise((resolve) => {
          deliverResponse = resolve;
        });
      },
    };
    const prepared = await prepareCompletionRuntime({
      runId: 'cancelled-completion-1',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          judgingCriteria: ['One criterion'],
          judge: MODEL,
        }),
        composition(provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      signal: controller.signal,
    });

    const pending = prepared.invoke(
      'judge',
      prompt('pending'),
      controller.signal,
    );
    controller.abort(reason);
    deliverResponse(response(1));
    await assert.rejects(pending, (error: unknown) => error === reason);
    await assert.rejects(
      prepared.invoke('judge', prompt('already cancelled'), controller.signal),
      (error: unknown) => error === reason,
    );
    assert.equal(invocations, 1);
    assert.deepEqual(prepared.calls, [
      {
        sequence: 1,
        purpose: 'judge',
        provider: 'test-provider',
        provider_version: FORGE_VERSION,
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

  it('records concurrent calls in invocation order rather than settlement order', async () => {
    let resolveFirst!: (response: CompletionResponse) => void;
    let resolveSecond!: (response: CompletionResponse) => void;
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      ],
    });
    const prepared = await prepareCompletionRuntime({
      runId: 'completion-order-1',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          judgingCriteria: ['One criterion'],
          judge: MODEL,
        }),
        composition(provider.provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      signal: new AbortController().signal,
    });

    const first = prepared.invoke(
      'judge',
      prompt('first'),
      new AbortController().signal,
    );
    const second = prepared.invoke(
      'judge',
      prompt('second'),
      new AbortController().signal,
    );
    resolveSecond(response(2));
    await second;
    resolveFirst(response(1));
    await first;

    assert.deepEqual(
      prepared.calls.map(({ sequence, cost_usd }) => ({ sequence, cost_usd })),
      [
        { sequence: 1, cost_usd: 1 },
        { sequence: 2, cost_usd: 2 },
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
          judgingCriteria: ['One criterion'],
          judge: MODEL,
        }),
        composition(provider.provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      signal: new AbortController().signal,
    });

    await assert.rejects(
      prepared.invoke('judge', prompt('invalid'), new AbortController().signal),
      /Completion provider returned an invalid response/,
    );
    assert.deepEqual(
      prepared.calls.map(({ status, error_code }) => ({ status, error_code })),
      [{ status: 'failed', error_code: 'completion_failed' }],
    );
  });

  it('exposes only credential-redacted judge error messages outside the completion boundary', async () => {
    const secret = 'provider-error-secret';
    const providerError = Object.assign(
      new Error(`upstream response contained ${secret}`),
      { code: secret },
    );
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [providerError],
    });
    const prepared = await prepareCompletionRuntime({
      runId: 'completion-error-redaction-1',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          judgingCriteria: ['One criterion'],
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
    assert.equal(captured.message, 'upstream response contained [REDACTED]');
    assert.doesNotMatch(captured.message, new RegExp(secret));
    assert.equal(
      (captured as Error & { code?: string }).code,
      'completion_failed',
    );
    assert.equal('cause' in captured, false);
    assert.deepEqual(prepared.calls, [
      {
        sequence: 1,
        purpose: 'judge',
        provider: 'test-provider',
        provider_version: FORGE_VERSION,
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

  it('keeps role-player request errors generic', async () => {
    const provider = createScriptedCompletionProvider({
      id: MODEL.provider,
      responses: [new Error('private provider detail')],
    });
    const signal = new AbortController().signal;
    const prepared = await prepareCompletionRuntime({
      runId: 'role-player-error-message',
      bindings: completionBindingsForPlan(
        createTestResolvedRunPlan({
          mode: 'multi_turn',
          rolePlayer: MODEL,
        }),
        composition(provider.provider),
      ),
      credentialResolver: createStaticCredentialResolver(),
      signal,
    });
    await assert.rejects(
      prepared.invoke('role_player', prompt('failure'), signal),
      { message: 'Completion provider call failed.' },
    );
  });
});

function composition(provider: CompletionProvider) {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter();
  return {
    runtime: runtime.adapter,
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    completionProviders: new Map([[provider.id, provider]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createMemoryArtifactStore().store,
  };
}

function prompt(content: string) {
  return {
    messages: [{ role: 'user' as const, content }],
  };
}

function response(costUsd: number): CompletionResponse {
  return {
    content: '{}',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    costUsd,
  };
}
