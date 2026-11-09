import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { AgentAdapter } from '../src/contracts/agent.ts';
import { executeEvalWithTestHooks } from '../src/execution/execute.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';

type Outcome =
  | 'one_shot'
  | 'task_complete'
  | 'max_turns'
  | 'role_player_error'
  | 'zero_turn_error';

function fixture(outcome: Outcome) {
  const runtime = createFakeRuntimeAdapter();
  const scripted = createScriptedAgentAdapter({
    turns: [1, 2].map((index) => ({
      text: `Done ${index}`,
      sessionId: 'test-session',
      toolCalls: [],
    })),
  });
  const completion = createScriptedCompletionProvider({
    id: 'test-provider',
    responses:
      outcome === 'role_player_error' || outcome === 'zero_turn_error'
        ? [new Error('failed'), new Error('failed'), new Error('failed')]
        : [
            JSON.stringify({
              user_needs: [{ description: 'Finish', status: 'remaining' }],
              message: 'Continue',
            }),
            JSON.stringify({
              remaining_need_ids: outcome === 'task_complete' ? [] : ['need_1'],
              message: outcome === 'task_complete' ? '' : 'Continue',
            }),
          ],
  });
  const plan = createTestResolvedRunPlan({
    mode: outcome === 'one_shot' ? 'one_shot' : 'multi_turn',
    ...(outcome === 'zero_turn_error' ? {} : { initialPrompt: 'Start' }),
    maxTurns: 2,
    ...(outcome === 'one_shot'
      ? {}
      : { rolePlayer: { provider: 'test-provider', model: 'scripted' } }),
  });
  return {
    runtime,
    scripted,
    plan,
    composition: {
      runtime: runtime.adapter,
      agents: new Map([[scripted.adapter.id, scripted.adapter]]),
      completionProviders: new Map([
        [completion.provider.id, completion.provider],
      ]),
      credentialResolver: createStaticCredentialResolver(),
      inputProvider: createMemoryRunInputProvider(),
      artifactStore: createMemoryArtifactStore().store,
    },
  };
}

describe('agent session finalization', () => {
  for (const outcome of [
    'one_shot',
    'task_complete',
    'max_turns',
    'role_player_error',
    'zero_turn_error',
  ] as const) {
    it(`awaits one finalization after interaction for ${outcome}`, async () => {
      const test = fixture(outcome);
      let finalized = 0;
      const adapter: AgentAdapter = {
        ...test.scripted.adapter,
        async openSession(context) {
          const session = await test.scripted.adapter.openSession(context);
          return {
            ...session,
            async finalize(signal) {
              assert.equal(signal, context.signal);
              assert.equal(
                test.scripted.messages.length,
                outcome === 'zero_turn_error'
                  ? 0
                  : outcome === 'one_shot' || outcome === 'role_player_error'
                    ? 1
                    : 2,
              );
              assert.equal(
                test.runtime.runs[0]!.events.includes('quiesce'),
                false,
              );
              await context.runtime.commands.agent.run(['capture'], { signal });
              await context.runtime.workspace.writeFile(
                'finalized.txt',
                Buffer.from('captured'),
              );
              finalized++;
            },
          };
        },
        async collectEvidence(context) {
          assert.equal(finalized, 1);
          assert.equal(test.runtime.runs[0]!.events.includes('quiesce'), true);
          assert.equal(
            Buffer.from(
              await context.runtime.workspace.readFile('finalized.txt'),
            ).toString(),
            'captured',
          );
          return test.scripted.adapter.collectEvidence(context);
        },
      };
      const completed = await executeEvalWithTestHooks(
        {
          runId: `finalize-${outcome}`,
          plan: test.plan,
          composition: {
            ...test.composition,
            agents: new Map([[adapter.id, adapter]]),
          },
        },
        { waitBeforeCompletionRetry: async () => undefined },
      );
      assert.equal(finalized, 1);
      assert.equal(
        completed.result.stop_reason,
        outcome === 'one_shot'
          ? 'task_complete'
          : outcome === 'zero_turn_error'
            ? 'role_player_error'
            : outcome,
      );
    });
  }
  for (const failure of ['rejection', 'cancellation', 'send'] as const) {
    it(`fails interaction without quiescing after ${failure}`, async () => {
      const test = fixture('one_shot');
      const controller = new AbortController();
      let finalized = 0;
      const adapter: AgentAdapter = {
        ...test.scripted.adapter,
        async openSession(context) {
          const session = await test.scripted.adapter.openSession(context);
          return {
            ...session,
            async send(message, options) {
              if (failure === 'send') throw new Error('failed send');
              return session.send(message, options);
            },
            async finalize(signal) {
              finalized++;
              if (failure === 'cancellation') {
                controller.abort(new Error('cancelled'));
                signal.throwIfAborted();
              }
              throw new Error('failed finalization');
            },
          };
        },
      };
      await assert.rejects(
        executeEvalWithTestHooks(
          {
            runId: `finalize-${failure}`,
            plan: test.plan,
            signal: controller.signal,
            composition: {
              ...test.composition,
              agents: new Map([[adapter.id, adapter]]),
            },
          },
          {},
        ),
        (error: unknown) => {
          assert.equal((error as { phase: string }).phase, 'interaction');
          return true;
        },
      );
      assert.equal(finalized, failure === 'send' ? 0 : 1);
      assert.equal(test.runtime.runs[0]!.events.includes('quiesce'), false);
      assert.equal(test.runtime.runs[0]!.events.includes('dispose'), true);
    });
  }
});
