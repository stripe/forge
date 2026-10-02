import * as assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {runCli, type RunCliOptions} from '../src/cli.js';
import {defaultForgeEngine} from '../src/engine.js';
import {ForgeExecutionError} from '../src/execution/errors.js';
import {executeEvalWithTestHooks} from '../src/execution/execute.js';
import {parseExperimentConfigYaml} from '../src/model/parse.js';
import {sha256Digest, sha256Hex} from '../src/model/hashes.js';
import type {DatasetManifestV1} from '../src/model/types.js';
import {createArtifactStore, verifyCompletedRun} from '../src/results/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../src/testing/index.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('resumable CLI campaigns', () => {
  it('creates three independent executions and resumes the first by its ID', async () => {
    const fixture = await createFixture();
    const first = await fixture.run([], {execute: async (input) => {
      if (input.plan.selection.repetition === 1) throw new Error('transient execution error');
      return defaultForgeEngine.executeEval(input);
    }});
    const second = await fixture.run();
    const third = await fixture.run();
    assert.deepEqual([first.summary.experiment_run_id, second.summary.experiment_run_id, third.summary.experiment_run_id],
      ['exp-1', 'exp-2', 'exp-3']);
    const laterCheckpoints = await Promise.all(['exp-2', 'exp-3'].map((id) =>
      fs.readFile(path.join(fixture.output, 'experiments', id, 'campaign.json'), 'utf8')));
    const executed: number[] = [];
    const resumed = await fixture.run(['--resume', 'exp-1'], {execute: async (input) => {
      executed.push(input.plan.selection.repetition);
      return defaultForgeEngine.executeEval(input);
    }});
    assert.equal(resumed.code, 0);
    assert.deepEqual(executed, [1]);
    assert.equal(resumed.summary.experiment_run_id, 'exp-1');
    assert.deepEqual(await Promise.all(['exp-2', 'exp-3'].map((id) =>
      fs.readFile(path.join(fixture.output, 'experiments', id, 'campaign.json'), 'utf8'))), laterCheckpoints);
    assert.equal((await fixture.readCheckpoint()).entries[1]!.attempts.at(-1)!.run_id, 'attempt-10');
  });

  it('runs multiple cases and treatments by default and resumes a saved case filter', async () => {
    const fixture = await createFixture({anotherCase: true});
    const config = parseExperimentConfigYaml(await fs.readFile(fixture.experiment, 'utf8'));
    config.treatments.seeded = {setup: [{uses: 'forge/write', with: {target: 'seed.txt', source: {content: 'seed'}}}]};
    config.matrix.treatments.push('seeded');
    config.matrix.repetitions = 1;
    await fs.writeFile(fixture.experiment, JSON.stringify(config));
    const all = await fixture.run();
    assert.equal(all.code, 0);
    assert.equal(all.summary.total, 4);
    const filtered = await fixture.run(['--case', 'examples/other-file']);
    assert.equal(filtered.code, 0);
    assert.equal(filtered.summary.total, 2);
    const resumed = await fixture.run(['--resume', 'exp-2']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.total, 2);
    assert.equal(resumed.summary.skipped, 2);
    assert.equal(resumed.summary.executed, 0);
  });

  it('continues after execution errors and resumes only errored entries with new run IDs', async () => {
    const fixture = await createFixture();
    const executed: number[] = [];
    let fail = true;
    const options: RunCliOptions = {
      execute: async (input) => {
        executed.push(input.plan.selection.repetition);
        if (fail && input.plan.selection.repetition === 1) {
          throw new ForgeExecutionError('agent_failed', 'interaction', 'secret-adapter-detail');
        }
        return defaultForgeEngine.executeEval(input);
      },
    };
    const first = await fixture.run([], options);
    assert.equal(first.code, 1);
    assert.deepEqual(executed, [0, 1, 2]);
    assert.deepEqual(first.summary, {
      experiment_run_id: 'exp-1', location: fixture.root,
      campaign: fixture.checkpoint, total: 3, executed: 3, skipped: 0, completed: 2, errored: 1,
    });
    const before = await fs.readFile(path.join(fixture.root, 'runs', 'attempt-1', 'result.json'));
    const journal = await fixture.readCheckpoint();
    assert.deepEqual(journal.entries[1]!.attempts, [
      {run_id: 'attempt-2', state: 'errored', error_code: 'agent_failed'},
    ]);
    assert.equal((await fs.readFile(fixture.checkpoint, 'utf8')).includes('secret-adapter-detail'), false);
    assert.equal(first.stderr.includes('secret-adapter-detail'), false);

    fail = false;
    executed.length = 0;
    const resumed = await fixture.run(['--resume', 'exp-1'], options);
    assert.equal(resumed.code, 0);
    assert.deepEqual(executed, [1]);
    assert.equal(resumed.summary.skipped, 2);
    assert.equal(resumed.summary.completed, 3);
    assert.deepEqual((await fixture.readCheckpoint()).entries[1]!.attempts, [
      {run_id: 'attempt-2', state: 'errored', error_code: 'agent_failed'},
      {run_id: 'attempt-4', state: 'completed'},
    ]);
    assert.deepEqual(await fs.readFile(path.join(fixture.root, 'runs', 'attempt-1', 'result.json')), before);
    for (const runId of ['attempt-1', 'attempt-3', 'attempt-4']) {
      await verifyCompletedRun(path.join(fixture.root, 'runs', runId));
    }
    const again = await fixture.run(['--resume', 'exp-1'], options);
    assert.equal(again.summary.executed, 0);
    assert.equal(again.summary.skipped, 3);
  });

  it('retains completed failed scores and recovers a commit not yet reflected in the checkpoint', async () => {
    const fixture = await createFixture();
    const first = await fixture.run();
    assert.equal(first.code, 0);
    const run = await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-1'));
    assert.equal(run.result.evaluation.status, 'failed');
    const journal = await fixture.readCheckpoint();
    journal.entries[0]!.attempts[0] = {run_id: 'attempt-1', state: 'running'};
    await fs.writeFile(fixture.checkpoint, JSON.stringify(journal));
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.executed, 0);
    assert.equal(resumed.summary.skipped, 3);
    assert.equal((await fixture.readCheckpoint()).entries[0]!.attempts[0]!.state, 'completed');
  });

  it('resumes interrupted executions and entries never started', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const first = await fixture.run([], {
      signal: controller.signal,
      execute: async (input) => {
        if (input.plan.selection.repetition === 1) {
          controller.abort();
          throw new ForgeExecutionError('aborted', 'interaction', 'stopped');
        }
        return defaultForgeEngine.executeEval(input);
      },
    });
    assert.equal(first.code, 1);
    const journal = await fixture.readCheckpoint();
    assert.equal(journal.entries[2]!.attempts.length, 0);
    // A hard process exit leaves the current attempt in running state.
    journal.entries[1]!.attempts[0] = {run_id: 'attempt-2', state: 'running'};
    await fs.writeFile(fixture.checkpoint, JSON.stringify(journal));
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.executed, 2);
    assert.equal(resumed.summary.skipped, 1);
  });

  it('verifies artifacts before skipping and preserves corrupt attempts', async () => {
    const fixture = await createFixture();
    await fixture.run();
    const trajectory = path.join(fixture.root, 'runs', 'attempt-2', 'trajectory.json');
    await fs.writeFile(trajectory, 'corrupted');
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.executed, 1);
    assert.equal(resumed.summary.skipped, 2);
    assert.equal(await fs.readFile(trajectory, 'utf8'), 'corrupted');
    await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-4'));
  });

  it('refuses changed plans and selector sets before executing', async () => {
    const fixture = await createFixture();
    await fixture.run();
    let calls = 0;
    const execute: RunCliOptions['execute'] = async () => {
      calls += 1;
      throw new Error('must not execute');
    };
    const filtered = await fixture.run(['--resume', 'exp-1', '--repetition', '1'], {execute});
    assert.equal(filtered.code, 2);
    assert.match(filtered.stderr, /saved selections/);
    const config = parseExperimentConfigYaml(await fs.readFile(fixture.experiment, 'utf8'));
    config.limits.run_timeout_ms += 1;
    await fs.writeFile(fixture.experiment, JSON.stringify(config));
    const changed = await fixture.run(['--resume', 'exp-1'], {execute});
    assert.equal(changed.code, 1);
    assert.match(changed.stderr, /resolved plans differ/);
    assert.equal(calls, 0);
  });

  it('requires explicit resume and a valid existing checkpoint', async () => {
    const fixture = await createFixture();
    const missing = await fixture.run(['--resume', 'missing-execution']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No experiment execution/);
    await fixture.run();
    const nextExecution = await fixture.run();
    assert.equal(nextExecution.code, 0);
    assert.equal(nextExecution.summary.experiment_run_id, 'exp-2');
    const journal = await fixture.readCheckpoint();
    await fs.writeFile(fixture.checkpoint, JSON.stringify({...journal, unknown: true}));
    const invalid = await fixture.run(['--resume', 'exp-1']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /valid schema-version-1/);
  });

  it('rejects invalid flag combinations and filters the initial campaign', async () => {
    const fixture = await createFixture();
    const single = await fixture.run(['--repetition', '1']);
    assert.equal(single.code, 0);
    assert.equal(single.summary.total, 1);
    assert.equal((await fixture.readCheckpoint()).entries[0]!.selection.repetition, 1);
    for (const argv of [
      ['run', '--resume'],
      ['run', '--experiment', fixture.experiment, '--resume'],
      ['run', '--resume', '../other'],
      ['plan', '--all'],
      ['run', '--dataset', 'dataset'],
      ['run', '--all'],
    ]) {
      assert.equal(await runCli(argv, {stderr: () => undefined}), 2);
    }
  });

  it('preflights every plan before executing or creating a checkpoint', async () => {
    const fixture = await createFixture();
    const engine = {
      ...defaultForgeEngine,
      preflightEval(input: Parameters<typeof defaultForgeEngine.preflightEval>[0]) {
        if (input.plan.selection.repetition === 2) throw new Error('unsupported final selection');
        defaultForgeEngine.preflightEval(input);
      },
    };
    let calls = 0;
    const outcome = await fixture.run([], {engine, execute: async () => {
      calls += 1;
      throw new Error('must not execute');
    }});
    assert.equal(outcome.code, 1);
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(fixture.checkpoint), {code: 'ENOENT'});
  });

  it('prevents simultaneous writers to the same campaign', async () => {
    const fixture = await createFixture();
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {started = resolve;});
    const gate = new Promise<void>((resolve) => {finish = resolve;});
    const first = fixture.run([], {execute: async (input) => {
      started();
      await gate;
      return defaultForgeEngine.executeEval(input);
    }});
    await ready;
    try {
      const second = await fixture.run(['--resume', 'exp-1']);
      assert.equal(second.code, 1);
      assert.match(second.stderr, /Another campaign process/);
    } finally {
      finish();
    }
    assert.equal((await first).code, 0);
    assert.equal((await fixture.run(['--resume', 'exp-1'])).summary.executed, 0);
  });

  it('reclaims a local process lock after its owner exits', async () => {
    const fixture = await createFixture();
    await fixture.run();
    const owner = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
    assert.equal(owner.status, 0);
    const lock = path.join(fixture.root, '.campaign.lock');
    await fs.writeFile(lock, JSON.stringify({pid: Number(owner.stdout)}));
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.skipped, 3);
    await assert.rejects(fs.stat(lock), {code: 'ENOENT'});
  });

  it('retries committed role-player errors while retaining their valid artifacts', async () => {
    const fixture = await createFixture();
    const dataset = path.join(path.dirname(fixture.experiment), 'dataset');
    const relative = 'cases/examples/hello-file.yaml';
    const body = (await fs.readFile(path.join(dataset, relative), 'utf8'))
      .replace('execution_mode: one_shot', 'execution_mode: multi_turn\ntask: Complete the task');
    await fs.writeFile(path.join(dataset, relative), body);
    const manifest = JSON.parse(await fs.readFile(path.join(dataset, 'manifest.json'), 'utf8')) as DatasetManifestV1;
    const file = manifest.files.find((entry) => entry.path === relative)!;
    file.size = Buffer.byteLength(body);
    file.sha256 = sha256Hex(body);
    const raw = `${JSON.stringify(manifest)}\n`;
    await fs.writeFile(path.join(dataset, 'manifest.json'), raw);
    const config = parseExperimentConfigYaml(await fs.readFile(fixture.experiment, 'utf8'));
    config.dataset.manifest_sha256 = sha256Digest(raw);
    config.matrix.repetitions = 1;
    config.models.role_player = {provider: 'scripted', model: 'test-role-player'};
    await fs.writeFile(fixture.experiment, JSON.stringify(config));
    const options: RunCliOptions = {
      compositionFactory: async ({resultsRoot}) => {
        const runtime = createFakeRuntimeAdapter();
        const agent = createScriptedAgentAdapter({id: 'claude-code'});
        const completion = createScriptedCompletionProvider({
          id: 'scripted', responses: [new Error('unavailable'), new Error('unavailable'), new Error('unavailable')],
        });
        return {
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          completionProviders: new Map([[completion.provider.id, completion.provider]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({root: resultsRoot}),
        };
      },
      execute: (input) => executeEvalWithTestHooks(input, {waitBeforeCompletionRetry: async () => undefined}),
    };
    const first = await fixture.run([], options);
    assert.equal(first.code, 1);
    const completed = await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-1'));
    assert.equal(completed.result.stop_reason, 'role_player_error');
    assert.deepEqual((await fixture.readCheckpoint()).entries[0]!.attempts, [
      {run_id: 'attempt-1', state: 'errored', error_code: 'role_player_error'},
    ]);
    const resumed = await fixture.run(['--resume', 'exp-1'], options);
    assert.equal(resumed.code, 1);
    assert.equal(resumed.summary.executed, 1);
    assert.equal(resumed.summary.skipped, 0);
    await verifyCompletedRun(completed.location);
    await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-2'));
  });
});

