import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseAtifTrajectory} from '../atif/index.js';
import {credentialReference} from '../contracts/credentials.js';
import {
  MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
  MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
  renderJudgeWorkspaceEvidence,
  type JudgeWorkspaceEvidenceV1,
  type JudgeWorkspaceWarningCode,
} from '../evaluation/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.js';
import {executeEval, executeEvalWithTestHooks} from './execute.js';

const SECRET = 'completion-secret-for-redaction';
const AGENT_SECRET = 'agent-secret-for-redaction';
const SHORT_SECRET = 'zz';
const ROLE_MODEL = {provider: 'test-provider', model: 'role-model'} as const;
const JUDGE_MODEL = {provider: 'test-provider', model: 'judge-model'} as const;

describe('executeEval multi-turn and judging integration', () => {
  it('runs Ava and judging after quiescence and commits their canonical audit', async () => {
    const expandingFiles = Object.fromEntries(
      Array.from({length: 5}, (_, index) => [
        `expanding-${index}.txt`,
        SHORT_SECRET.repeat(20_000),
      ]),
    );
    const runtime = createFakeRuntimeAdapter({
      initialFiles: {
        'answer.txt': `complete\nagent output: ${AGENT_SECRET}\n`,
        'ungraded-note.txt': `agent output: ${AGENT_SECRET}\n`,
        ...expandingFiles,
      },
    });
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: `Implemented the requested answer with ${AGENT_SECRET}.`,
          sessionId: 'multi-session',
          toolCalls: [
            {id: 'write-1', name: 'Write', input: {path: 'answer.txt'}},
          ],
          costUsd: 0.25,
        },
      ],
      requirements: {
        executables: [],
        environment: {
          credentials: {
            AGENT_TOKEN: {reference: credentialReference('agent.token')},
            SHORT_TOKEN: {reference: credentialReference('agent.short-token')},
          },
        },
        stateDirectories: [],
      },
    });
    let judgeSystemPrompt = '';
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      requirements(input) {
        assert.equal(runtime.runs.length, 0);
        assert.ok(input.purpose === 'role_player' || input.purpose === 'judge');
        return {
          credentials: {
            token: {reference: credentialReference('completion.token')},
          },
        };
      },
      preflight(input) {
        assert.equal(runtime.runs.length, 0);
        assert.equal(input.credentials.token, SECRET);
      },
      responses: [
        JSON.stringify({
          user_needs: [
            {description: 'Produce the requested answer file', status: 'remaining'},
          ],
          message: 'Please produce the requested answer file.',
        }),
        (request) => {
          assert.doesNotMatch(JSON.stringify(request), new RegExp(AGENT_SECRET));
          assert.match(JSON.stringify(request.messages), /\[REDACTED\]/);
          return JSON.stringify({remaining_need_ids: [], message: ''});
        },
        (request) => {
          assert.ok(runtime.runs[0]?.events.includes('quiesce'));
          assert.equal(request.purpose, 'judge');
          assert.doesNotMatch(request.systemPrompt ?? '', new RegExp(AGENT_SECRET));
          assert.match(request.systemPrompt ?? '', /\[REDACTED\]/);
          assert.deepEqual(request.messages, [
            {role: 'user', content: 'Return the requested structured judgment.'},
          ]);
          judgeSystemPrompt = request.systemPrompt ?? '';
          return JSON.stringify({
            results: [{index: 0, passed: true, explanation: 'answer.txt is complete.'}],
          });
        },
      ],
    });
    const credentialPurposes: string[] = [];
    const artifacts = createMemoryArtifactStore();
    const plan = createTestResolvedRunPlan({
      mode: 'multi_turn',
      prompt: 'Create a complete answer file.',
      context: 'A developer validating an implementation.',
      maxTurns: 3,
      successGuidelines: ['The requested answer file is complete.'],
      checks: {files_created: ['answer.txt']},
      rolePlayer: ROLE_MODEL,
      judge: JUDGE_MODEL,
    });

    const completed = await executeEval({
      runId: 'multi-judge-1',
      plan,
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        setupHandlers: new Map(),
        completionProviders: new Map([[provider.provider.id, provider.provider]]),
        credentialResolver: createStaticCredentialResolver(
          {
            'agent.token': AGENT_SECRET,
            'agent.short-token': SHORT_SECRET,
            'completion.token': SECRET,
          },
          {
            onResolve(_reference, purpose) {
              assert.equal(runtime.runs.length, 0);
              credentialPurposes.push(purpose);
            },
          },
        ),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
      now: incrementingClock(),
    });

    assert.deepEqual(credentialPurposes, [
      'forge-eval:AGENT_TOKEN',
      'forge-eval:SHORT_TOKEN',
      'forge-eval:completion:role_player:token',
      'forge-eval:completion:judge:token',
    ]);
    assert.deepEqual(agent.messages, ['Please produce the requested answer file.']);
    assert.deepEqual(completed.result.completion_calls.map(({purpose}) => purpose), [
      'role_player',
      'role_player',
      'judge',
    ]);
    assert.deepEqual(completed.result.interaction, {
      mode: 'multi_turn',
      turn_count: 1,
    });
    assert.equal(completed.result.stop_reason, 'task_complete');
    assert.equal(completed.result.agent.cost_usd, 0.25);
    assert.equal(completed.result.evaluation.status, 'passed');
    assert.equal(completed.result.evaluation.score, 1);
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');

    const stored = artifacts.runs.get('multi-judge-1');
    assert.ok(stored);
    assert.deepEqual([...stored.artifacts.keys()], [
      'plan.json',
      'trajectory.json',
      'interaction.json',
      'workspace-evidence.json',
      'judge-evidence.json',
      'evaluation.json',
    ]);
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: Array<{assistant: string}>;
      role_player: {needs: unknown[]; decisions: unknown[]};
    };
    assert.doesNotMatch(JSON.stringify(interaction), new RegExp(AGENT_SECRET));
    assert.match(interaction.turns[0]?.assistant ?? '', /\[REDACTED\]/);
    assert.equal(interaction.role_player.needs.length, 1);
    assert.equal(interaction.role_player.decisions.length, 2);

    const judgeEvidence = artifactJson(stored, 'judge-evidence.json') as {
      trajectory_sha256: string;
      workspace: {
        complete: boolean;
        entries: Array<{path: string; content: string; truncated: boolean}>;
        warnings: Array<{
          code: JudgeWorkspaceWarningCode;
          message: string;
          path?: string;
        }>;
      };
    };
    assert.equal(
      judgeEvidence.trajectory_sha256,
      completed.result.artifacts.find(({path}) => path === 'trajectory.json')?.sha256,
    );
    assert.match(
      judgeEvidence.workspace.entries.find(({path}) => path === 'answer.txt')
        ?.content ?? '',
      /\[REDACTED\]/,
    );
    assert.doesNotMatch(JSON.stringify(judgeEvidence), new RegExp(AGENT_SECRET));
    assert.doesNotMatch(JSON.stringify(judgeEvidence), new RegExp(SHORT_SECRET));
    const auditedWorkspace: JudgeWorkspaceEvidenceV1 = {
      schema_version: 1,
      entries: judgeEvidence.workspace.entries.map((entry) => ({
        ...entry,
        size_bytes: 0,
        bytes_read: 0,
      })),
      complete: judgeEvidence.workspace.complete,
      truncated: !judgeEvidence.workspace.complete,
      bytes_read: 0,
      warnings: judgeEvidence.workspace.warnings,
    };
    const auditedWorkspaceText = renderJudgeWorkspaceEvidence(auditedWorkspace);
    assert.ok(
      auditedWorkspaceText.length <= MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
    );
    assert.ok(
      auditedWorkspace.entries.every(
        ({content}) => content.length <= MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
      ),
    );
    assert.match(
      auditedWorkspaceText,
      /Workspace output limit of 80000 characters reached/,
    );
    assert.ok(judgeSystemPrompt.includes(auditedWorkspaceText));
  });

  it('commits a zero-turn role-player failure with system-only fallback ATIF', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter();
    const preallocatedSessionAgent = {
      ...agent.adapter,
      async openSession(context: Parameters<typeof agent.adapter.openSession>[0]) {
        const opened = await agent.adapter.openSession(context);
        return {
          ...opened,
          // Some adapters know the allocated session before the first send.
          // A zero-turn failure must still record no agent session identity.
          sessionId: () => 'preallocated-session',
        };
      },
    };
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        new Error('private transport detail one'),
        new Error('private transport detail two'),
        new Error('private transport detail three'),
      ],
    });
    const artifacts = createMemoryArtifactStore();
    const waits: Array<{purpose: string; attempt: number}> = [];
    const plan = createTestResolvedRunPlan({
      mode: 'multi_turn',
      prompt: 'Complete a task through conversation.',
      rolePlayer: ROLE_MODEL,
    });

    const completed = await executeEvalWithTestHooks(
      {
        runId: 'ava-failure-1',
        plan,
        composition: {
          runtime: runtime.adapter,
          agents: new Map([[preallocatedSessionAgent.id, preallocatedSessionAgent]]),
          setupHandlers: new Map(),
          completionProviders: new Map([[provider.provider.id, provider.provider]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: artifacts.store,
        },
      },
      {
        waitBeforeCompletionRetry: async (purpose, attempt) => {
          waits.push({purpose, attempt});
        },
      },
    );

    assert.deepEqual(waits, [
      {purpose: 'role_player', attempt: 1},
      {purpose: 'role_player', attempt: 2},
    ]);
    assert.deepEqual(agent.messages, []);
    assert.ok(!agent.events.includes('collect-evidence'));
    assert.equal(completed.result.stop_reason, 'role_player_error');
    assert.deepEqual(completed.result.interaction, {
      mode: 'multi_turn',
      turn_count: 0,
    });
    assert.equal(completed.result.agent.session_id, null);
    assert.equal(completed.result.failure?.error_type, 'request_error');
    assert.equal(completed.result.completion_calls.length, 3);
    assert.ok(completed.result.completion_calls.every(({status}) => status === 'failed'));
    assert.deepEqual(completed.result.warnings.map(({code}) => code), [
      'role_player_error',
    ]);

    const stored = artifacts.runs.get('ava-failure-1');
    assert.ok(stored);
    const trajectory = parseAtifTrajectory(artifactJson(stored, 'trajectory.json'));
    assert.equal(trajectory.session_id, undefined);
    assert.deepEqual(trajectory.steps.map(({source}) => source), ['system']);
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'role_player_error',
    );
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: unknown[];
      failure: {error_type: string};
    };
    assert.deepEqual(interaction.turns, []);
    assert.equal(interaction.failure.error_type, 'request_error');
  });

  it('rejects an invalid coding-agent cost at the interaction boundary', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: 'Completed.',
          sessionId: 'cost-session',
          toolCalls: [],
          costUsd: -1,
        },
      ],
    });
    const artifacts = createMemoryArtifactStore();

    await assert.rejects(
      executeEval({
        runId: 'invalid-agent-cost-1',
        plan: createTestResolvedRunPlan(),
        composition: {
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          setupHandlers: new Map(),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: artifacts.store,
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'agent_failed' &&
        'phase' in error &&
        error.phase === 'interaction',
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
    assert.equal(artifacts.runs.size, 0);
  });

  it('snapshots one-shot tool input before sealed evidence collection', async () => {
    const runtime = createFakeRuntimeAdapter();
    const toolInput = {path: 'original.txt'};
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: 'Completed.',
          sessionId: 'snapshot-session',
          toolCalls: [{id: 'call-1', name: 'Write', input: toolInput}],
        },
      ],
    });
    const originalCollectEvidence = agent.adapter.collectEvidence.bind(agent.adapter);
    const snapshottingAgent = {
      ...agent.adapter,
      async collectEvidence(
        context: Parameters<typeof agent.adapter.collectEvidence>[0],
      ) {
        toolInput.path = 'mutated-after-interaction.txt';
        assert.deepEqual(context.fallbackTurns[0]?.toolCalls[0]?.input, {
          path: 'original.txt',
        });
        assert.equal(
          Object.isFrozen(context.fallbackTurns[0]?.toolCalls[0]?.input),
          true,
        );
        return originalCollectEvidence(context);
      },
    };
    const artifacts = createMemoryArtifactStore();

    await executeEval({
      runId: 'one-shot-snapshot-1',
      plan: createTestResolvedRunPlan(),
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[snapshottingAgent.id, snapshottingAgent]]),
        setupHandlers: new Map(),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
    });

    const stored = artifacts.runs.get('one-shot-snapshot-1');
    assert.ok(stored);
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: Array<{tool_calls: Array<{input: unknown}>}>;
    };
    assert.deepEqual(interaction.turns[0]?.tool_calls[0]?.input, {
      path: 'original.txt',
    });
  });

  it('rejects a session identity changed during the first agent turn', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {text: 'Completed.', sessionId: 'session-after', toolCalls: []},
      ],
    });
    const changingSessionAgent = {
      ...agent.adapter,
      async openSession(context: Parameters<typeof agent.adapter.openSession>[0]) {
        const opened = await agent.adapter.openSession(context);
        let completed = false;
        return {
          sessionId: () => (completed ? 'session-after' : 'session-before'),
          async send(
            message: string,
            options: {signal: AbortSignal},
          ) {
            const turn = await opened.send(message, options);
            completed = true;
            return turn;
          },
        };
      },
    };
    const artifacts = createMemoryArtifactStore();

    await assert.rejects(
      executeEval({
        runId: 'first-turn-session-change-1',
        plan: createTestResolvedRunPlan(),
        composition: {
          runtime: runtime.adapter,
          agents: new Map([[changingSessionAgent.id, changingSessionAgent]]),
          setupHandlers: new Map(),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: artifacts.store,
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'agent_failed',
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
    assert.equal(artifacts.runs.size, 0);
  });

  it('rejects a coding agent that changes session identity between turns', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {text: 'first', sessionId: 'session-one', toolCalls: []},
        {text: 'second', sessionId: 'session-two', toolCalls: []},
      ],
    });
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        JSON.stringify({
          user_needs: [{description: 'Finish both steps', status: 'remaining'}],
          message: 'Please do the first step.',
        }),
        JSON.stringify({
          remaining_need_ids: ['need_1'],
          message: 'Please finish the second step.',
        }),
      ],
    });
    const artifacts = createMemoryArtifactStore();

    await assert.rejects(
      executeEval({
        runId: 'mixed-session-1',
        plan: createTestResolvedRunPlan({
          mode: 'multi_turn',
          prompt: 'Finish both steps.',
          rolePlayer: ROLE_MODEL,
        }),
        composition: {
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          setupHandlers: new Map(),
          completionProviders: new Map([[provider.provider.id, provider.provider]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: artifacts.store,
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'agent_failed' &&
        'phase' in error &&
        error.phase === 'interaction',
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
    assert.equal(artifacts.runs.size, 0);
  });
});

function artifactJson(
  stored: {artifacts: ReadonlyMap<string, {body: Uint8Array}>},
  path: string,
): unknown {
  const artifact = stored.artifacts.get(path);
  assert.ok(artifact, `Missing artifact: ${path}`);
  return JSON.parse(Buffer.from(artifact.body).toString('utf8')) as unknown;
}

function incrementingClock(): () => Date {
  let milliseconds = Date.parse('2026-09-15T00:00:00.000Z');
  return () => new Date(milliseconds++);
}
