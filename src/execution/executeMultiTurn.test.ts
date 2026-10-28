import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { criterionJudgment } from '../../test/fixtures/criterionJudgment.ts';

import { parseAtifTrajectory } from '../atif/index.ts';
import type { AgentAdapter } from '../contracts/agent.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type { ReadonlyWorkspace } from '../contracts/runtime.ts';
import {
  createJudgeTranscriptProjection,
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  type JudgeWorkspaceEvidenceV1,
  type JudgeWorkspaceWarningCode,
  MAX_JUDGE_WORKSPACE_ENTRIES,
  MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
  MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
  renderJudgeWorkspaceEvidence,
} from '../evaluation/index.ts';
import { regradeCompletedRun } from '../regrade/index.ts';
import {
  createArtifactStore,
  type InteractionArtifactV1,
  parseJudgeEvidence,
  verifyCompletedRun,
} from '../results/index.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.ts';
import { executeEval, executeEvalWithTestHooks } from './execute.ts';

const SECRET = 'completion-secret-for-redaction';
const AGENT_SECRET = 'agent-secret-for-redaction';
const SHORT_SECRET = 'zz';
const PRIVATE_REASONING_MARKER =
  'PRIVATE_REASONING_MARKER_must_remain_out_of_judge_requests';
const PRIVATE_REASONING_EFFORT_MARKER =
  'PRIVATE_REASONING_EFFORT_MARKER_must_remain_out_of_judge_requests';
const OMITTED_JUDGE_METADATA_MARKER =
  'OMITTED_JUDGE_METADATA_MARKER_must_remain_out_of_judge_requests';
const COPIED_CONTEXT_MARKER =
  'COPIED_CONTEXT_MARKER_must_remain_out_of_judge_requests';
const SYSTEM_STEP_MARKER =
  'SYSTEM_STEP_MARKER_must_remain_out_of_judge_requests';
const VISIBLE_TOOL_PAYLOAD_MARKER =
  'VISIBLE_TOOL_PAYLOAD_MARKER_must_remain_in_judge_requests';
const VISIBLE_RESPONSE_MARKER = 'VISIBLE_RESPONSE_MARKER_for_judging';
const VISIBLE_TOOL_MARKER = 'VISIBLE_TOOL_MARKER_for_judging';
const ROLE_MODEL = { provider: 'test-provider', model: 'role-model' } as const;
const JUDGE_MODEL = {
  provider: 'test-provider',
  model: 'judge-model',
} as const;