interface Checkpoint {
  schema_version: number;
  entries: Array<{
    selection: {repetition: number};
    plan_sha256: string;
    attempts: Array<{run_id: string; state: string; error_code?: string}>;
  }>;
}

async function createFixture(options: {anotherCase?: boolean} = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-campaign-'));
  temporaryDirectories.push(temporary);
  const output = path.join(temporary, 'results');
  const root = path.join(output, 'experiments', 'exp-1');
  const example = path.resolve('examples/quickstart');
  const experiment = path.join(temporary, 'experiment.yaml');
  const config = parseExperimentConfigYaml(await fs.readFile(path.join(example, 'experiment.yaml'), 'utf8'));
  config.matrix.repetitions = 3;
  const dataset = path.join(temporary, 'dataset');
  await fs.cp(path.join(example, 'dataset'), dataset, {recursive: true});
  config.dataset.path = './dataset';
  if (options.anotherCase) {
    const body = (await fs.readFile(path.join(dataset, 'cases/examples/hello-file.yaml'), 'utf8'))
      .replace('id: examples/hello-file', 'id: examples/other-file');
    const relative = 'cases/examples/other-file.yaml';
    await fs.writeFile(path.join(dataset, relative), body);
    const manifest = JSON.parse(await fs.readFile(path.join(dataset, 'manifest.json'), 'utf8')) as DatasetManifestV1;
    manifest.cases.push({id: 'examples/other-file', path: relative});
    manifest.files.push({path: relative, size: Buffer.byteLength(body), sha256: sha256Hex(body)});
    const raw = `${JSON.stringify(manifest)}\n`;
    await fs.writeFile(path.join(dataset, 'manifest.json'), raw);
    config.dataset.manifest_sha256 = sha256Digest(raw);
    config.matrix.cases.push('examples/other-file');
  }
  await fs.writeFile(experiment, JSON.stringify(config));
  const checkpoint = path.join(root, 'campaign.json');
  let nextId = 0;
  let nextExecutionId = 0;
  return {
    root, output, experiment, checkpoint,
    readCheckpoint: async (): Promise<Checkpoint> => JSON.parse(await fs.readFile(checkpoint, 'utf8')),
    async run(extra: string[] = [], options: RunCliOptions = {}) {
      let stdout = '';
      let stderr = '';
      const runtime = createFakeRuntimeAdapter();
      const agent = createScriptedAgentAdapter({
        id: 'claude-code',
        turns: Array.from({length: 6}, () => ({text: 'Done', sessionId: 'campaign-session', toolCalls: []})),
      });
      const code = await runCli([
        'run', '--experiment', experiment, '--output', output, ...extra,
      ], {
        runIdFactory: () => `attempt-${++nextId}`,
        experimentRunIdFactory: () => `exp-${++nextExecutionId}`,
        stdout: (value) => {stdout += value;},
        stderr: (value) => {stderr += value;},
        compositionFactory: async ({resultsRoot}) => ({
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({root: resultsRoot}),
        }),
        ...options,
      });
      return {code, stderr, summary: stdout ? JSON.parse(stdout) as Record<string, unknown> : {}};
    },
  };
}
