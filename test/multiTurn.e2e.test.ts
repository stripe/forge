import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, it } from 'vitest';

import { runCli } from '../src/cli.ts';
import type { AgentAdapter } from '../src/contracts/agent.ts';
import type { CompletionProvider } from '../src/contracts/completion.ts';
import { createDirectoryRunInputProvider } from '../src/contracts/inputs.ts';
import { executeEval } from '../src/execution/execute.ts';
import { createOpenAICompletionProvider } from '../src/providers/openai/index.ts';
import {
  createArtifactStore,
  parseInteractionArtifact,
  parseJudgeEvidence,
  verifyCompletedRun,
} from '../src/results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('multi-turn CLI end to end', () => {
  it('keeps serialized Sol requests byte-for-byte unchanged when Ava and judge omit temperature', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sol-e2e-'));
    temporaryDirectories.push(root);
    const bodies: string[] = [];
    const transport = createOpenAICompletionProvider({
      fetch: async (_, init) => {
        const body = String(init?.body);
        bodies.push(body);
        const { text } = JSON.parse(body);
        const answers: Record<string, unknown> = {
          ava_initial_turn: {
            user_needs: [
              {
                description: 'Complete the task',
                acceptance: 'The task is reported as done.',
                status: 'remaining',
              },
            ],
            message: 'Please complete the task.',
          },
          ava_turn: { remaining_need_ids: [], message: '' },
          criterion_judgment: {
            results: [
              { index: 0, passed: true, explanation: 'The task is done.' },
            ],
          },
        };
        assert.ok(Object.hasOwn(answers, text.format.name));
        return Response.json({
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify(answers[text.format.name]),
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const purposes: string[] = [];
    const provider: CompletionProvider = {
      ...transport,
      async complete(request, context) {
        assert.equal(Object.hasOwn(request, 'temperature'), false);
        purposes.push(request.purpose);
        const index = bodies.length;
        // Restore just the historical caller value; all other inputs are identical.
        await transport.complete(
          {
            ...request,
            temperature: request.purpose === 'role_player' ? 0.3 : 0,
          },
          context,
        );
        const result = await transport.complete(request, context);
        assert.deepEqual(
          Buffer.from(bodies[index]!, 'utf8'),
          Buffer.from(bodies[index + 1]!, 'utf8'),
        );
        const body = JSON.parse(bodies[index + 1]!);
        assert.equal(body.model, 'gpt-6.1-sol');
        assert.equal(body.max_output_tokens, 16_000);
        assert.equal(Object.hasOwn(body, 'temperature'), false);
        return result;
      },
    };
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      turns: [{ text: 'Done.', sessionId: 'sol-session', toolCalls: [] }],
    });
    const model = { provider: 'openai', model: 'gpt-6.1-sol' };
    const completed = await executeEval({
      runId: 'sol-temperature',
      plan: createTestResolvedRunPlan({
        mode: 'multi_turn',
        judgingCriteria: ['Completes the task.'],
        rolePlayer: model,
        judge: model,
      }),
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([[provider.id, provider]]),
        credentialResolver: createStaticCredentialResolver({
          'openai.completion-api-key': 'synthetic-sol-key',
        }),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createArtifactStore({ root }),
      },
    });
    assert.deepEqual(purposes, ['role_player', 'role_player', 'judge']);
    assert.equal(bodies.length, 6);
    assert.equal(
      (await verifyCompletedRun(completed.location)).result.evaluation.status,
      'passed',
    );
  });

  it('validates and executes the two-turn fixture with agent-produced work', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-multi-e2e-'));
    temporaryDirectories.push(root);
    const fixtureRoot = path.join(
      process.cwd(),
      'test',
      'fixtures',
      'multi-turn',
    );
    const fixture = {
      experimentPath: path.join(fixtureRoot, 'experiment.yaml'),
      casePath: path.join(
        fixtureRoot,
        'dataset',
        'cases',
        'examples',
        'release-summary.case.yaml',
      ),
      resultsRoot: path.join(root, 'results'),
    };
    const deliverable = 'Forge is ready for multi-turn evaluation.\n';
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      id: 'claude-code',
      turns: [
        {
          text: 'What exact status sentence should the release summary contain?',
          sessionId: 'cli-multi-session',
          toolCalls: [],
        },
        {
          text: 'Created release-summary.txt with the status sentence you supplied.',
          sessionId: 'cli-multi-session',
          toolCalls: [],
        },
      ],
    });
    const runtimeAgent: AgentAdapter = {
      ...agent.adapter,
      async openSession(context) {
        const session = await agent.adapter.openSession(context);
        let turn = 0;
        return {
          ...session,
          async send(message, sendOptions) {
            assert.equal(
              (await context.runtime.workspace.inspect('release-summary.txt'))
                .kind,
              'absent',
            );
            if (turn++ === 0) {
              assert.equal(completion.calls.length, 1);
              assert.ok(
                completion.calls[0]!.request.messages.every(
                  ({ role }) => role === 'user',
                ),
              );
              assert.equal(message, context.plan.case.initial_prompt);
            } else {
              assert.ok(message.includes(deliverable.trim()));
              await context.runtime.workspace.writeFile(
                'state.sqlite',
                Buffer.from('SQLite format 3\0private database bytes'),
              );
              await context.runtime.workspace.writeFile(
                'archive',
                gzipSync('private archive bytes'),
              );
              await context.runtime.workspace.writeFile(
                'release-summary.txt',
                Buffer.from(deliverable),
              );
            }
            return session.send(message, sendOptions);
          },
        };
      },
    };
    const completion = createScriptedCompletionProvider({
      id: 'anthropic',
      responses: [
        JSON.stringify({
          user_needs: [
            {
              description: 'Create the requested release summary',
              acceptance: 'The file contains the supplied status sentence.',
              status: 'remaining',
            },
          ],
        }),
        JSON.stringify({
          remaining_need_ids: ['need_1'],
          message: `Use this exact status sentence: ${deliverable.trim()}`,
        }),
        JSON.stringify({ remaining_need_ids: [], message: '' }),
        JSON.stringify({
          results: [
            {
              index: 0,
              passed: true,
              explanation:
                'The conversation supplied the exact status sentence.',
            },
          ],
        }),
      ],
    });
    const compositionFactory = async ({
      datasetRoot,
      resultsRoot,
    }: {
      datasetRoot: string;
      resultsRoot: string;
    }) => ({
      runtime: runtime.adapter,
      agents: new Map([[runtimeAgent.id, runtimeAgent]]),
      completionProviders: new Map([
        [completion.provider.id, completion.provider],
      ]),
      credentialResolver: createStaticCredentialResolver(),
      inputProvider: await createDirectoryRunInputProvider(datasetRoot),
      artifactStore: createArtifactStore({ root: resultsRoot }),
    });

    let validationOutput = '';
    const validationCode = await runCli(
      ['validate', '--experiment', fixture.experimentPath],
      {
        compositionFactory,
        stdout: (text) => {
          validationOutput += text;
        },
      },
    );
    assert.equal(validationCode, 0);
    assert.equal(JSON.parse(validationOutput).valid, true);
    assert.equal(runtime.runs.length, 0);
    assert.equal(completion.calls.length, 0);
    assert.deepEqual(
      completion.requirementCalls.map(({ purpose }) => purpose),
      ['role_player', 'judge'],
    );

    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.casePath,
        '--agent',
        'claude-code',
        '--model',
        'claude-sonnet-4-6',
        '--output',
        fixture.resultsRoot,
        '--run-id',
        'cli-multi-1',
      ],
      {
        compositionFactory,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr.includes('forge:'), false);
    const experimentRun = JSON.parse(stdout) as {
      location: string;
      completed: number;
    };
    assert.equal(experimentRun.completed, 1);
    const summary = await verifyCompletedRun(
      path.join(experimentRun.location, 'runs', 'cli-multi-1'),
    );
    assert.equal(summary.result.evaluation.score, 1);
    assert.equal(summary.result.evaluation.status, 'passed');
    assert.equal(summary.result.evaluation.judging_criteria_passed, 1);
    assert.equal(summary.result.evaluation.checks.length, 3);
    assert.ok(summary.result.evaluation.checks.every(({ passed }) => passed));
    assert.equal(summary.result.stop_reason, 'task_complete');
    const interaction = parseInteractionArtifact(
      JSON.parse(
        await fs.readFile(
          path.join(summary.location, 'interaction.json'),
          'utf8',
        ),
      ),
      { forgeVersion: summary.result.forge.version },
    );
    assert.equal(interaction.turns.length, 2);
    assert.deepEqual(interaction.role_player?.needs, [
      {
        id: 'need_1',
        description: 'Create the requested release summary',
        acceptance: 'The file contains the supplied status sentence.',
      },
    ]);
    assert.equal(interaction.role_player?.decisions[0]?.after_agent_turn, null);
    assert.deepEqual(
      interaction.role_player?.decisions[0]?.remaining_need_ids,
      ['need_1'],
    );
    assert.equal(agent.messages.length, 2);
    const judge = parseJudgeEvidence(
      JSON.parse(
        await fs.readFile(
          path.join(summary.location, 'judge-evidence.json'),
          'utf8',
        ),
      ),
      { forgeVersion: summary.result.forge.version },
    );
    assert.deepEqual(
      judge.transcript.steps
        .filter((step) => step.source === 'agent')
        .map(({ message }) => message),
      [
        'What exact status sentence should the release summary contain?',
        'Created release-summary.txt with the status sentence you supplied.',
      ],
    );
    assert.equal(judge.workspace.complete, false);
    assert.equal(
      judge.workspace.warnings.filter(
        ({ code }) => code === 'workspace_binary_omitted',
      ).length,
      2,
    );
    assert.deepEqual(
      judge.workspace.entries.map(({ path }) => path),
      ['release-summary.txt'],
    );
    const judgeCall = completion.calls.find(
      ({ request }) => request.purpose === 'judge',
    );
    assert.ok(judgeCall);
    assert.doesNotMatch(
      JSON.stringify(judgeCall),
      /private database bytes|private archive bytes|\\u0000/,
    );
    assert.equal(completion.calls.length, 4);
    for (const { request } of completion.calls) {
      assert.equal(Object.hasOwn(request, 'temperature'), false);
    }
    assert.deepEqual(
      summary.result.artifacts.map(({ path: artifactPath }) => artifactPath),
      [
        'plan.json',
        'setup.json',
        'trajectory.json',
        'interaction.json',
        'workspace-evidence.json',
        'judge-evidence.json',
      ],
    );
  });
});
