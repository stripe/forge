import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {AgentSession, AgentTurn} from '../contracts/agent.js';
import {AvaRolePlayer} from './ava.js';
import type {
  InteractionCompletionInvoker,
  InteractionCompletionRequest,
} from './completion.js';
import {runConversation} from './conversation.js';
import {AVA_STOP_SENTINEL} from './prompt.js';

function initialResponse(
  descriptions: readonly string[],
  message: string,
): string {
  return JSON.stringify({
    user_needs: descriptions.map((description) => ({
      description,
      status: 'remaining',
    })),
    message,
  });
}

function continuationResponse(
  remainingNeedIds: readonly string[],
  message: string,
): string {
  return JSON.stringify({remaining_need_ids: remainingNeedIds, message});
}

function completions(...steps: Array<string | Error>): {
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
      if (step === undefined) throw new Error('No completion was scripted.');
      return {
        content: step,
        stopReason: 'end_turn',
        usage: {inputTokens: 0, outputTokens: 0, cachedInputTokens: 0},
      };
    },
  };
}

function session(turns: readonly AgentTurn[]): {
  readonly sent: Array<{message: string; signal: AbortSignal}>;
  readonly value: AgentSession;
} {
  const pending = [...turns];
  const sent: Array<{message: string; signal: AbortSignal}> = [];
  return {
    sent,
    value: {
      async send(message, options) {
        sent.push({message, signal: options.signal});
        const turn = pending.shift();
        if (!turn) throw new Error('No agent turn was scripted.');
        return turn;
      },
      sessionId: () => 'persistent-session',
    },
  };
}

const noRetryWait = {
  waitBeforeRetry: async (): Promise<void> => undefined,
};