describe('executeEval multi-turn and judging integration', () => {
  it('forwards exclusions through agent views and sends app files past large dependency trees to the judge', async () => {
    const runtime = createFakeRuntimeAdapter({
      initialFiles: {
        ...Object.fromEntries(
          Array.from(
            { length: MAX_JUDGE_WORKSPACE_ENTRIES + 1 },
            (_, index) => [`node_modules/pkg/${index}.js`, 'dependency'],
          ),
        ),
        'src/app.ts': 'app source',
      },
    });
    const agent = createScriptedAgentAdapter();
    const probedViews: string[] = [];
    const probe = async (workspace: ReadonlyWorkspace, name: string) => {
      assert.deepEqual(
        (
          await workspace.listFiles({
            maxEntries: 2,
            excludeDirectoryNames: ['node_modules'],
          })
        ).map(({ path }) => path),
        ['src', 'src/app.ts'],
      );
      probedViews.push(name);
    };
    const probingAgent: AgentAdapter = {
      ...agent.adapter,
      async prepare(context) {
        await probe(context.runtime.workspace, 'prepare');
        await agent.adapter.prepare(context);
      },
      async openSession(context) {
        await probe(context.runtime.workspace, 'session');
        return agent.adapter.openSession(context);
      },
      async collectEvidence(context) {
        await probe(context.runtime.workspace, 'evidence');
        return agent.adapter.collectEvidence(context);
      },
    };
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        (request) => {
          assert.match(
            request.systemPrompt ?? '',
            /### src\/app.ts[\s\S]*app source/,
          );
          assert.doesNotMatch(request.systemPrompt ?? '', /dependency/);
          return JSON.stringify({
            results: [
              {
                index: 0,
                passed: true,
                explanation: 'App source was provided.',
              },
            ],
          });
        },
      ],
    });
    const artifacts = createMemoryArtifactStore();
    await executeEval({
      runId: 'excluded-dependencies',
      plan: createTestResolvedRunPlan({
        judgingCriteria: ['App source is present.'],
        judge: JUDGE_MODEL,
      }),
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[probingAgent.id, probingAgent]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
    });
    assert.deepEqual(probedViews, ['prepare', 'session', 'evidence']);
    const evidence = artifactJson(
      artifacts.runs.get('excluded-dependencies')!,
      'judge-evidence.json',
    ) as { workspace: { complete: boolean; truncated: boolean } };
    assert.equal(evidence.workspace.complete, true);
    assert.equal(evidence.workspace.truncated, false);
  });

  it('saves partial workspace text and its limit warning for verified regrade', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-partial-listing-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const runtime = createFakeRuntimeAdapter({
      initialFiles: Object.fromEntries(
        Array.from({ length: MAX_JUDGE_WORKSPACE_ENTRIES + 1 }, (_, index) => [
          `file-${String(index).padStart(5, '0')}.txt`,
          `app source ${index}`,
        ]),
      ),
    });
    const agent = createScriptedAgentAdapter();
    const response = JSON.stringify({
      results: [
        { index: 0, passed: true, explanation: 'Partial source was provided.' },
      ],
    });
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [response, response],
    });
    const completed = await executeEval({
      runId: 'partial-listing',
      plan: createTestResolvedRunPlan({
        judgingCriteria: ['App source is present.'],
        judge: JUDGE_MODEL,
      }),
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createArtifactStore({ root }),
      },
    });
    await verifyCompletedRun(completed.location);
    const evidence = parseJudgeEvidence(
      JSON.parse(
        await fs.readFile(
          path.join(completed.location, 'judge-evidence.json'),
          'utf8',
        ),
      ),
      { forgeVersion: completed.result.forge.version },
    );
    assert.equal(evidence.workspace.complete, false);
    assert.equal(evidence.workspace.truncated, true);
    assert.equal(evidence.workspace.entries[0]?.path, 'file-00000.txt');
    assert.ok(evidence.workspace.entries.length > 0);
    assert.ok(
      evidence.workspace.warnings.some(
        ({ code }) => code === 'workspace_entry_limit_reached',
      ),
    );
    const original = provider.calls[0]!.request.systemPrompt ?? '';
    assert.match(original, /### file-00000.txt[\s\S]*app source 0/);
    assert.match(original, /listing was truncated.*entry limit of 10000/);

    await regradeCompletedRun(
      { location: completed.location, judge: JUDGE_MODEL },
      {
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[1]!.request.systemPrompt, original);
  });

  it('preserves a long configured opening through execution and completed-run verification', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-long-opening-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const initialPrompt = [
      'Create a complete answer file.',
      '',
      'Preserve  the exact task details and\n\tinternal whitespace.\n'.repeat(
        20,
      ),
      'End of instructions.',
    ].join('\n');
    assert.ok(initialPrompt.length > 500);
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: 'Completed the requested answer.',
          sessionId: 'long-opening-session',
          toolCalls: [],
        },
      ],
    });
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        (request) => {
          assert.deepEqual(agent.messages, []);
          assert.ok(request.messages.every(({ role }) => role === 'user'));
          return JSON.stringify({
            user_needs: [
              {
                description: 'Create the answer file',
                acceptance: 'The requested answer file is complete.',
                status: 'remaining',
              },
            ],
          });
        },
        (request) => {
          assert.deepEqual(agent.messages, [initialPrompt]);
          assert.equal(request.messages[0]?.content, initialPrompt);
          return JSON.stringify({ remaining_need_ids: [], message: '' });
        },
      ],
    });

    const completed = await executeEval({
      runId: 'long-configured-opening',
      plan: createTestResolvedRunPlan({
        mode: 'multi_turn',
        prompt: 'Create an answer file.',
        initialPrompt,
        rolePlayer: ROLE_MODEL,
      }),
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createArtifactStore({ root }),
      },
      now: incrementingClock(),
    });

    assert.deepEqual(agent.messages, [initialPrompt]);
    assert.equal(completed.result.stop_reason, 'task_complete');
    assert.equal(completed.result.interaction.turn_count, 1);
    const verified = await verifyCompletedRun(completed.location);
    assert.deepEqual(verified.result, completed.result);
    const interaction = JSON.parse(
      await fs.readFile(
        path.join(completed.location, 'interaction.json'),
        'utf8',
      ),
    ) as InteractionArtifactV1;
    assert.equal(interaction.turns[0]?.user, initialPrompt);
    assert.equal(
      interaction.role_player?.decisions[0]?.source,
      'configured_initial_prompt',
    );
    assert.equal(interaction.role_player?.decisions[0]?.message, initialPrompt);
    const trajectory = parseAtifTrajectory(
      JSON.parse(
        await fs.readFile(
          path.join(completed.location, 'trajectory.json'),
          'utf8',
        ),
      ),
    );
    assert.equal(
      trajectory.steps.find(({ source }) => source === 'user')?.message,
      initialPrompt,
    );
  });

  it('runs Ava and judging after quiescence and commits their canonical audit', async () => {
    const expandingFiles = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
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
            { id: 'write-1', name: 'Write', input: { path: 'answer.txt' } },
          ],
          costUsd: 0.25,
        },
      ],
      requirements: {
        executables: [],
        environment: {
          credentials: {
            AGENT_TOKEN: { reference: credentialReference('agent.token') },
            SHORT_TOKEN: {
              reference: credentialReference('agent.short-token'),
            },
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
            token: { reference: credentialReference('completion.token') },
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
            {
              description: 'Deliver an answer in the specified file',
              acceptance: 'The requested answer file is complete.',
              status: 'remaining',
            },
          ],
          message: 'Please produce the requested answer file.',
        }),
        (request) => {
          assert.doesNotMatch(
            JSON.stringify(request),
            new RegExp(AGENT_SECRET),
          );
          assert.match(JSON.stringify(request.messages), /\[REDACTED\]/);
          return JSON.stringify({ remaining_need_ids: [], message: '' });
        },
        (request) => {
          assert.ok(runtime.runs[0]?.events.includes('quiesce'));
          assert.equal(request.purpose, 'judge');
          assert.doesNotMatch(
            request.systemPrompt ?? '',
            new RegExp(AGENT_SECRET),
          );
          assert.match(request.systemPrompt ?? '', /\[REDACTED\]/);
          assert.deepEqual(request.messages, [
            {
              role: 'user',
              content: 'Return the requested structured judgment.',
            },
          ]);
          judgeSystemPrompt = request.systemPrompt ?? '';
          return JSON.stringify(
            criterionJudgment(true, 'answer.txt is complete.'),
          );
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
      judgingCriteria: ['The requested answer file is complete.'],
      checks: { files_created: ['answer.txt'] },
      rolePlayer: ROLE_MODEL,
      judge: JUDGE_MODEL,
    });

    const completed = await executeEval({
      runId: 'multi-judge-1',
      plan,
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
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
    assert.deepEqual(agent.messages, [
      'Please produce the requested answer file.',
    ]);
    assert.deepEqual(
      completed.result.completion_calls.map(({ purpose }) => purpose),
      ['role_player', 'role_player', 'judge'],
    );
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
    assert.deepEqual(
      [...stored.artifacts.keys()],
      [
        'plan.json',
        'setup.json',
        'trajectory.json',
        'interaction.json',
        'workspace-evidence.json',
        'judge-evidence.json',
      ],
    );
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: Array<{ assistant: string }>;
      role_player: { needs: unknown[]; decisions: unknown[] };
    };
    assert.doesNotMatch(JSON.stringify(interaction), new RegExp(AGENT_SECRET));
    assert.match(interaction.turns[0]?.assistant ?? '', /\[REDACTED\]/);
    assert.equal(interaction.role_player.needs.length, 1);
    assert.equal(interaction.role_player.decisions.length, 2);

    const judgeEvidence = artifactJson(stored, 'judge-evidence.json') as {
      workspace: {
        complete: boolean;
        entries: Array<{ path: string; content: string; truncated: boolean }>;
        warnings: Array<{
          code: JudgeWorkspaceWarningCode;
          message: string;
          path?: string;
        }>;
      };
    };
    assert.match(
      judgeEvidence.workspace.entries.find(({ path }) => path === 'answer.txt')
        ?.content ?? '',
      /\[REDACTED\]/,
    );
    assert.doesNotMatch(
      JSON.stringify(judgeEvidence),
      new RegExp(AGENT_SECRET),
    );
    assert.doesNotMatch(
      JSON.stringify(judgeEvidence),
      new RegExp(SHORT_SECRET),
    );
    const auditedWorkspace: JudgeWorkspaceEvidenceV1 = {
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
        ({ content }) => content.length <= MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
      ),
    );
    assert.match(
      auditedWorkspaceText,
      /Workspace output limit of 80000 characters reached/,
    );
    assert.ok(judgeSystemPrompt.includes(auditedWorkspaceText));
  });

  it('falls back to every completed driver turn when native evidence misses the final turn', async () => {
    const firstUser = 'Complete the first part.';
    const firstAssistant = 'Completed the first part.';
    const secondUser = 'Now complete the second part.';
    const secondAssistant = 'Completed the second part.';
    const sessionId = 'incomplete-native-session';
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          usage: {
            input_tokens: 10,
            cached_input_tokens: 5,
            output_tokens: 4,
            reasoning_tokens: null,
          },
          text: firstAssistant,
          sessionId,
          toolCalls: [],
        },
        {
          usage: {
            input_tokens: 20,
            cached_input_tokens: 8,
            output_tokens: 6,
            reasoning_tokens: null,
          },
          text: secondAssistant,
          sessionId,
          toolCalls: [],
        },
      ],
      evidence: {
        kind: 'available',
        trajectory: {
          schema_version: 'ATIF-v1.8',
          session_id: sessionId,
          agent: {
            name: 'test-agent',
            version: '1',
            model_name: 'test-model',
          },
          steps: [
            { step_id: 1, source: 'user', message: firstUser },
            { step_id: 2, source: 'agent', message: firstAssistant },
          ],
        },
        source: {
          kind: 'native_log',
          format: 'test-jsonl',
          sessionId,
        },
        warnings: [],
      },
    });
    let judgeSystemPrompt = '';
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        JSON.stringify({
          user_needs: [
            {
              description: 'Complete both parts',
              acceptance: 'Both requested parts are complete.',
              status: 'remaining',
            },
          ],
          message: firstUser,
        }),
        JSON.stringify({
          remaining_need_ids: ['need_1'],
          message: secondUser,
        }),
        JSON.stringify({ remaining_need_ids: [], message: '' }),
        (request) => {
          assert.equal(request.purpose, 'judge');
          judgeSystemPrompt = request.systemPrompt ?? '';
          return JSON.stringify(
            criterionJudgment(true, 'Both completed turns are present.'),
          );
        },
      ],
    });
    const artifacts = createMemoryArtifactStore();

    const usageEvents: unknown[] = [];
    const perRunUsageEvents: unknown[] = [];
    const completed = await executeEval({
      runId: 'incomplete-native-fallback-1',
      observer: {
        observe(event) {
          if (event.type === 'agent_usage')
            perRunUsageEvents.push({ turn: event.turn, usage: event.usage });
        },
      },
      plan: createTestResolvedRunPlan({
        mode: 'multi_turn',
        prompt: 'Complete both parts.',
        maxTurns: 3,
        judgingCriteria: ['Both requested parts are complete.'],
        rolePlayer: ROLE_MODEL,
        judge: JUDGE_MODEL,
      }),
      composition: {
        observer: {
          observe(event) {
            if (event.type === 'agent_usage')
              usageEvents.push({ turn: event.turn, usage: event.usage });
          },
        },
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
      now: incrementingClock(),
    });

    assert.deepEqual(perRunUsageEvents, usageEvents);
    assert.deepEqual(completed.result.agent.usage, {
      input_tokens: 30,
      cached_input_tokens: 13,
      output_tokens: 10,
      reasoning_tokens: null,
    });
    assert.deepEqual(usageEvents, [
      {
        turn: 1,
        usage: {
          input_tokens: 10,
          cached_input_tokens: 5,
          output_tokens: 4,
          reasoning_tokens: null,
        },
      },
      {
        turn: 2,
        usage: {
          input_tokens: 20,
          cached_input_tokens: 8,
          output_tokens: 6,
          reasoning_tokens: null,
        },
      },
    ]);
    assert.deepEqual(agent.messages, [firstUser, secondUser]);
    assert.equal(completed.result.evidence.completeness, 'fallback');
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'driver_fallback',
    );
    assert.deepEqual(
      completed.result.evidence.warnings.map(({ code }) => code),
      ['source_incomplete', 'fallback_used'],
    );

    const stored = artifacts.runs.get('incomplete-native-fallback-1');
    assert.ok(stored);
    assert.deepEqual(
      [...stored.artifacts.keys()],
      [
        'plan.json',
        'setup.json',
        'trajectory.json',
        'interaction.json',
        'judge-evidence.json',
      ],
    );
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: Array<{
        turn: number;
        user: string;
        assistant: string;
        tool_calls: unknown[];
      }>;
    };
    assert.deepEqual(interaction.turns, [
      {
        turn: 1,
        user: firstUser,
        assistant: firstAssistant,
        tool_calls: [],
      },
      {
        turn: 2,
        user: secondUser,
        assistant: secondAssistant,
        tool_calls: [],
      },
    ]);

    const trajectory = parseAtifTrajectory(
      artifactJson(stored, 'trajectory.json'),
    );
    assert.deepEqual(
      trajectory.steps.map(({ source, message }) => ({ source, message })),
      [
        { source: 'user', message: firstUser },
        { source: 'agent', message: firstAssistant },
        { source: 'user', message: secondUser },
        { source: 'agent', message: secondAssistant },
      ],
    );
    assert.ok(judgeSystemPrompt.includes(firstUser));
    assert.ok(judgeSystemPrompt.includes(firstAssistant));
    assert.ok(judgeSystemPrompt.includes(secondUser));
    assert.ok(judgeSystemPrompt.includes(secondAssistant));
  });

  it('judges one post-redaction visible projection while preserving private reasoning in ATIF', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: 'Driver-visible response.',
          sessionId: 'reasoning-session',
          toolCalls: [
            {
              id: 'visible-call',
              name: VISIBLE_TOOL_MARKER,
              input: { path: 'answer.txt' },
            },
          ],
        },
      ],
      requirements: {
        executables: [],
        environment: {
          credentials: {
            AGENT_TOKEN: { reference: credentialReference('agent.token') },
          },
        },
        stateDirectories: [],
      },
      evidence: {
        kind: 'available',
        trajectory: {
          schema_version: 'ATIF-v1.8',
          session_id: 'reasoning-session',
          agent: {
            name: 'test-agent',
            version: '1',
            model_name: 'test-model',
          },
          steps: [
            {
              step_id: 1,
              source: 'agent',
              message: COPIED_CONTEXT_MARKER,
              is_copied_context: true,
            },
            {
              step_id: 2,
              source: 'system',
              message: SYSTEM_STEP_MARKER,
              extra: { private_metadata: OMITTED_JUDGE_METADATA_MARKER },
            },
            {
              step_id: 3,
              source: 'user',
              message: 'Produce visible evidence.',
            },
            {
              step_id: 4,
              source: 'agent',
              message: `${VISIBLE_RESPONSE_MARKER}: ${AGENT_SECRET}`,
              timestamp: '2026-09-16T00:00:00Z',
              model_name: OMITTED_JUDGE_METADATA_MARKER,
              llm_call_count: 1,
              reasoning_content: PRIVATE_REASONING_MARKER,
              reasoning_effort: PRIVATE_REASONING_EFFORT_MARKER,
              metrics: {
                prompt_token_ids: [112, 114, 105, 118, 97, 116, 101],
                extra: { private_metadata: OMITTED_JUDGE_METADATA_MARKER },
              },
              tool_calls: [
                {
                  tool_call_id: 'visible-call',
                  function_name: VISIBLE_TOOL_MARKER,
                  arguments: {
                    path: 'answer.txt',
                    reasoning_content: VISIBLE_TOOL_PAYLOAD_MARKER,
                  },
                  extra: { private_metadata: OMITTED_JUDGE_METADATA_MARKER },
                },
              ],
              observation: {
                results: [
                  {
                    source_call_id: 'visible-call',
                    content: `Visible result containing reasoning_effort: ${VISIBLE_TOOL_PAYLOAD_MARKER}`,
                    subagent_trajectory_ref: [
                      {
                        trajectory_path: 'private-child.json',
                        extra: {
                          private_metadata: OMITTED_JUDGE_METADATA_MARKER,
                        },
                      },
                    ],
                    extra: {
                      is_error: false,
                      private_metadata: OMITTED_JUDGE_METADATA_MARKER,
                    },
                  },
                ],
              },
              extra: { private_metadata: OMITTED_JUDGE_METADATA_MARKER },
            },
          ],
        },
        source: {
          kind: 'native_log',
          format: 'test-jsonl',
          sessionId: 'reasoning-session',
        },
        warnings: [],
      },
    });
    const judgePrompts: string[] = [];
    const judgeResponse = (request: {
      purpose: string;
      systemPrompt?: string;
    }) => {
      assert.equal(request.purpose, 'judge');
      const serializedRequest = JSON.stringify(request);
      assert.ok(!serializedRequest.includes(PRIVATE_REASONING_MARKER));
      assert.ok(!serializedRequest.includes(PRIVATE_REASONING_EFFORT_MARKER));
      assert.ok(!serializedRequest.includes(OMITTED_JUDGE_METADATA_MARKER));
      assert.ok(!serializedRequest.includes(COPIED_CONTEXT_MARKER));
      assert.ok(!serializedRequest.includes(SYSTEM_STEP_MARKER));
      assert.ok(!serializedRequest.includes('private-child.json'));
      assert.ok(!serializedRequest.includes(AGENT_SECRET));
      assert.match(request.systemPrompt ?? '', /\[REDACTED\]/);
      assert.ok((request.systemPrompt ?? '').includes(VISIBLE_RESPONSE_MARKER));
      assert.ok((request.systemPrompt ?? '').includes(VISIBLE_TOOL_MARKER));
      assert.ok(
        (request.systemPrompt ?? '').includes(VISIBLE_TOOL_PAYLOAD_MARKER),
      );
      assert.ok((request.systemPrompt ?? '').includes('"is_error":false'));
      judgePrompts.push(request.systemPrompt ?? '');
      return JSON.stringify(
        criterionJudgment(true, 'Visible evidence passed.'),
      );
    };
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [judgeResponse, judgeResponse],
    });
    const artifacts = createMemoryArtifactStore();
    const plan = createTestResolvedRunPlan({
      prompt: 'Produce visible evidence.',
      judgingCriteria: [
        'The assistant produced a visible response.',
        'The assistant invoked the visible tool.',
      ],
      judge: JUDGE_MODEL,
    });

    const completed = await executeEval({
      runId: 'reasoning-projection-1',
      plan,
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
        credentialResolver: createStaticCredentialResolver({
          'agent.token': AGENT_SECRET,
        }),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
    });

    assert.equal(judgePrompts.length, 2);
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'native_log',
    );
    const stored = artifacts.runs.get('reasoning-projection-1');
    assert.ok(stored);
    const trajectory = parseAtifTrajectory(
      artifactJson(stored, 'trajectory.json'),
    );
    const agentStep = trajectory.steps.find(
      (step) => step.source === 'agent' && step.is_copied_context !== true,
    );
    assert.equal(agentStep?.source, 'agent');
    assert.equal(agentStep?.reasoning_content, PRIVATE_REASONING_MARKER);
    assert.equal(agentStep?.reasoning_effort, PRIVATE_REASONING_EFFORT_MARKER);
    assert.match(
      typeof agentStep?.message === 'string' ? agentStep.message : '',
      /\[REDACTED\]/,
    );
    const projection = createJudgeTranscriptProjection(trajectory);
    for (const prompt of judgePrompts) {
      assert.ok(prompt.includes(projection.transcriptJson));
    }

    const judgeEvidence = artifactJson(stored, 'judge-evidence.json') as {
      transcript: {
        source: string;
        projection_id: string;
        trajectory_scope: string;
        included_step_sources: string[];
        copied_context: string;
        included_fields: string[];
        steps: unknown[];
      };
    };
    assert.ok(!('schema_version' in judgeEvidence));
    assert.deepEqual(judgeEvidence.transcript, {
      source: JUDGE_TRANSCRIPT_SOURCE,
      projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
      trajectory_scope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
      included_step_sources: [...JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES],
      copied_context: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
      included_fields: [...JUDGE_TRANSCRIPT_INCLUDED_FIELDS],
      steps: JSON.parse(projection.transcriptJson),
    });
    const storedTranscript = serializeCanonicalJson(
      judgeEvidence.transcript.steps,
    );
    assert.equal(storedTranscript, projection.transcriptJson);
    for (const prompt of judgePrompts) {
      assert.ok(prompt.includes(storedTranscript));
    }
  });

  it('fails closed when final prompt redaction would rewrite selected evidence bytes', async () => {
    // This credential is not present in any ATIF string. It appears only when
    // compact JSON joins the message value to the following source key.
    const boundarySecret = 'x","source';
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: 'x',
          sessionId: 'redaction-boundary-session',
          toolCalls: [],
        },
      ],
      evidence: {
        kind: 'available',
        trajectory: {
          schema_version: 'ATIF-v1.8',
          session_id: 'redaction-boundary-session',
          agent: { name: 'test-agent', version: '1' },
          steps: [
            { step_id: 1, source: 'user', message: 'Produce an answer.' },
            { step_id: 2, source: 'agent', message: 'x' },
          ],
        },
        source: {
          kind: 'native_log',
          format: 'test-jsonl',
          sessionId: 'redaction-boundary-session',
        },
        warnings: [],
      },
    });
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      requirements: {
        credentials: {
          token: {
            reference: credentialReference('completion.boundary-token'),
          },
        },
      },
      responses: [
        JSON.stringify(criterionJudgment(true, 'Visible evidence passed.')),
      ],
    });
    const artifacts = createMemoryArtifactStore();

    await assert.rejects(
      executeEvalWithTestHooks(
        {
          runId: 'redaction-boundary-1',
          plan: createTestResolvedRunPlan({
            prompt: 'Produce an answer.',
            judgingCriteria: ['The assistant produced an answer.'],
            judge: JUDGE_MODEL,
          }),
          composition: {
            runtime: runtime.adapter,
            agents: new Map([[agent.adapter.id, agent.adapter]]),
            completionProviders: new Map([
              [provider.provider.id, provider.provider],
            ]),
            credentialResolver: createStaticCredentialResolver({
              'completion.boundary-token': boundarySecret,
            }),
            inputProvider: createMemoryRunInputProvider(),
            artifactStore: artifacts.store,
          },
        },
        { waitBeforeCompletionRetry: async () => undefined },
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'evaluation_failed',
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(provider.remainingResponses, 1);
    assert.equal(artifacts.runs.size, 0);
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
  });

  it('commits a zero-turn role-player failure with system-only fallback ATIF', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter();
    const preallocatedSessionAgent = {
      ...agent.adapter,
      async openSession(
        context: Parameters<typeof agent.adapter.openSession>[0],
      ) {
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
        new Error('private transport detail four'),
      ],
    });
    const artifacts = createMemoryArtifactStore();
    const waits: Array<{ purpose: string; attempt: number }> = [];
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
          agents: new Map([
            [preallocatedSessionAgent.id, preallocatedSessionAgent],
          ]),
          completionProviders: new Map([
            [provider.provider.id, provider.provider],
          ]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: artifacts.store,
        },
      },
      {
        waitBeforeCompletionRetry: async (purpose, attempt) => {
          waits.push({ purpose, attempt });
        },
      },
    );

    assert.deepEqual(waits, [
      { purpose: 'role_player', attempt: 1 },
      { purpose: 'role_player', attempt: 2 },
      { purpose: 'role_player', attempt: 3 },
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
    assert.equal(completed.result.completion_calls.length, 4);
    assert.ok(
      completed.result.completion_calls.every(
        ({ status }) => status === 'failed',
      ),
    );
    assert.deepEqual(
      completed.result.warnings.map(({ code }) => code),
      ['role_player_error'],
    );

    const stored = artifacts.runs.get('ava-failure-1');
    assert.ok(stored);
    const trajectory = parseAtifTrajectory(
      artifactJson(stored, 'trajectory.json'),
    );
    assert.equal(trajectory.session_id, undefined);
    assert.deepEqual(
      trajectory.steps.map(({ source }) => source),
      ['system'],
    );
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'role_player_error',
    );
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: unknown[];
      failure: { error_type: string };
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
    const toolInput = { path: 'original.txt' };
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: 'Completed.',
          sessionId: 'snapshot-session',
          toolCalls: [{ id: 'call-1', name: 'Write', input: toolInput }],
        },
      ],
    });
    const originalCollectEvidence = agent.adapter.collectEvidence.bind(
      agent.adapter,
    );
    const snapshottingAgent = {
      ...agent.adapter,
      async collectEvidence(
        context: Parameters<typeof agent.adapter.collectEvidence>[0],
      ) {
        toolInput.path = 'mutated-after-interaction.txt';
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
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
    });

    const stored = artifacts.runs.get('one-shot-snapshot-1');
    assert.ok(stored);
    const interaction = artifactJson(stored, 'interaction.json') as {
      turns: Array<{ tool_calls: Array<{ input: unknown }> }>;
    };
    assert.deepEqual(interaction.turns[0]?.tool_calls[0]?.input, {
      path: 'original.txt',
    });
    const trajectory = parseAtifTrajectory(
      artifactJson(stored, 'trajectory.json'),
    );
    const fallbackAgentStep = trajectory.steps.find(
      (step) => step.source === 'agent',
    );
    assert.deepEqual(fallbackAgentStep?.tool_calls?.[0]?.arguments, {
      path: 'original.txt',
    });
  });

  it('rejects a session identity changed during the first agent turn', async () => {
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [
        { text: 'Completed.', sessionId: 'session-after', toolCalls: [] },
      ],
    });
    const changingSessionAgent = {
      ...agent.adapter,
      async openSession(
        context: Parameters<typeof agent.adapter.openSession>[0],
      ) {
        const opened = await agent.adapter.openSession(context);
        let completed = false;
        return {
          sessionId: () => (completed ? 'session-after' : 'session-before'),
          async send(message: string, options: { signal: AbortSignal }) {
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
        { text: 'first', sessionId: 'session-one', toolCalls: [] },
        { text: 'second', sessionId: 'session-two', toolCalls: [] },
      ],
    });
    const provider = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        JSON.stringify({
          user_needs: [
            {
              description: 'Finish both steps',
              acceptance: 'Both requested steps are complete.',
              status: 'remaining',
            },
          ],
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
          completionProviders: new Map([
            [provider.provider.id, provider.provider],
          ]),
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
  stored: { artifacts: ReadonlyMap<string, { body: Uint8Array }> },
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
