import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import type {
  CompletionProviderCallContext,
  CompletionRequest,
} from '../contracts/completion.js';
import { credentialReference } from '../contracts/credentials.js';
import { createScriptedCompletionProvider } from './completionProvider.js';

describe('createScriptedCompletionProvider', () => {
  it('uses the installed package version by default and preserves an explicit version', () => {
    const metadata = createRequire(import.meta.url)(
      '@stripe/forge/package.json',
    ) as {
      version: string;
    };

    assert.equal(
      createScriptedCompletionProvider().provider.version,
      metadata.version,
    );
    assert.equal(
      createScriptedCompletionProvider({ version: '9.8.7' }).provider.version,
      '9.8.7',
    );
  });

  it('returns queued text, full responses, and request-aware responses in order', async () => {
    const fixture = createScriptedCompletionProvider({
      responses: [
        'first',
        {
          content: 'second',
          stopReason: 'max_tokens',
          usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
          costUsd: 0.004,
        },
        (request, context) =>
          `${request.purpose}:${request.messages[0]?.content}:${context.credentials.token}`,
      ],
    });
    const context = completionContext({ token: 'test-secret' });

    assert.deepEqual(
      await fixture.provider.complete(completionRequest(), context),
      {
        content: 'first',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
    );
    assert.deepEqual(
      await fixture.provider.complete(
        completionRequest({ purpose: 'judge' }),
        context,
      ),
      {
        content: 'second',
        stopReason: 'max_tokens',
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
        costUsd: 0.004,
      },
    );
    {
      const actual = await fixture.provider.complete(
        completionRequest(),
        context,
      );
      assert.ok(actual);
      assert.equal(actual.content, 'role_player:hello:test-secret');
    }

    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.calls[0]?.request.systemPrompt, 'test system');
    assert.deepEqual(fixture.calls[0]?.context.credentials, {
      token: 'test-secret',
    });
    assert.deepEqual(fixture.events, [
      'complete:role_player',
      'complete:judge',
      'complete:role_player',
    ]);
    assert.equal(fixture.remainingResponses, 0);
  });

  it('records pure requirements and an optional preflight hook', async () => {
    let observedCredential = '';
    const fixture = createScriptedCompletionProvider({
      requirements: (input) => ({
        credentials: {
          token: {
            reference: credentialReference(`test.${input.purpose}`),
          },
        },
      }),
      preflight: (input) => {
        observedCredential = input.credentials.token ?? '';
      },
    });
    const signal = new AbortController().signal;
    const model = { provider: 'test-provider', model: 'test-model' };

    assert.deepEqual(
      fixture.provider.requirements({ model, purpose: 'judge' }),
      {
        credentials: { token: { reference: 'test.judge' } },
      },
    );
    await fixture.provider.preflight?.({
      runId: 'run-1',
      model,
      purpose: 'judge',
      credentials: { token: 'resolved-secret' },
      signal,
    });

    assert.deepEqual(fixture.requirementCalls, [{ model, purpose: 'judge' }]);
    {
      const actual = fixture.preflightCalls[0];
      assert.ok(actual);
      assert.deepEqual(
        {
          runId: actual.runId,
          model: actual.model,
          purpose: actual.purpose,
          credentials: { token: actual.credentials.token },
        },
        {
          runId: 'run-1',
          model,
          purpose: 'judge',
          credentials: { token: 'resolved-secret' },
        },
      );
    }
    assert.equal(observedCredential, 'resolved-secret');
    assert.deepEqual(fixture.events, ['requirements:judge', 'preflight:judge']);
  });

  it('propagates scripted failures, fails on exhaustion, and preserves an aborted step', async () => {
    const failure = new Error('provider unavailable');
    const fixture = createScriptedCompletionProvider({ responses: [failure] });

    await assert.rejects(
      fixture.provider.complete(completionRequest(), completionContext()),
      /provider unavailable/,
    );
    await assert.rejects(
      fixture.provider.complete(completionRequest(), completionContext()),
      /no remaining response/,
    );
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.remainingResponses, 0);

    const aborted = createScriptedCompletionProvider({ responses: ['unused'] });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      aborted.provider.complete(
        completionRequest({ signal: controller.signal }),
        completionContext(),
      ),
    );
    assert.equal(aborted.calls.length, 0);
    assert.equal(aborted.remainingResponses, 1);
  });

  it('rechecks cancellation after an asynchronous scripted handler settles', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createScriptedCompletionProvider({
      responses: [
        async () => {
          markStarted();
          await barrier;
          return 'late response';
        },
      ],
    });
    const controller = new AbortController();
    const pending = fixture.provider.complete(
      completionRequest({ signal: controller.signal }),
      completionContext(),
    );
    await started;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    release();

    await assert.rejects(pending);
  });

  it('records isolated request and credential snapshots and returns copied response usage', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
    };
    const messages = [{ role: 'user' as const, content: 'original' }];
    const model = { provider: 'test-provider', model: 'original-model' };
    const credentials = { token: 'synthetic-value' };
    const response = {
      content: 'answer',
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
    };
    const fixture = createScriptedCompletionProvider({ responses: [response] });
    const request = completionRequest({
      model,
      messages,
      responseSchema: { name: 'answer', strict: true, schema },
    });
    const completed = await fixture.provider.complete(request, { credentials });
    messages[0]!.content = 'changed';
    model.model = 'changed';
    credentials.token = 'changed';
    schema.properties.answer.type = 'number';
    response.usage.inputTokens = 999;

    const recorded = fixture.calls[0]!;
    assert.deepEqual(recorded.request.messages, [
      { role: 'user', content: 'original' },
    ]);
    assert.equal(recorded.request.model.model, 'original-model');
    assert.deepEqual(recorded.request.responseSchema?.schema, {
      type: 'object',
      properties: { answer: { type: 'string' } },
    });
    assert.equal(recorded.request.signal, request.signal);
    assert.deepEqual(recorded.context.credentials, {
      token: 'synthetic-value',
    });
    assert.equal(completed.usage.inputTokens, 3);
    assert.equal(Object.isFrozen(recorded.request.messages[0]), true);
    assert.equal(Object.isFrozen(completed.usage), true);
  });
});

function completionRequest(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    runId: 'run-1',
    purpose: 'role_player',
    model: { provider: 'test-provider', model: 'test-model' },
    systemPrompt: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function completionContext(
  credentials: Readonly<Record<string, string>> = {},
): CompletionProviderCallContext {
  return { credentials };
}
