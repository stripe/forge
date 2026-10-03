import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import type {
  CompletionProviderCallContext,
  CompletionRequest,
} from '../contracts/completion.js';
import {credentialReference} from '../contracts/credentials.js';
import {createScriptedCompletionProvider} from './completionProvider.js';

describe('createScriptedCompletionProvider', () => {
  it('returns queued text, full responses, and request-aware responses in order', async () => {
    const fixture = createScriptedCompletionProvider({
      responses: [
        'first',
        {
          content: 'second',
          stopReason: 'max_tokens',
          usage: {inputTokens: 3, outputTokens: 2, cachedInputTokens: 1},
          costUsd: 0.004,
        },
        (request, context) =>
          `${request.purpose}:${request.messages[0]?.content}:${context.credentials.token}`,
      ],
    });
    const context = completionContext({token: 'test-secret'});

    await expect(
      fixture.provider.complete(completionRequest(), context),
    ).resolves.toEqual({
      content: 'first',
      stopReason: 'end_turn',
      usage: {inputTokens: 0, outputTokens: 0, cachedInputTokens: 0},
    });
    await expect(
      fixture.provider.complete(completionRequest({purpose: 'judge'}), context),
    ).resolves.toEqual({
      content: 'second',
      stopReason: 'max_tokens',
      usage: {inputTokens: 3, outputTokens: 2, cachedInputTokens: 1},
      costUsd: 0.004,
    });
    await expect(
      fixture.provider.complete(completionRequest(), context),
    ).resolves.toMatchObject({content: 'role_player:hello:test-secret'});

    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls[0]?.request.systemPrompt).toBe('test system');
    expect(fixture.calls[0]?.context.credentials).toEqual({token: 'test-secret'});
    expect(fixture.events).toEqual([
      'complete:role_player',
      'complete:judge',
      'complete:role_player',
    ]);
    expect(fixture.remainingResponses).toBe(0);
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
    const model = {provider: 'test-provider', model: 'test-model'};

    expect(fixture.provider.requirements({model, purpose: 'judge'})).toEqual({
      credentials: {token: {reference: 'test.judge'}},
    });
    await fixture.provider.preflight?.({
      runId: 'run-1',
      model,
      purpose: 'judge',
      credentials: {token: 'resolved-secret'},
      signal,
    });

    expect(fixture.requirementCalls).toEqual([{model, purpose: 'judge'}]);
    expect(fixture.preflightCalls[0]).toMatchObject({
      runId: 'run-1',
      model,
      purpose: 'judge',
      credentials: {token: 'resolved-secret'},
    });
    expect(observedCredential).toBe('resolved-secret');
    expect(fixture.events).toEqual(['requirements:judge', 'preflight:judge']);
  });

  it('propagates scripted failures, fails on exhaustion, and preserves an aborted step', async () => {
    const failure = new Error('provider unavailable');
    const fixture = createScriptedCompletionProvider({responses: [failure]});

    await expect(
      fixture.provider.complete(completionRequest(), completionContext()),
    ).rejects.toThrow('provider unavailable');
    await expect(
      fixture.provider.complete(completionRequest(), completionContext()),
    ).rejects.toThrow(/no remaining response/);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.remainingResponses).toBe(0);

    const aborted = createScriptedCompletionProvider({responses: ['unused']});
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.provider.complete(
        completionRequest({signal: controller.signal}),
        completionContext(),
      ),
    ).rejects.toThrow();
    expect(aborted.calls).toHaveLength(0);
    expect(aborted.remainingResponses).toBe(1);
  });

  it('rechecks cancellation after an asynchronous scripted handler settles', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fixture = createScriptedCompletionProvider({
      responses: [async () => {
        markStarted();
        await barrier;
        return 'late response';
      }],
    });
    const controller = new AbortController();
    const pending = fixture.provider.complete(
      completionRequest({signal: controller.signal}),
      completionContext(),
    );
    await started;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    release();

    await expect(pending).rejects.toThrow();
  });

  it('records isolated request and credential snapshots and returns copied response usage', async () => {
    const schema = {type: 'object', properties: {answer: {type: 'string'}}};
    const messages = [{role: 'user' as const, content: 'original'}];
    const model = {provider: 'test-provider', model: 'original-model'};
    const credentials = {token: 'synthetic-value'};
    const response = {
      content: 'answer', stopReason: 'end_turn' as const,
      usage: {inputTokens: 3, outputTokens: 2, cachedInputTokens: 1},
    };
    const fixture = createScriptedCompletionProvider({responses: [response]});
    const request = completionRequest({
      model, messages, responseSchema: {name: 'answer', strict: true, schema},
    });
    const completed = await fixture.provider.complete(request, {credentials});
    messages[0]!.content = 'changed';
    model.model = 'changed';
    credentials.token = 'changed';
    schema.properties.answer.type = 'number';
    response.usage.inputTokens = 999;

    const recorded = fixture.calls[0]!;
    expect(recorded.request.messages).toEqual([{role: 'user', content: 'original'}]);
    expect(recorded.request.model.model).toBe('original-model');
    expect(recorded.request.responseSchema?.schema).toEqual({
      type: 'object', properties: {answer: {type: 'string'}},
    });
    expect(recorded.request.signal).toBe(request.signal);
    expect(recorded.context.credentials).toEqual({token: 'synthetic-value'});
    expect(completed.usage.inputTokens).toBe(3);
    expect(Object.isFrozen(recorded.request.messages[0])).toBe(true);
    expect(Object.isFrozen(completed.usage)).toBe(true);
  });
});

function completionRequest(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    runId: 'run-1',
    purpose: 'role_player',
    model: {provider: 'test-provider', model: 'test-model'},
    systemPrompt: 'test system',
    messages: [{role: 'user', content: 'hello'}],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function completionContext(
  credentials: Readonly<Record<string, string>> = {},
): CompletionProviderCallContext {
  return {credentials};
}
