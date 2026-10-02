import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {runCli} from '../src/cli.js';
import {createDirectoryRunInputProvider} from '../src/contracts/inputs.js';
import {sha256Digest, sha256Hex} from '../src/model/index.js';
import {createArtifactStore, verifyCompletedRun} from '../src/results/index.js';
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
  it('purely validates and then runs Ava plus guideline judging', async () => {
    const fixture = await benchmarkFixture();
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({
      id: 'test-agent',
      turns: [
        {
          text: 'The requested answer is complete.',
          sessionId: 'cli-multi-session',
          toolCalls: [],
        },
      ],
    });
    const completion = createScriptedCompletionProvider({
      id: 'test-provider',
      responses: [
        JSON.stringify({
          user_needs: [{description: 'Complete the answer', status: 'remaining'}],
          message: 'Please complete the answer.',
        }),
        JSON.stringify({remaining_need_ids: [], message: ''}),
        JSON.stringify({
          results: [{index: 0, passed: true, explanation: 'The answer is complete.'}],
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
      agents: new Map([[agent.adapter.id, agent.adapter]]),
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
        'test-agent',
        '--model',
        'test-agent-model',
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
    const campaign = JSON.parse(stdout) as {location: string; completed: number};
    assert.equal(campaign.completed, 1);
    const summary = await verifyCompletedRun(path.join(campaign.location, 'runs', 'cli-multi-1'));
    assert.deepEqual(summary.result.evaluation, {
      schema_version: 1,
      score: 1,
      status: 'passed',
      guidelines_passed: 1,
      guidelines_total: 1,
      guidelines: [
        {
          guideline: 'The answer is complete.',
          passed: true,
          explanation: 'The answer is complete.',
        },
      ],
      checks: [
        {name: 'file_created: answer.txt', passed: true},
        {name: 'file_exists: answer.txt', passed: true},
        {name: 'file_contains: answer.txt /^complete\\n?$/', passed: true},
      ],
    });
    assert.equal(summary.result.stop_reason, 'task_complete');
    const completed = await verifyCompletedRun(summary.location);
    assert.deepEqual(completed.result.artifacts.map(({path: artifactPath}) => artifactPath), [
      'plan.json',
      'setup.json',
      'trajectory.json',
      'interaction.json',
      'workspace-evidence.json',
      'judge-evidence.json',
    ]);
  });
});

async function benchmarkFixture(): Promise<{
  readonly root: string;
  readonly datasetRoot: string;
  readonly experimentPath: string;
  readonly casePath: string;
  readonly resultsRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-multi-e2e-'));
  temporaryDirectories.push(root);
  const datasetRoot = path.join(root, 'dataset');
  const casePath = path.join(datasetRoot, 'cases', 'multi.yaml');
  await fs.mkdir(path.dirname(casePath), {recursive: true});
  const caseBody = `schema_version: 1
id: examples/multi
task: Complete the answer through conversation.
context: A developer checking an answer.
execution_mode: multi_turn
max_turns: 3
setup:
  - uses: forge/write
    with:
      target: answer.txt
      source:
        content: "complete\\n"
success_guidelines:
  - The answer is complete.
checks:
  files_created: [answer.txt]
  file_checks:
    - file: answer.txt
      exists: true
      contains: '^complete\\n?$'
`;
  await fs.writeFile(casePath, caseBody);
  const manifestRaw = `${JSON.stringify({
    schema_version: 1,
    dataset: {id: 'multi-e2e', version: '1.0.0'},
    cases: [{id: 'examples/multi', path: 'cases/multi.yaml'}],
    files: [
      {
        path: 'cases/multi.yaml',
        size: Buffer.byteLength(caseBody),
        sha256: sha256Hex(caseBody),
      },
    ],
  }, null, 2)}\n`;
  await fs.writeFile(path.join(datasetRoot, 'manifest.json'), manifestRaw);

  const experimentPath = path.join(root, 'experiment.yaml');
  await fs.writeFile(
    experimentPath,
    `schema_version: 1
id: examples/multi-experiment
version: 1.0.0
dataset:
  path: ./dataset
  id: multi-e2e
  version: 1.0.0
  manifest_sha256: ${sha256Digest(manifestRaw)}
runtime:
  adapter: docker
  image: {kind: forge}
  platform: linux/amd64
  resources:
    memory_bytes: 4294967296
    cpu_count: 2
    process_count: 512
models:
  role_player: {provider: test-provider, model: role-model}
  judge: {provider: test-provider, model: judge-model}
treatments:
  baseline: {setup: []}
matrix:
  cases: [examples/multi]
  treatments: [baseline]
  agents:
    - adapter: test-agent
      provider: test-agent-provider
      model: test-agent-model
  repetitions: 1
  retries: 0
limits:
  run_timeout_ms: 30000
`,
  );
  return {
    root,
    datasetRoot,
    experimentPath,
    casePath,
    resultsRoot: path.join(root, 'results'),
  };
}
