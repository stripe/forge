import assert from 'node:assert/strict';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, it, vi } from 'vitest';
import { CompletionInvocationError } from '../contracts/completion.ts';
import {
  AvaRolePlayer,
  MAX_AVA_ATTEMPTS,
  MAX_AVA_MESSAGE_CHARACTERS,
  MAX_AVA_NEED_ACCEPTANCE_CHARACTERS,
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
      assert.equal(Object.hasOwn(request, 'temperature'), false);
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
    acceptance?: string;
  }>,
  message: string,
): string {
  return JSON.stringify({
    user_needs: needs.map((need) => ({
      acceptance: 'The requested outcome is complete.',
      ...need,
    })),
    message,
  });
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
    acceptance: 'The checkout flow is explained at a design level.',
  },
  {
    description: 'Confirm the implementation was verified',
    acceptance: 'The assistant reports a verification result.',
  },
];

const noRetryWait = {
  waitBeforeRetry: async (): Promise<void> => undefined,
};

describe('AvaRolePlayer', () => {
  it('initializes bounded private needs with a strict structured request', async () => {
    const completion = scriptedCompletion(
      initialResponse(TWO_NEEDS, 'What should the checkout feel like?'),
    );
    const ava = new AvaRolePlayer(
      { task: 'Add Checkout', context: 'A developer upgrading an application' },
      completion.invoke,
    );

    assert.deepEqual(await ava.nextTurn(), {
      message: 'What should the checkout feel like?',
      stop: false,
      remainingNeeds: [
        {
          id: 'need_1',
          description: TWO_NEEDS[0]!.description,
          acceptance: TWO_NEEDS[0]!.acceptance,
        },
        {
          id: 'need_2',
          description: TWO_NEEDS[1]!.description,
          acceptance: TWO_NEEDS[1]!.acceptance,
        },
      ],
      needs: [
        {
          id: 'need_1',
          description: TWO_NEEDS[0]!.description,
          acceptance: TWO_NEEDS[0]!.acceptance,
        },
        {
          id: 'need_2',
          description: TWO_NEEDS[1]!.description,
          acceptance: TWO_NEEDS[1]!.acceptance,
        },
      ],
      focusNeedId: 'need_1',
      source: 'generated',
    });

    assert.equal(completion.calls.length, 1);
    const request = completion.calls[0]!;
    assert.equal(Object.hasOwn(request, 'temperature'), false);
    assert.equal(request.maxTokens, 1400);
    assert.match(request.systemPrompt, /Add Checkout/);
    assert.match(request.systemPrompt, /Embrace reasonable human uncertainty/);
    assert.match(
      request.systemPrompt,
      /Never reveal, quote, copy, or summarize your private state/,
    );
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
            properties: {
              description: { maxLength: number; pattern: string };
              acceptance: { maxLength: number; pattern: string };
            };
            required: string[];
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
      schema.properties.user_needs.items.properties.acceptance.maxLength,
      MAX_AVA_NEED_ACCEPTANCE_CHARACTERS,
    );
    assert.deepEqual(schema.properties.user_needs.items.required, [
      'description',
      'acceptance',
    ]);
    assert.match(
      request.systemPrompt,
      new RegExp(
        `description to at most ${MAX_AVA_NEED_DESCRIPTION_CHARACTERS} characters`,
      ),
    );
    assert.doesNotMatch(
      request.systemPrompt,
      /Mark a need satisfied|select no need|runner will discard/,
    );
    assert.equal(
      schema.properties.message.maxLength,
      MAX_AVA_MESSAGE_CHARACTERS,
    );
  });

  it('initializes before a configured opening and continues after the first answer', async () => {
    const need = {
      id: 'need_1',
      description: 'Finish the requested work',
      acceptance: 'The requested work is complete.',
    };
    const completion = scriptedCompletion(
      JSON.stringify({
        user_needs: [
          {
            description: need.description,
            acceptance: need.acceptance,
          },
        ],
      }),
      continuationResponse([], 'This closing prose is discarded.'),
    );
    const ava = new AvaRolePlayer(
      {
        task: 'Do the work',
        context: 'Keep the existing interface.',
        initialPrompt: 'Please inspect the repository.',
      },
      completion.invoke,
    );

    assert.deepEqual(await ava.nextTurn(), {
      message: 'Please inspect the repository.',
      stop: false,
      remainingNeeds: [need],
      needs: [need],
      focusNeedId: null,
      source: 'configured_initial_prompt',
    });
    assert.equal(completion.calls.length, 1);
    assert.match(completion.calls[0]!.systemPrompt, /Do the work/);
    assert.match(
      completion.calls[0]!.systemPrompt,
      /Keep the existing interface/,
    );
    assert.ok(
      !JSON.stringify(completion.calls[0]).includes(
        'Please inspect the repository.',
      ),
    );
    assert.equal(completion.calls[0]!.responseSchema.name, 'ava_initial_needs');
    assert.equal(completion.calls[0]!.maxTokens, 1400);
    assert.deepEqual(completion.calls[0]!.responseSchema.schema.required, [
      'user_needs',
    ]);
    assert.ok(
      completion.calls[0]!.messages.every(({ role }) => role === 'user'),
    );
    assert.match(
      completion.calls[0]!.systemPrompt,
      /Return only the private needs/,
    );

    const terminal = await ava.nextTurn('The repository is ready.');
    assert.equal(terminal.stop, true);
    assert.equal(terminal.message, '');
    assert.deepEqual(terminal.remainingNeeds, []);
    assert.equal(completion.calls[1]!.responseSchema.name, 'ava_turn');
    assert.deepEqual(completion.calls[1]!.messages, [
      { role: 'assistant', content: 'Please inspect the repository.' },
      { role: 'user', content: 'The repository is ready.' },
    ]);
  });

  for (const initialPrompt of [undefined, 'Please finish the work.']) {
    const mode = initialPrompt === undefined ? 'generated' : 'configured';
    it(`keeps acceptance frozen through a ${mode} conversation`, async () => {
      const need = {
        description: 'Complete the requested work',
        acceptance: 'The requested output is present.',
      };
      const completion = scriptedCompletion(
        JSON.stringify({
          user_needs: [need],
          ...(initialPrompt === undefined
            ? { message: 'Please finish the work.' }
            : {}),
        }),
        JSON.stringify({
          remaining_need_ids: ['need_1'],
          message: 'Please add the output.',
          acceptance: 'Also publish the output.',
        }),
        continuationResponse(['need_1'], 'Please add the output.'),
        continuationResponse([], ''),
      );
      const ava = new AvaRolePlayer(
        {
          task: 'Finish the work',
          ...(initialPrompt === undefined ? {} : { initialPrompt }),
        },
        completion.invoke,
        noRetryWait,
      );
      const opening = await ava.nextTurn();
      assert.throws(() => {
        (opening.needs![0] as { acceptance: string }).acceptance =
          'Also publish the output.';
      }, TypeError);
      const followUp = await ava.nextTurn('The output is not present yet.');
      const terminal = await ava.nextTurn('The output is present.');
      assert.equal(terminal.stop, true);
      assert.deepEqual(followUp.needs, opening.needs);
      assert.deepEqual(terminal.needs, opening.needs);
      assert.deepEqual(followUp.remainingNeeds, opening.needs);
      assert.equal(completion.calls.length, 4);
      for (const request of completion.calls.slice(1)) {
        assert.ok(
          request.systemPrompt.includes(`Acceptance: ${need.acceptance}`),
        );
        assert.match(request.systemPrompt, /Do not add conditions/);
        assert.doesNotMatch(request.systemPrompt, /Also publish the output/);
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /acceptance|requested output is present/,
        );
      }
    });

    it(`requires bounded acceptance in ${mode} initialization`, async () => {
      for (const acceptance of [
        undefined,
        '',
        '  ',
        'x'.repeat(MAX_AVA_NEED_ACCEPTANCE_CHARACTERS + 1),
        'x'.repeat(MAX_AVA_NEED_ACCEPTANCE_CHARACTERS),
      ]) {
        const completion = scriptedCompletion(
          JSON.stringify({
            user_needs: [
              {
                description: 'Complete the work',
                ...(acceptance === undefined ? {} : { acceptance }),
              },
            ],
            ...(initialPrompt === undefined
              ? { message: 'Please finish the work.' }
              : {}),
          }),
        );
        const turn = await new AvaRolePlayer(
          {
            task: 'Finish the work',
            ...(initialPrompt === undefined ? {} : { initialPrompt }),
          },
          completion.invoke,
          noRetryWait,
        ).nextTurn();
        if (acceptance?.length === MAX_AVA_NEED_ACCEPTANCE_CHARACTERS) {
          assert.equal(turn.error, undefined);
          assert.equal(turn.needs?.[0]?.acceptance, acceptance);
        } else {
          assert.equal(turn.error?.errorType, 'parse_error');
          assert.match(
            turn.error!.message!,
            /response.user_needs\[0\].acceptance/,
          );
          assert.equal(turn.needs, null);
        }
      }
    });
  }

  for (const phase of [
    'initial',
    'focused',
    'non-focused',
    'resolved',
  ] as const) {
    for (const field of ['id', 'description', 'acceptance'] as const) {
      const rejectsDisclosure =
        field === 'id' || phase === 'non-focused' || phase === 'resolved';
      it(`${rejectsDisclosure ? 'rejects' : 'accepts'} ${phase} private ${field} text under the narrow guard`, async () => {
        const needs = [
          {
            id: 'need_1',
            description: 'Review the shared access flow',
            acceptance: 'The access outcome is explained.',
          },
          {
            id: 'need_2',
            description: 'Review the account recovery flow',
            acceptance: 'The recovery outcome is explained.',
          },
        ];
        const leakedNeed = phase === 'non-focused' ? needs[1]! : needs[0]!;
        const message = `Could you explain ${leakedNeed[field].toUpperCase()}?`;
        const safeOpening = initialResponse(
          needs.map(({ description, acceptance }) => ({
            description,
            acceptance,
          })),
          phase === 'initial' ? message : 'How should we proceed?',
        );
        const remaining =
          phase === 'resolved' ? ['need_2'] : ['need_1', 'need_2'];
        const steps: CompletionStep[] = [safeOpening];
        if (phase === 'resolved') {
          steps.push(
            continuationResponse(remaining, 'What should happen next?'),
          );
        }
        if (phase !== 'initial') {
          steps.push(continuationResponse(remaining, message));
        }
        const completion = scriptedCompletion(...steps);
        const ava = new AvaRolePlayer(
          { task: 'Explain the access flow.' },
          completion.invoke,
          noRetryWait,
        );
        if (phase !== 'initial') await ava.nextTurn();
        if (phase === 'resolved')
          await ava.nextTurn('The first outcome is covered.');
        const turn = await ava.nextTurn(
          phase === 'initial' ? undefined : 'Please continue.',
        );

        const priorCalls =
          phase === 'initial' ? 0 : phase === 'resolved' ? 2 : 1;
        if (rejectsDisclosure) {
          assert.equal(turn.message, '');
          assert.equal(turn.stop, true);
          assert.equal(turn.error?.errorType, 'parse_error');
          assert.equal(turn.error?.attempts, MAX_AVA_ATTEMPTS);
          assert.equal(
            turn.error?.message,
            field === 'id'
              ? 'Ava exposed an internal need ID.'
              : 'Ava exposed a non-focused private need.',
          );
          assert.ok(
            !JSON.stringify(turn.error)
              .toLowerCase()
              .includes(leakedNeed[field].toLowerCase()),
          );
          assert.equal(completion.calls.length, priorCalls + MAX_AVA_ATTEMPTS);
          assert.deepEqual(turn.needs, phase === 'initial' ? null : needs);
        } else {
          assert.equal(turn.message, message);
          assert.equal(turn.stop, false);
          assert.equal(turn.error, undefined);
          assert.equal(completion.calls.length, priorCalls + 1);
          assert.deepEqual(turn.needs, needs);
        }
      });
    }
  }

  for (const field of ['description', 'acceptance'] as const) {
    it(`accepts harmless overlap with private ${field} on both generated paths`, async () => {
      const need = {
        description: 'Review the result',
        acceptance: 'A review is complete.',
        [field]: 'ok',
      };
      const message = 'Could you look at the result?';
      const completion = scriptedCompletion(
        initialResponse([need], message),
        continuationResponse(['need_1'], message),
      );
      const ava = new AvaRolePlayer(
        { task: 'Review the result.' },
        completion.invoke,
        noRetryWait,
      );
      for (const answer of [undefined, 'Please continue.']) {
        const turn = await ava.nextTurn(answer);
        assert.equal(turn.message, message);
        assert.equal(turn.error, undefined);
      }
      assert.equal(completion.calls.length, 2);
    });
  }

  it('accepts task-model words without lexical rejection on both generated paths', async () => {
    const message =
      'Could you review the checklist, rubric, grading, remaining needs, and completion criteria?';
    const completion = scriptedCompletion(
      initialResponse(TWO_NEEDS, message),
      continuationResponse(['need_1'], message),
    );
    const ava = new AvaRolePlayer(
      { task: 'Explain the task.' },
      completion.invoke,
      noRetryWait,
    );
    for (const answer of [undefined, 'Please continue.']) {
      const turn = await ava.nextTurn(answer);
      assert.equal(turn.message, message);
      assert.equal(turn.error, undefined);
    }
    assert.equal(completion.calls.length, 2);
  });

  for (const [description, rejected] of [
    ['Review safe checkout UI', false], // Four words, 23 characters.
    ['Review payment confirmation', false], // Three words, over 24 characters.
    ['Review  payment  confirmation', false], // Whitespace is normalized before counting words.
    ['one   two   three    four', false], // Normalized length is under 24.
    ['Review safe checkout now', true], // Four words, 24 characters.
    ['Review the complete payment confirmation flow', true],
  ] as const) {
    for (const phase of ['initial', 'continuation'] as const) {
      it(`${rejected ? 'rejects' : 'accepts'} ${phase} non-focused description ${JSON.stringify(description)} at the match thresholds`, async () => {
        const message = `Could you ${description.toUpperCase().replaceAll(' ', '  \t')}?`;
        const needs = [
          {
            description: 'Choose the desired outcome',
          },
          { description },
        ];
        const completion = scriptedCompletion(
          initialResponse(
            needs,
            phase === 'initial' ? message : 'What outcome do you want?',
          ),
          ...(phase === 'continuation'
            ? [continuationResponse(['need_1', 'need_2'], message)]
            : []),
        );
        const ava = new AvaRolePlayer(
          { task: 'Review checkout.' },
          completion.invoke,
          noRetryWait,
        );
        if (phase === 'continuation') await ava.nextTurn();
        const turn = await ava.nextTurn(
          phase === 'initial' ? undefined : 'Please continue.',
        );
        if (rejected) {
          assert.equal(
            turn.error?.message,
            'Ava exposed a non-focused private need.',
          );
          assert.equal(turn.error?.attempts, MAX_AVA_ATTEMPTS);
          assert.equal(turn.message, '');
        } else {
          assert.equal(turn.error, undefined);
          assert.equal(turn.message, message);
        }
        assert.equal(
          completion.calls.length,
          (phase === 'initial' ? 0 : 1) + (rejected ? MAX_AVA_ATTEMPTS : 1),
        );
      });
    }
  }

  it('normalizes whitespace in a private description before matching a disclosure', async () => {
    const completion = scriptedCompletion(
      initialResponse(
        [
          { description: 'Choose the desired outcome' },
          {
            description: 'Review  the\tcomplete\ncheckout flow',
          },
        ],
        'Could you REVIEW THE COMPLETE CHECKOUT FLOW?',
      ),
    );
    const turn = await new AvaRolePlayer(
      { task: 'Review checkout.' },
      completion.invoke,
      noRetryWait,
    ).nextTurn();
    assert.equal(
      turn.error?.message,
      'Ava exposed a non-focused private need.',
    );
    assert.equal(completion.calls.length, MAX_AVA_ATTEMPTS);
  });

  it('accepts a partial non-focused description and words containing ID-like text', async () => {
    const message =
      'Could you review payment confirmation in need_1st and need_1_extra?';
    const completion = scriptedCompletion(
      initialResponse(
        [
          { description: 'Choose the desired outcome' },
          {
            description:
              'Review payment confirmation for the whole checkout flow',
          },
        ],
        message,
      ),
    );
    const turn = await new AvaRolePlayer(
      { task: 'Review checkout.' },
      completion.invoke,
      noRetryWait,
    ).nextTurn();
    assert.equal(turn.message, message);
    assert.equal(turn.error, undefined);
    assert.equal(completion.calls.length, 1);
  });

  it('fails before sending a configured opening if initialization is invalid', async () => {
    const completion = scriptedCompletion('{invalid');
    const turn = await new AvaRolePlayer(
      { task: 'Do the work', initialPrompt: 'Please do the work.' },
      completion.invoke,
      noRetryWait,
    ).nextTurn();
    assert.equal(turn.message, '');
    assert.equal(turn.error?.errorType, 'parse_error');
    assert.equal(turn.needs, null);
    assert.equal(completion.calls.length, MAX_AVA_ATTEMPTS);
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
      {
        id: 'need_2',
        description: TWO_NEEDS[1]!.description,
        acceptance: TWO_NEEDS[1]!.acceptance,
      },
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
      {
        id: 'need_2',
        description: TWO_NEEDS[1]!.description,
        acceptance: TWO_NEEDS[1]!.acceptance,
      },
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
      new CompletionInvocationError(
        'invalid_request',
        'temporary request failure',
      ),
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
          [{ description: 'Same need' }, { description: 'same need' }],
          'Question?',
        ),
      ],
      [
        'too many needs',
        initialResponse(
          Array.from({ length: MAX_AVA_NEEDS + 1 }, (_, index) => ({
            description: `Outcome ${index + 1}`,
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
        attempts: 4,
        message: undefined,
        explanation: `Ava request failed after ${4} attempts.`,
      },
    );
    assert.doesNotMatch(JSON.stringify(failedTurn), /secret-key/);
    assert.equal(failedTurn.error?.message?.length, 4096);
    assert.match(
      failedTurn.error!.message!,
      /^provider unavailable: \[REDACTED\] x+…$/,
    );
    assert.equal(failed.calls.length, 4);
  });

  it('keeps malformed JSON and schema diagnostics free of response values and unknown keys', async () => {
    for (const [response, message] of [
      ['{secret-response', 'Ava response was not valid JSON.'],
      [
        JSON.stringify({
          user_needs: [
            {
              description: 'safe',
              acceptance: 'The requested outcome is complete.',
              status: 'secret-status',
            },
          ],
          message: 'Hi',
        }),
        'Ava response did not match the required schema at response.user_needs[0] (unrecognized_keys).',
      ],
      [
        JSON.stringify({
          user_needs: [
            {
              description: 'safe',
              acceptance: 'The requested outcome is complete.',
            },
          ],
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
