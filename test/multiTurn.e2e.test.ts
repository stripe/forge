import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {runCli} from '../src/cli.js';
import type {AgentAdapter} from '../src/contracts/agent.js';
import {createDirectoryRunInputProvider} from '../src/contracts/inputs.js';
import {createArtifactStore, parseInteractionArtifact, parseJudgeEvidence, verifyCompletedRun} from '../src/results/index.js';
import {
  createFakeRuntimeAdapter,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../src/testing/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {recursive: true, force: true}),
    ),
  );
});

describe('multi-turn CLI end to end', () => {
  it('validates and executes the shipped two-turn handoff with agent-produced work', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-multi-e2e-'));
    temporaryDirectories.push(root);
    const example = path.join(process.cwd(), 'examples', 'multi-turn');
    const fixture = {
      experimentPath: path.join(example, 'experiment.yaml'),
      casePath: path.join(example, 'dataset', 'cases', 'examples', 'release-summary.yaml'),
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
        return {...session, async send(message, sendOptions) {
          assert.equal((await context.runtime.workspace.inspect('release-summary.txt')).kind, 'absent');
          if (turn++ === 0) {
            assert.equal(message, context.plan.case.initial_prompt);
          } else {
            assert.ok(message.includes(deliverable.trim()));
            await context.runtime.workspace.writeFile('release-summary.txt', Buffer.from(deliverable));
          }
          return session.send(message, sendOptions);
        }};
      },
    };
    const completion = createScriptedCompletionProvider({
      id: 'anthropic',
      responses: [
        JSON.stringify({
          user_needs: [{description: 'Create the requested release summary', status: 'remaining'}],
          message: `Use this exact status sentence: ${deliverable.trim()}`,
        }),
        JSON.stringify({remaining_need_ids: [], message: ''}),
        JSON.stringify({
          results: [{index: 0, passed: true, explanation: 'The conversation supplied the exact status sentence.'}],
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
      artifactStore: createArtifactStore({root: resultsRoot}),
    });

    let validationOutput = '';
    const validationCode = await runCli(
      [
        'validate',
        '--experiment',
        fixture.experimentPath,
      ],
      {
        compositionFactory,
        stdout: (text) => { validationOutput += text; },
      },
    );
    assert.equal(validationCode, 0);
    assert.equal(JSON.parse(validationOutput).valid, true);
    assert.equal(runtime.runs.length, 0);
    assert.equal(completion.calls.length, 0);
    assert.deepEqual(completion.requirementCalls.map(({purpose}) => purpose), [
      'role_player',
      'judge',
    ]);

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
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr.includes('forge:'), false);
    const experimentRun = JSON.parse(stdout) as {location: string; completed: number};
    assert.equal(experimentRun.completed, 1);
    const summary = await verifyCompletedRun(path.join(experimentRun.location, 'runs', 'cli-multi-1'));
    assert.equal(summary.result.evaluation.score, 1);
    assert.equal(summary.result.evaluation.status, 'passed');
    assert.equal(summary.result.evaluation.guidelines_passed, 1);
    assert.equal(summary.result.evaluation.checks.length, 3);
    assert.ok(summary.result.evaluation.checks.every(({passed}) => passed));
    assert.equal(summary.result.stop_reason, 'task_complete');
    const interaction = parseInteractionArtifact(JSON.parse(await fs.readFile(path.join(summary.location, 'interaction.json'), 'utf8')), {forgeVersion: summary.result.forge.version});
    assert.equal(interaction.turns.length, 2);
    assert.equal(agent.messages.length, 2);
    const judge = parseJudgeEvidence(JSON.parse(await fs.readFile(path.join(summary.location, 'judge-evidence.json'), 'utf8')), {forgeVersion: summary.result.forge.version});
    assert.deepEqual(judge.transcript.steps.filter((step) => step.source === 'agent').map(({message}) => message), [
      'What exact status sentence should the release summary contain?',
      'Created release-summary.txt with the status sentence you supplied.',
    ]);
    assert.equal(completion.calls.length, 3);
    assert.deepEqual(summary.result.artifacts.map(({path: artifactPath}) => artifactPath), [
      'plan.json',
      'setup.json',
      'trajectory.json',
      'interaction.json',
      'workspace-evidence.json',
      'judge-evidence.json',
    ]);
  });
});