describe('runConversation', () => {
  it('uses one persistent session, aggregates cost, and returns stable completed turns', async () => {
    const needs = [
      'Understand the desired checkout experience',
      'Confirm the implementation was verified',
    ];
    const completion = completions(
      initialResponse(needs, 'How should checkout work?'),
      continuationResponse(['need_2'], 'How did you verify it?'),
      continuationResponse([], 'Closing prose is discarded.'),
    );
    const controller = new AbortController();
    const toolInput = {path: 'answer.txt'};
    const agent = session([
      {
        text: 'I implemented Checkout.',
        sessionId: 'persistent-session',
        toolCalls: [{id: 'call-1', name: 'Write', input: toolInput}],
        costUsd: 1,
      },
      {
        text: 'I ran the verification.',
        sessionId: 'persistent-session',
        toolCalls: [],
        costUsd: 2,
      },
    ]);
    const ava = new AvaRolePlayer(
      {task: 'Add Checkout', signal: controller.signal},
      completion.invoke,
    );
    const events: string[] = [];

    const result = await runConversation({
      session: agent.value,
      ava,
      maxTurns: 4,
      signal: controller.signal,
      onAvaStart: (turn) => events.push(`ava-start:${turn}`),
      onAvaResponse: (turn) => events.push(`ava-response:${turn}`),
      onTurn: (turn) => events.push(`agent-start:${turn}`),
      onResponse: (turn) => events.push(`agent-response:${turn}`),
    });

    assert.equal(result.stopReason, 'task_complete');
    assert.equal(result.totalCostUsd, 3);
    assert.equal(result.failure, null);
    assert.equal(agent.sent.length, 2);
    assert.deepEqual(
      agent.sent.map(({message}) => message),
      ['How should checkout work?', 'How did you verify it?'],
    );
    assert.ok(agent.sent.every(({signal}) => signal === controller.signal));
    assert.deepEqual(events, [
      'ava-start:1',
      'ava-response:1',
      'agent-start:1',
      'agent-response:1',
      'ava-start:2',
      'ava-response:2',
      'agent-start:2',
      'agent-response:2',
      'ava-start:3',
      'ava-response:3',
    ]);
    assert.deepEqual(result.avaAudit, {
      needs: [
        {id: 'need_1', description: needs[0]},
        {id: 'need_2', description: needs[1]},
      ],
      decisions: [
        {
          sequence: 1,
          afterAgentTurn: null,
          message: 'How should checkout work?',
          stop: false,
          remainingNeedIds: ['need_1', 'need_2'],
          focusNeedId: 'need_1',
          codingAgentInvoked: true,
          source: 'generated',
        },
        {
          sequence: 2,
          afterAgentTurn: 1,
          message: 'How did you verify it?',
          stop: false,
          remainingNeedIds: ['need_2'],
          focusNeedId: 'need_2',
          codingAgentInvoked: true,
          source: 'generated',
        },
        {
          sequence: 3,
          afterAgentTurn: 2,
          message: '',
          stop: true,
          remainingNeedIds: [],
          focusNeedId: null,
          codingAgentInvoked: false,
          source: 'generated',
        },
      ],
    });
    assert.deepEqual(result.turns, [
      {
        turn: 1,
        user: 'How should checkout work?',
        assistant: 'I implemented Checkout.',
        toolCalls: [
          {id: 'call-1', name: 'Write', input: {path: 'answer.txt'}},
        ],
      },
      {
        turn: 2,
        user: 'How did you verify it?',
        assistant: 'I ran the verification.',
        toolCalls: [],
      },
    ]);
    toolInput.path = 'mutated-after-completion.txt';
    assert.deepEqual(result.turns[0]!.toolCalls[0]!.input, {
      path: 'answer.txt',
    });
    assert.equal(Object.isFrozen(result.turns), true);
    assert.equal(Object.isFrozen(result.turns[0]!.toolCalls), true);
  });

  it('performs a final Ava assessment without exceeding maxTurns', async () => {
    const completion = completions(
      initialResponse(['Complete the requested work'], 'Please do the work.'),
      continuationResponse(['need_1'], 'This follow-up cannot be sent.'),
    );
    const signal = new AbortController().signal;
    const agent = session([
      {
        text: 'Still incomplete.',
        sessionId: 'persistent-session',
        toolCalls: [],
        costUsd: 0.5,
      },
    ]);

    const result = await runConversation({
      session: agent.value,
      ava: new AvaRolePlayer({task: 'Do the work', signal}, completion.invoke),
      maxTurns: 1,
      signal,
    });

    assert.equal(agent.sent.length, 1);
    assert.equal(completion.calls.length, 2);
    assert.equal(result.stopReason, 'max_turns');
    assert.deepEqual(result.avaAudit.decisions[1], {
      sequence: 2,
      afterAgentTurn: 1,
      message: '',
      stop: false,
      remainingNeedIds: ['need_1'],
      focusNeedId: null,
      codingAgentInvoked: false,
      source: 'generated',
    });
  });

  it('rejects a non-finite aggregate cost before returning a result', async () => {
    const completion = completions(
      initialResponse(['Complete the requested work'], 'Please start.'),
      continuationResponse(['need_1'], 'Please continue.'),
    );
    const signal = new AbortController().signal;
    const agent = session([
      {
        text: 'First response.',
        sessionId: 'persistent-session',
        toolCalls: [],
        costUsd: Number.MAX_VALUE,
      },
      {
        text: 'Second response.',
        sessionId: 'persistent-session',
        toolCalls: [],
        costUsd: Number.MAX_VALUE,
      },
    ]);

    await assert.rejects(
      runConversation({
        session: agent.value,
        ava: new AvaRolePlayer({task: 'Do the work', signal}, completion.invoke),
        maxTurns: 2,
        signal,
      }),
      /invalid total/,
    );
    assert.equal(agent.sent.length, 2);
  });

  it('records completion from the final assessment without another agent call', async () => {
    const completion = completions(
      initialResponse(['Complete the requested work'], 'Please do the work.'),
      continuationResponse([], 'Done.'),
    );
    const signal = new AbortController().signal;
    const agent = session([
      {text: 'Complete.', sessionId: 'persistent-session', toolCalls: []},
    ]);

    const result = await runConversation({
      session: agent.value,
      ava: new AvaRolePlayer({task: 'Do the work', signal}, completion.invoke),
      maxTurns: 1,
      signal,
    });

    assert.equal(agent.sent.length, 1);
    assert.equal(result.stopReason, 'task_complete');
    assert.equal(result.totalCostUsd, null);
    assert.equal(result.avaAudit.decisions[1]!.stop, true);
    assert.equal(result.avaAudit.decisions[1]!.codingAgentInvoked, false);
  });

  it('returns a classified role-player failure without another agent call', async () => {
    const completion = completions(
      initialResponse(['Complete the requested work'], 'Please do the work.'),
      new Error('provider detail must not escape'),
    );
    const signal = new AbortController().signal;
    const agent = session([
      {text: 'Partial work.', sessionId: 'persistent-session', toolCalls: []},
    ]);

    const result = await runConversation({
      session: agent.value,
      ava: new AvaRolePlayer(
        {task: 'Do the work', signal},
        completion.invoke,
        noRetryWait,
      ),
      maxTurns: 3,
      signal,
    });

    assert.equal(agent.sent.length, 1);
    assert.equal(result.stopReason, 'role_player_error');
    assert.deepEqual(result.failure, {
      status: 'role_player_error',
      errorType: 'request_error',
      attempts: 3,
      explanation: 'Ava request failed after 3 attempts.',
    });
    assert.equal(
      result.avaAudit.decisions.at(-1)!.codingAgentInvoked,
      false,
    );
    assert.deepEqual(result.avaAudit.decisions.at(-1)!.error, result.failure);
    assert.doesNotMatch(JSON.stringify(result), /provider detail/);
  });

  it('preserves configured stop-sentinel behavior and validates completed turns', async () => {
    const completion = completions(new Error('must not be called'));
    const signal = new AbortController().signal;
    const agent = session([
      {text: 'Done.', sessionId: 'persistent-session', toolCalls: []},
    ]);
    const validatedLengths: number[] = [];
    const result = await runConversation({
      session: agent.value,
      ava: new AvaRolePlayer(
        {
          task: 'Do the work',
          initialPrompt: `Finish this request.\n${AVA_STOP_SENTINEL}`,
          signal,
        },
        completion.invoke,
      ),
      maxTurns: 3,
      signal,
      validateCompletedTurns: (turns) => validatedLengths.push(turns.length),
    });

    assert.equal(completion.calls.length, 0);
    assert.equal(agent.sent.length, 1);
    assert.equal(result.stopReason, 'task_complete');
    assert.deepEqual(result.avaAudit.needs, null);
    assert.deepEqual(validatedLengths, [1]);
  });

  it('stops before another Ava decision when completed-turn validation fails', async () => {
    const completion = completions(
      initialResponse(['Complete the requested work'], 'Please do the work.'),
      continuationResponse([], 'Never reached.'),
    );
    const signal = new AbortController().signal;
    const agent = session([
      {text: 'Response.', sessionId: 'persistent-session', toolCalls: []},
    ]);

    await assert.rejects(
      runConversation({
        session: agent.value,
        ava: new AvaRolePlayer({task: 'Do the work', signal}, completion.invoke),
        maxTurns: 3,
        signal,
        validateCompletedTurns: () => {
          throw new Error('turn limit exceeded');
        },
      }),
      /turn limit exceeded/,
    );
    assert.equal(agent.sent.length, 1);
    assert.equal(completion.calls.length, 1);
  });
});
