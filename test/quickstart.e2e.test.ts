import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {runCli} from '../src/cli.js';
import type {AgentAdapter} from '../src/contracts/agent.js';
import {createDirectoryRunInputProvider} from '../src/contracts/inputs.js';
import {createArtifactStore, verifyCompletedRun} from '../src/results/index.js';
import {
  createFakeRuntimeAdapter,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../src/testing/index.js';

const repositoryRoot = process.cwd();
const exampleRoot = path.join(repositoryRoot, 'examples', 'quickstart');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, {recursive: true, force: true})),
  );
});

describe('checked-in quickstart', () => {
  it('runs through the public CLI and commits verifiable artifacts without Docker', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-quickstart-e2e-'),
    );
    temporaryDirectories.push(temporaryRoot);
    const resultsRoot = path.join(temporaryRoot, 'results');
    const runtime = createFakeRuntimeAdapter({
      id: 'forge/docker',
      metadata: {platform: 'linux/amd64', mode: 'test-double'},
    });
    const scripted = createScriptedAgentAdapter({
      id: 'claude-code',
      turns: [
        {
          text: 'Created hello.txt with the requested contents.',
          sessionId: 'quickstart-session',
          toolCalls: [
            {
              id: 'write-1',
              name: 'Write',
              input: {path: 'hello.txt'},
            },
          ],
        },
      ],
    });
    const agent = agentWhichCreatesHelloFile(scripted.adapter);
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        path.join(exampleRoot, 'experiment.yaml'),
        '--case-file',
        path.join(
          exampleRoot,
          'dataset',
          'cases',
          'examples',
          'hello-file.yaml',
        ),
        '--agent',
        'claude-code',
        '--model',
        'claude-sonnet-4-6',
        '--output',
        resultsRoot,
        '--run-id',
        'quickstart-e2e',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        compositionFactory: async ({datasetRoot, resultsRoot: outputRoot}) => ({
          runtime: runtime.adapter,
          agents: new Map([[agent.id, agent]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: await createDirectoryRunInputProvider(datasetRoot),
          artifactStore: createArtifactStore({root: outputRoot}),
        }),
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!(stderr).includes('forge:'));
    const summary = JSON.parse(stdout) as {location: string; completed: number};
    assert.equal(summary.completed, 1);
    const completed = await verifyCompletedRun(path.join(summary.location, 'runs', 'quickstart-e2e'));
    assert.equal(completed.runId, 'quickstart-e2e');
    {
      const actual = completed.result.evaluation;
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'passed');
    }

    assert.equal(completed.result.runtime.adapter, 'forge/docker');
    assert.equal(Object.hasOwn(completed.result.runtime, 'adapter_version'), false);
    {
      const actual = completed.result.selection;
      assert.ok(actual);
      assert.equal(actual.case_id, 'examples/hello-file');
      assert.equal(actual.treatment, 'baseline');
      assert.equal(actual.agent.adapter, 'claude-code');
      assert.equal(actual.agent.provider, 'anthropic');
      assert.equal(actual.agent.model, 'claude-sonnet-4-6');
    }
    assert.deepEqual(completed.result.artifacts.map(({path: artifactPath}) => artifactPath), [
      'plan.json',
      'setup.json',
      'trajectory.json',
      'interaction.json',
      'workspace-evidence.json',
    ]);

    const workspaceEvidence = JSON.parse(
      await fs.readFile(
        path.join(completed.location, 'workspace-evidence.json'),
        'utf8',
      ),
    ) as {entries: Array<{path: string; content_base64?: string}>};
    const hello = workspaceEvidence.entries.find(({path: filePath}) =>
      filePath === 'hello.txt',
    );
    assert.equal(Buffer.from(hello?.content_base64 ?? '', 'base64').toString('utf8'), 'hello, forge!\n');
    assert.deepEqual(runtime.runs[0]?.events, [
      'prepare',
      'finalizeSetup',
      'quiesce',
      'dispose',
    ]);
  });
});

function agentWhichCreatesHelloFile(delegate: AgentAdapter): AgentAdapter {
  return Object.freeze({
    ...delegate,
    async openSession(context: Parameters<AgentAdapter['openSession']>[0]) {
      const session = await delegate.openSession(context);
      return {
        sessionId: () => session.sessionId(),
        async send(message: string, options: {signal: AbortSignal}) {
          await context.runtime.workspace.writeFile(
            'hello.txt',
            Buffer.from('hello, forge!\n', 'utf8'),
          );
          return session.send(message, options);
        },
      };
    },
  });
}
