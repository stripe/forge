import assert from 'node:assert/strict';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, it, vi } from 'vitest';
import {
  AvaRolePlayer,
  MAX_AVA_ATTEMPTS,
  MAX_AVA_MESSAGE_CHARACTERS,
  MAX_AVA_NEED_DESCRIPTION_CHARACTERS,
  MAX_AVA_NEEDS,
} from './ava.ts';
import type {
  InteractionCompletionInvoker,
  InteractionCompletionRequest,
} from './completion.ts';

type CompletionStep =
  | string
  | Error
  | ((request: InteractionCompletionRequest) => string);

function scriptedCompletion(...steps: CompletionStep[]): {
  readonly calls: InteractionCompletionRequest[];
  readonly invoke: InteractionCompletionInvoker;
} {
  const calls: InteractionCompletionRequest[] = [];
  let index = 0;
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      if (typeof step === 'function') return completionResponse(step(request));
      if (step === undefined)
        throw new Error('No scripted completion remains.');
      return completionResponse(step);
    },
  };
}

function completionResponse(content: string) {
  return {
    content,
    stopReason: 'end_turn' as const,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  };
}

function initialResponse(
  needs: Array<{
    description: string;
    status: 'remaining' | 'satisfied';
  }>,
  message: string,
): string {
  return JSON.stringify({ user_needs: needs, message });
}

function continuationResponse(
  remainingNeedIds: string[],
  message: string,
): string {
  return JSON.stringify({ remaining_need_ids: remainingNeedIds, message });
}

const TWO_NEEDS = [
  {
    description: 'Understand the desired checkout experience',
    status: 'remaining' as const,
  },
  {
    description: 'Confirm the implementation was verified',
    status: 'remaining' as const,
  },
];

const noRetryWait = {
  waitBeforeRetry: async (): Promise<void> => undefined,
};

describe('AvaRolePlayer', () => {
  it('initializes bounded private needs with a strict structured request', async () => {
    const completion = scriptedCompletion(
      initialResponse(
        TWO_NEEDS.map((need) => ({ ...need, status: 'satisfied' })),
        'What should the checkout feel like?',
      ),
    );
    const ava = new AvaRolePlayer(
      { task: 'Add Checkout', context: 'A developer upgrading an application' },
      completion.invoke,
    );

    assert.deepEqual(await ava.nextTurn(), {
      message: 'What should the checkout feel like?',
      stop: false,
      remainingNeeds: [
        { id: 'need_1', description: TWO_NEEDS[0]!.description },
        { id: 'need_2', description: TWO_NEEDS[1]!.description },
      ],
      needs: [
        { id: 'need_1', description: TWO_NEEDS[0]!.description },
        { id: 'need_2', description: TWO_NEEDS[1]!.description },
      ],
      focusNeedId: 'need_1',
      source: 'generated',
    });

    assert.equal(completion.calls.length, 1);
    const request = completion.calls[0]!;
    assert.equal(request.temperature, 0.3);
    assert.equal(request.maxTokens, 700);
    assert.match(request.systemPrompt, /Add Checkout/);
    assert.match(request.systemPrompt, /Embrace reasonable human uncertainty/);
    assert.match(request.systemPrompt, /Never mention a checklist/);
    assert.deepEqual(request.messages, [
      {
        role: 'user',
        content:
          'Start the conversation with one natural message about one high-level need.',
      },
    ]);
    assert.equal(request.responseSchema.name, 'ava_initial_turn');
    assert.equal(request.responseSchema.strict, true);
    const schema = request.responseSchema.schema as {
      properties: {
        user_needs: {
          maxItems: number;
          items: {
            properties: { description: { maxLength: number; pattern: string } };
          };
        };
        message: { maxLength: number };
      };
    };
    assert.equal(schema.properties.user_needs.maxItems, MAX_AVA_NEEDS);
    assert.equal(
      schema.properties.user_needs.items.properties.description.maxLength,
      MAX_AVA_NEED_DESCRIPTION_CHARACTERS,
    );
    assert.equal(
      schema.properties.user_needs.items.properties.description.pattern,
      '\\S',
    );
    assert.equal(
      schema.properties.message.maxLength,
      MAX_AVA_MESSAGE_CHARACTERS,
    );
  });

  it('uses a configured opening verbatim, then initializes from agent history', async () => {
    const completion = scriptedCompletion(
      initialResponse(
        [{ description: 'Finish the requested work', status: 'satisfied' }],
        'This closing prose is discarded.',
      ),
    );
    const ava = new AvaRolePlayer(
      { task: 'Do the work', initialPrompt: 'Please inspect the repository.' },
      completion.invoke,
    );

    assert.deepEqual(await ava.nextTurn(), {
      message: 'Please inspect the repository.',
      stop: false,
      remainingNeeds: null,
      needs: null,
      focusNeedId: null,
      source: 'configured_initial_prompt',
    });
    assert.equal(completion.calls.length, 0);

    const terminal = await ava.nextTurn('The repository is ready.');
    assert.equal(terminal.stop, true);
    assert.equal(terminal.message, '');
    assert.deepEqual(terminal.remainingNeeds, []);
    assert.deepEqual(completion.calls[0]!.messages, [
      { role: 'assistant', content: 'Please inspect the repository.' },
      { role: 'user', content: 'The repository is ready.' },
    ]);
  });

  it('keeps private state out of history, derives focus, strips recaps, and stops blank', async () => {
    const completion = scriptedCompletion(
      initialResponse(
        TWO_NEEDS,
        'That covers hosted Checkout well. What should happen next?',
      ),
      continuationResponse(['need_2'], 'How did you verify the result?'),
      continuationResponse([], 'Thanks, that is everything.'),
    );
    const ava = new AvaRolePlayer({ task: 'Add Checkout' }, completion.invoke);

    const opening = await ava.nextTurn();
    assert.equal(opening.message, 'What should happen next?');
    const followUp = await ava.nextTurn('I implemented hosted Checkout.');
    assert.equal(followUp.focusNeedId, 'need_2');
    assert.deepEqual(followUp.remainingNeeds, [
      { id: 'need_2', description: TWO_NEEDS[1]!.description },
    ]);
    assert.equal(completion.calls[1]!.maxTokens, 400);
    assert.equal(completion.calls[1]!.responseSchema.name, 'ava_turn');
    assert.deepEqual(completion.calls[1]!.messages, [
      { role: 'assistant', content: 'What should happen next?' },
      { role: 'user', content: 'I implemented hosted Checkout.' },
    ]);
    assert.doesNotMatch(
      JSON.stringify(completion.calls[1]!.messages),
      /user_needs|need_2/,
    );

    const terminal = await ava.nextTurn('I verified it.');
    assert.equal(terminal.stop, true);
    assert.equal(terminal.message, '');
    assert.deepEqual(terminal.remainingNeeds, []);
  });

  it('retries invalid output without duplicating or resurrecting satisfied needs', async () => {
    const completion = scriptedCompletion(
      '{not json',
      initialResponse(TWO_NEEDS, 'How should checkout work?'),
      continuationResponse(['need_99'], 'Invalid follow-up'),
      continuationResponse(['need_2'], 'How did you verify the result?'),
      continuationResponse(['need_1', 'need_2'], 'Invalid resurrected need'),
      continuationResponse(['need_2', 'need_2'], 'Invalid duplicate need'),
      continuationResponse(['need_2'], 'Could you verify the result?'),
    );
    const ava = new AvaRolePlayer(
      { task: 'Add Checkout' },
      completion.invoke,
      noRetryWait,
    );

    assert.equal((await ava.nextTurn()).focusNeedId, 'need_1');
    const followUp = await ava.nextTurn('Implemented checkout.');
    assert.equal(followUp.focusNeedId, 'need_2');
    assert.deepEqual(followUp.remainingNeeds, [
      { id: 'need_2', description: TWO_NEEDS[1]!.description },
    ]);
    const retried = await ava.nextTurn('I have not verified it yet.');
    assert.equal(retried.message, 'Could you verify the result?');
    assert.deepEqual(retried.remainingNeeds, followUp.remainingNeeds);
    assert.equal(completion.calls.length, 7);
    assert.deepEqual(
      completion.calls[2]!.messages,
      completion.calls[3]!.messages,
    );
    const retryRequest = completion.calls[4]!;
    assert.deepEqual(retryRequest.messages, [
      { role: 'assistant', content: 'How should checkout work?' },
      { role: 'user', content: 'Implemented checkout.' },
      { role: 'assistant', content: 'How did you verify the result?' },
      { role: 'user', content: 'I have not verified it yet.' },
    ]);
    const schema = retryRequest.responseSchema.schema as {
      properties: { remaining_need_ids: { items: { enum: string[] } } };
    };
    assert.deepEqual(schema.properties.remaining_need_ids.items.enum, [
      'need_2',
    ]);
    for (const request of completion.calls.slice(5)) {
      assert.deepEqual(request.messages, retryRequest.messages);
      assert.deepEqual(request.responseSchema, retryRequest.responseSchema);
    }
  });

  it('uses the fixed one- and five-second retry waits', async (testContext) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    testContext.onTestFinished(() => {
      vi.useRealTimers();
    });
    const completion = scriptedCompletion(
      new Error('temporary request failure'),
      '{invalid json',
      initialResponse(TWO_NEEDS, 'How should checkout work?'),
    );
    const pending = new AvaRolePlayer(
      { task: 'Add Checkout' },
      completion.invoke,
    ).nextTurn();
    await nextEventLoopTurn();

    vi.advanceTimersByTime(999);
    await nextEventLoopTurn();
    assert.equal(completion.calls.length, 1);
    vi.advanceTimersByTime(1);
    await nextEventLoopTurn();
    assert.equal(completion.calls.length, 2);
    vi.advanceTimersByTime(4_999);
    await nextEventLoopTurn();
    assert.equal(completion.calls.length, 2);
    vi.advanceTimersByTime(1);

    assert.equal((await pending).message, 'How should checkout work?');
    assert.equal(completion.calls.length, MAX_AVA_ATTEMPTS);
  });

  it('cancels the production retry wait without another completion attempt', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled during backoff', 'AbortError');
    const completion = scriptedCompletion(
      new Error('temporary request failure'),
    );
    const pending = new AvaRolePlayer(
      { task: 'Add Checkout', signal: controller.signal },
      completion.invoke,
    ).nextTurn();
    await nextEventLoopTurn();

    assert.equal(completion.calls.length, 1);
    assert.equal(completion.calls[0]!.signal, controller.signal);
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(completion.calls.length, 1);
  });

  describe('fails closed after bounded invalid structured outputs', () => {
    const invalidCases: Array<[string, string]> = [
      [
        'duplicate needs',
        initialResponse(
          [
            { description: 'Same need', status: 'remaining' },
            { description: 'same need', status: 'remaining' },
          ],
          'Question?',
        ),
      ],
      [
        'too many needs',
        initialResponse(
          Array.from({ length: MAX_AVA_NEEDS + 1 }, (_, index) => ({
            description: `Outcome ${index + 1}`,
            status: 'remaining' as const,
          })),
          'Question?',
        ),
      ],
      [
        'oversized need',
        initialResponse(
          [
            {
              description: 'x'.repeat(MAX_AVA_NEED_DESCRIPTION_CHARACTERS + 1),
              status: 'remaining',
            },
          ],
          'Question?',
        ),
      ],
      [
        'oversized message',
        initialResponse(TWO_NEEDS, 'x'.repeat(MAX_AVA_MESSAGE_CHARACTERS + 1)),
      ],
      ['list', initialResponse(TWO_NEEDS, '- First\n- Second')],
      ['code', initialResponse(TWO_NEEDS, '```ts\nconst x = 1;\n```')],
      [
        'private terminology',
        initialResponse(TWO_NEEDS, 'My remaining needs are unclear.'),
      ],
      [
        'non-focused need leakage',
        initialResponse(
          TWO_NEEDS,
          `Could you ${TWO_NEEDS[1]!.description.toLowerCase()}?`,
        ),
      ],
    ];

    const rejectionMessages: Record<string, string> = {
      'duplicate needs': 'Ava returned duplicate private user needs.',
      'too many needs':
        'Ava response did not match the required schema at response.user_needs (too_big).',
      'oversized need':
        'Ava response did not match the required schema at response.user_needs[0].description (too_big).',
      'oversized message':
        'Ava response did not match the required schema at response.message (too_big).',
      list: 'Ava returned a list instead of one human-like message.',
      code: 'Ava returned implementation code in its message.',
      'private terminology': 'Ava exposed private task-model terminology.',
      'non-focused need leakage': 'Ava exposed a non-focused private need.',
    };
    for (const [name, response] of invalidCases) {
      it(name, async () => {
        const completion = scriptedCompletion(response);
        const turn = await new AvaRolePlayer(
          { task: 'x' },
          completion.invoke,
          noRetryWait,
        ).nextTurn();
        assert.equal(turn.stop, true);
        assert.deepEqual(turn.error, {
          status: 'role_player_error',
          errorType: 'parse_error',
          attempts: MAX_AVA_ATTEMPTS,
          message: rejectionMessages[name],
          explanation: `Ava returned invalid structured output after ${MAX_AVA_ATTEMPTS} attempts.`,
        });
        assert.equal(completion.calls.length, MAX_AVA_ATTEMPTS);
      });
    }
  });

  it('retries request failures and retains a bounded, redacted final message', async () => {
    const recovered = scriptedCompletion(
      new Error('temporary provider failure'),
      initialResponse(TWO_NEEDS, 'Question?'),
    );
    const recoveredTurn = await new AvaRolePlayer(
      { task: 'x' },
      recovered.invoke,
      noRetryWait,
    ).nextTurn();
    assert.equal(recoveredTurn.message, 'Question?');
    assert.equal(recovered.calls.length, 2);

    const failed = scriptedCompletion(
      new Error(`provider unavailable: secret-key ${'x'.repeat(5000)}`),
    );
    const failedTurn = await new AvaRolePlayer({ task: 'x' }, failed.invoke, {
      ...noRetryWait,
      redactionSecrets: ['secret-key'],
    }).nextTurn();
    assert.deepEqual(
      { ...failedTurn.error, message: undefined },
      {
        status: 'role_player_error',
        errorType: 'request_error',
        attempts: MAX_AVA_ATTEMPTS,
        message: undefined,
        explanation: `Ava request failed after ${MAX_AVA_ATTEMPTS} attempts.`,
      },
    );
    assert.doesNotMatch(JSON.stringify(failedTurn), /secret-key/);
    assert.equal(failedTurn.error?.message?.length, 4096);
    assert.match(
      failedTurn.error!.message!,
      /^provider unavailable: \[REDACTED\] x+…$/,
    );
    assert.equal(failed.calls.length, MAX_AVA_ATTEMPTS);
  });

  it('keeps malformed JSON and schema diagnostics free of response values and unknown keys', async () => {
    for (const [response, message] of [
      ['{secret-response', 'Ava response was not valid JSON.'],
      [
        JSON.stringify({
          user_needs: [{ description: 'safe', status: 'secret-status' }],
          message: 'Hi',
        }),
        'Ava response did not match the required schema at response.user_needs[0].status (invalid_enum_value).',
      ],
      [
        JSON.stringify({
          user_needs: [{ description: 'safe', status: 'remaining' }],
          message: 'Hi',
          'secret-key': true,
        }),
        'Ava response did not match the required schema at response (unrecognized_keys).',
      ],
    ]) {
      const turn = await new AvaRolePlayer(
        { task: 'x' },
        scriptedCompletion(response!).invoke,
        noRetryWait,
      ).nextTurn();
      assert.equal(turn.error?.message, message);
      assert.doesNotMatch(JSON.stringify(turn.error), /secret-/);
    }
  });

  it('does not retry an aborted completion', async () => {
    const controller = new AbortController();
    let calls = 0;
    const completion: InteractionCompletionInvoker = async () => {
      calls += 1;
      controller.abort(new DOMException('cancelled', 'AbortError'));
      throw controller.signal.reason;
    };
    const ava = new AvaRolePlayer(
      { task: 'x', signal: controller.signal },
      completion,
      noRetryWait,
    );

    await assert.rejects(ava.nextTurn(), { name: 'AbortError' });
    assert.equal(calls, 1);
  });
});
