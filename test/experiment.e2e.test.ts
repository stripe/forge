import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsPromises, * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';

import { type RunCliOptions, runCli } from '../src/cli.ts';
import { credentialReference } from '../src/contracts/credentials.ts';
import { defaultForgeEngine } from '../src/engine.ts';
import { ForgeExecutionError } from '../src/execution/errors.ts';
import { executeEvalWithTestHooks } from '../src/execution/execute.ts';
import { parseExperimentRunReport } from '../src/experiment.ts';
import { parseExperimentRunEvent } from '../src/experimentEvents.ts';
import { sha256Digest } from '../src/model/hashes.ts';
import { parseExperimentConfigYaml } from '../src/model/parse.ts';
import type { DatasetManifestV1, RunSelection } from '../src/model/types.ts';
import { regradeExperimentRun } from '../src/regrade/experiment.ts';
import {
  createArtifactStore,
  verifyCompletedRun,
} from '../src/results/index.ts';
import { serializeCanonicalJson } from '../src/serialization.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../src/testing/index.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('resumable CLI experiment runs', () => {
  it('appends timestamped progress across execution and resume while artifacts verify and regrade', async () => {
    const fixture = await createFixture();
    const first = await fixture.run(['--jobs', '2']);
    assert.equal(first.code, 0);
    const file = path.join(fixture.root, 'events.jsonl');
    const before = await fs.readFile(file, 'utf8');
    const initial = before
      .trimEnd()
      .split('\n')
      .map((line) => {
        const event = parseExperimentRunEvent(JSON.parse(line));
        assert.equal(serializeCanonicalJson(event), `${line}\n`);
        assert.equal(
          new Date(event.observed_at).toISOString(),
          event.observed_at,
        );
        const { observed_at: _, ...payload } = event;
        return payload;
      });
    assert.deepEqual(
      initial,
      first.stderr
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    assert.equal(initial.length, 7);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    const after = await fs.readFile(file, 'utf8');
    assert.ok(after.startsWith(before));
    const appended = after
      .slice(before.length)
      .trimEnd()
      .split('\n')
      .map((line) => parseExperimentRunEvent(JSON.parse(line)));
    assert.deepEqual(
      appended.map((event) => event.state),
      ['skipped', 'skipped', 'skipped', 'resumed'],
    );
    for (const event of appended)
      assert.equal(
        new Date(event.observed_at).toISOString(),
        event.observed_at,
      );
    assert.equal(
      JSON.parse(resumed.stderr.trimEnd().split('\n').at(-1)!).state,
      'resuming',
    );
    for (const entry of (await fixture.readCheckpoint()).entries) {
      await verifyCompletedRun(
        path.join(fixture.root, 'runs', entry.attempts[0]!.run_id),
      );
    }
    const regrade = await regradeExperimentRun(
      {
        experimentRun: fixture.root,
        output: path.join(fixture.output, 'regrade'),
        judge: { provider: 'scripted', model: 'judge' },
      },
      {
        completionProviders: new Map(),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.deepEqual(regrade.failed, []);
    assert.equal(regrade.not_judged, 3);
    assert.equal(
      (await readReport(path.join(fixture.output, 'regrade'))).summary
        .completed,
      3,
    );
    assert.equal(await fs.readFile(file, 'utf8'), after);
  });

  it('resumes an old folder without a log and keeps evaluating if log writes fail', async () => {
    const fixture = await createFixture({ repetitions: 1 });
    assert.equal(
      (
        await fixture.run([], {
          execute: async () => {
            throw new Error('interrupted');
          },
        })
      ).code,
      1,
    );
    const file = path.join(fixture.root, 'events.jsonl');
    await fs.unlink(file);
    const resumed = await fixture.run(['--resume', 'exp-1'], {
      execute: async () => {
        throw new Error('interrupted again');
      },
    });
    assert.equal(resumed.code, 1);
    assert.equal(
      parseExperimentRunEvent(
        JSON.parse((await fs.readFile(file, 'utf8')).split('\n')[0]!),
      ).state,
      'resumed',
    );
    await fs.unlink(file);
    await fs.mkdir(file);
    const completed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(completed.code, 0);
    assert.equal(completed.summary.completed, 1);
    assert.deepEqual(completed.summary.progress_log, {
      state: 'unavailable',
      reason: 'io_error',
      affected_events: 3,
    });
    await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-3'));
  });

  it('finishes evals and releases the lock when event-log I/O never settles', async () => {
    const fixture = await createFixture({ repetitions: 1 });
    const originalOpen = fsPromises.open;
    const callbacks: string[] = [];
    vi.spyOn(fsPromises, 'open').mockImplementation(
      (...args: Parameters<typeof originalOpen>) =>
        path.basename(String(args[0])) === 'events.jsonl'
          ? new Promise(() => {})
          : originalOpen(...args),
    );
    syncBuiltinESMExports();
    try {
      const result = await waitFor(
        fixture.run([], {
          stderr: (body) => {
            callbacks.push(JSON.parse(body).state);
          },
          execute: async (input) => {
            assert.deepEqual(callbacks, ['started', 'running']);
            return defaultForgeEngine.executeEval(input);
          },
        }),
      );
      assert.equal(result.code, 0);
      assert.deepEqual(callbacks, ['started', 'running', 'completed']);
      assert.deepEqual(result.summary.progress_log, {
        state: 'unavailable',
        reason: 'io_timeout',
        affected_events: 3,
      });
      await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-1'));
      await assert.rejects(
        fs.stat(path.join(fixture.root, '.experiment.lock')),
        { code: 'ENOENT' },
      );
      const resumed = await waitFor(fixture.run(['--resume', 'exp-1']));
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.skipped, 1);
      assert.deepEqual(resumed.summary.progress_log, {
        state: 'unavailable',
        reason: 'io_timeout',
        affected_events: 2,
      });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('records the execution boundary redaction in progress diagnostics', async () => {
    const fixture = await createFixture({ repetitions: 1 });
    const secret = 'synthetic-agent-key';
    const result = await fixture.run([], {
      compositionFactory: async ({ resultsRoot }) => {
        const runtime = createFakeRuntimeAdapter();
        const agent = createScriptedAgentAdapter({
          id: 'claude-code',
          requirements: {
            executables: [],
            stateDirectories: [],
            environment: {
              credentials: {
                API_KEY: { reference: credentialReference('test.agent') },
              },
            },
          },
        });
        return {
          runtime: runtime.adapter,
          agents: new Map([
            [
              agent.adapter.id,
              {
                ...agent.adapter,
                async openSession() {
                  throw new Error(`Unable to use ${secret}`);
                },
              },
            ],
          ]),
          credentialResolver: createStaticCredentialResolver({
            'test.agent': secret,
          }),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root: resultsRoot }),
        };
      },
    });
    assert.equal(result.code, 1);
    const body = await fs.readFile(
      path.join(fixture.root, 'events.jsonl'),
      'utf8',
    );
    assert.equal(body.includes(secret), false);
    const event = parseExperimentRunEvent(
      JSON.parse(body.trimEnd().split('\n').at(-1)!),
    );
    assert.equal(event.state, 'errored');
    if (event.state === 'errored')
      assert.equal(event.diagnostic?.message, 'Unable to use [REDACTED]');
  });

  it('defaults to one active execution at a time', async () => {
    const fixture = await createFixture();
    const started = Array.from({ length: 3 }, createGate);
    const finish = Array.from({ length: 3 }, createGate);
    const calls: number[] = [];
    const running = fixture.run([], {
      execute: async (input) => {
        const index = input.plan.selection.repetition;
        calls.push(index);
        started[index]!.resolve();
        await finish[index]!.promise;
        return defaultForgeEngine.executeEval(input);
      },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        await waitFor(started[index]!.promise);
        assert.deepEqual(
          calls,
          Array.from({ length: index + 1 }, (_, i) => i),
        );
        const checkpoint = await fixture.readCheckpoint();
        assert.equal(
          checkpoint.entries[index]!.attempts.at(-1)!.state,
          'running',
        );
        assert.equal(checkpoint.entries[index + 1]?.attempts.length ?? 0, 0);
        finish[index]!.resolve();
      }
      assert.equal((await waitFor(running)).code, 0);
    } finally {
      for (const gate of finish) gate.resolve();
      await running;
    }
  });

  it('bounds concurrency, refills free slots, and checkpoints out-of-order completions', async () => {
    const fixture = await createFixture({ repetitions: 5 });
    const started = Array.from({ length: 5 }, createGate);
    const finish = Array.from({ length: 5 }, createGate);
    const completed = Array.from({ length: 5 }, createGate);
    const completionOrder: number[] = [];
    let active = 0;
    let maximum = 0;
    const running = fixture.run(['--jobs', '2'], {
      stderr: (text) => {
        const event = JSON.parse(text);
        if (event.state === 'completed') {
          completionOrder.push(event.selection.repetition);
          completed[event.selection.repetition]!.resolve();
        }
      },
      execute: async (input) => {
        const index = input.plan.selection.repetition;
        maximum = Math.max(maximum, ++active);
        started[index]!.resolve();
        try {
          await finish[index]!.promise;
          return await defaultForgeEngine.executeEval(input);
        } finally {
          active -= 1;
        }
      },
    });
    try {
      await waitFor(Promise.all([started[0]!.promise, started[1]!.promise]));
      assert.equal(active, 2);
      for (let index = 1; index < 4; index += 1) {
        finish[index]!.resolve();
        await waitFor(started[index + 1]!.promise);
        const checkpoint = await fixture.readCheckpoint();
        assert.equal(checkpoint.entries[0]!.attempts.at(-1)!.state, 'running');
        assert.equal(
          checkpoint.entries[index]!.attempts.at(-1)!.state,
          'completed',
        );
        assert.equal(
          checkpoint.entries[index + 1]!.attempts.at(-1)!.state,
          'running',
        );
        assert.equal(active, 2);
      }
      finish[4]!.resolve();
      await waitFor(completed[4]!.promise);
      finish[0]!.resolve();
      const result = await waitFor(running);
      assert.equal(result.code, 0);
      assert.equal(result.summary.completed, 5);
      assert.equal(maximum, 2);
      assert.deepEqual(completionOrder, [1, 2, 3, 4, 0]);
      const checkpoint = await fixture.readCheckpoint();
      for (const entry of checkpoint.entries) {
        assert.equal(entry.attempts.length, 1);
        assert.equal(entry.attempts[0]!.state, 'completed');
        await verifyCompletedRun(
          path.join(fixture.root, 'runs', entry.attempts[0]!.run_id),
        );
      }
    } finally {
      for (const gate of finish) gate.resolve();
      await running;
    }
  });

  it('caps the workers at pending entries even when jobs is larger', async () => {
    const fixture = await createFixture();
    let calls = 0;
    const result = await fixture.run(['-j', '100'], {
      execute: async (input) => {
        calls += 1;
        return defaultForgeEngine.executeEval(input);
      },
    });
    assert.equal(result.code, 0);
    assert.equal(calls, 3);
    assert.equal(result.summary.completed, 3);
  });

  it('rejects invalid jobs and jobs on non-run commands before loading inputs', async () => {
    const fixture = await createFixture();
    let loads = 0;
    const engine = {
      ...defaultForgeEngine,
      async loadExperimentConfig() {
        loads += 1;
        throw new Error('must not load');
      },
    };
    for (const value of [
      '',
      '0',
      '-1',
      '1.5',
      'NaN',
      'Infinity',
      '1e2',
      '01',
      ' 2',
      '9007199254740992',
    ]) {
      const result = await fixture.run([`--jobs=${value}`], { engine });
      assert.equal(result.code, 2, value);
      assert.match(result.stderr, /--jobs must be a positive safe integer/);
    }
    for (const command of ['plan', 'validate']) {
      assert.equal(
        await runCli([command, '--jobs', '2'], {
          engine,
          stderr: () => undefined,
        }),
        2,
      );
    }
    assert.equal(
      await runCli(['run', '--jobs'], { engine, stderr: () => undefined }),
      2,
    );
    assert.equal(loads, 0);
    await assert.rejects(fs.stat(fixture.output), { code: 'ENOENT' });
  });

  it('cancels active workers, waits for cleanup under the lock, and resumes unfinished entries', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const started = [createGate(), createGate()];
    const aborted = [createGate(), createGate()];
    const cleanup = createGate();
    const calls: number[] = [];
    let cleaned = 0;
    const running = fixture.run(['--jobs', '2'], {
      signal: controller.signal,
      execute: async (input) => {
        const index = input.plan.selection.repetition;
        calls.push(index);
        started[index]!.resolve();
        try {
          await new Promise<void>((resolve) => {
            if (input.signal!.aborted) resolve();
            else
              input.signal!.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          aborted[index]!.resolve();
          throw new ForgeExecutionError('aborted', 'interaction', 'stopped');
        } finally {
          await cleanup.promise;
          cleaned += 1;
        }
      },
    });
    try {
      await waitFor(Promise.all(started.map((gate) => gate.promise)));
      controller.abort();
      await waitFor(Promise.all(aborted.map((gate) => gate.promise)));
      const contender = await fixture.run(['--resume', 'exp-1', '--jobs', '3']);
      assert.equal(contender.code, 1);
      assert.match(contender.stderr, /Another experiment run process/);
      assert.equal(cleaned, 0);
      assert.deepEqual(calls, [0, 1]);
      cleanup.resolve();
      assert.equal((await waitFor(running)).code, 1);
      assert.equal(cleaned, 2);
      const checkpoint = await fixture.readCheckpoint();
      assert.equal(checkpoint.entries[2]!.attempts.length, 0);
      assert.deepEqual(
        checkpoint.entries
          .slice(0, 2)
          .map((entry) => entry.attempts.at(-1)!.error_code),
        ['aborted', 'aborted'],
      );
      const cancelled = await readReport(fixture.root);
      assert.deepEqual(
        cancelled.runs.map((run) => run.state),
        ['errored', 'errored', 'pending'],
      );
      assert.equal(cancelled.summary.pass_rate, null);
      const resumed = await fixture.run(['--resume', 'exp-1', '--jobs', '3']);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.executed, 3);
      assert.deepEqual(
        (await fixture.readCheckpoint()).entries.map(
          (entry) => entry.attempts.length,
        ),
        [2, 2, 1],
      );
    } finally {
      controller.abort();
      cleanup.resolve();
      await running;
    }
  });

  it('aborts and drains active workers after a duplicate run ID stops the coordinator', async () => {
    const fixture = await createFixture();
    const started = createGate();
    const aborted = createGate();
    const cleanup = createGate();
    let cleaned = false;
    let calls = 0;
    const running = fixture.run(['--jobs', '2'], {
      runIdFactory: () => 'duplicate',
      execute: async (input) => {
        calls += 1;
        started.resolve();
        try {
          await new Promise<void>((resolve) => {
            if (input.signal!.aborted) resolve();
            else
              input.signal!.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          aborted.resolve();
          throw new ForgeExecutionError('aborted', 'interaction', 'stopped');
        } finally {
          await cleanup.promise;
          cleaned = true;
        }
      },
    });
    try {
      await waitFor(started.promise);
      await waitFor(aborted.promise);
      const contender = await fixture.run(['--resume', 'exp-1']);
      assert.match(contender.stderr, /Another experiment run process/);
      assert.equal(cleaned, false);
      cleanup.resolve();
      const result = await waitFor(running);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Eval run ID already exists/);
      assert.equal(calls, 1);
      assert.equal(cleaned, true);
      assert.deepEqual(
        (await fixture.readCheckpoint()).entries.map(
          (entry) => entry.attempts.length,
        ),
        [1, 0, 0],
      );
      const resumed = await fixture.run(['--resume', 'exp-1', '--jobs', '2']);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.completed, 3);
    } finally {
      cleanup.resolve();
      await running;
    }
  });

  it('stops scheduling on checkpoint failure and recovers a sibling committed before cancellation', async () => {
    const fixture = await createFixture();
    const started = [createGate(), createGate()];
    const commit = createGate();
    const aborted = createGate();
    const cleanup = createGate();
    let failWrites = false;
    const originalRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof originalRename>) => {
        if (args[1] === fixture.checkpoint && failWrites)
          throw new Error('checkpoint disk failure');
        return originalRename(...args);
      },
    );
    syncBuiltinESMExports();
    const running = fixture.run(['--jobs', '2'], {
      execute: async (input) => {
        const index = input.plan.selection.repetition;
        started[index]!.resolve();
        if (index === 1) {
          await commit.promise;
          return defaultForgeEngine.executeEval(input);
        }
        try {
          await new Promise<void>((resolve) => {
            if (input.signal!.aborted) resolve();
            else
              input.signal!.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          aborted.resolve();
          throw new ForgeExecutionError('aborted', 'interaction', 'stopped');
        } finally {
          await cleanup.promise;
        }
      },
    });
    try {
      await waitFor(Promise.all(started.map((gate) => gate.promise)));
      failWrites = true;
      commit.resolve();
      await waitFor(aborted.promise);
      const contender = await fixture.run(['--resume', 'exp-1']);
      assert.match(contender.stderr, /Another experiment run process/);
      cleanup.resolve();
      const failed = await waitFor(running);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /checkpoint disk failure/);
      assert.deepEqual(
        (await fixture.readCheckpoint()).entries.map(
          (entry) => entry.attempts.length,
        ),
        [1, 1, 0],
      );
      await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-2'));
      const interrupted = await readReport(fixture.root);
      assert.deepEqual(
        interrupted.runs.map((run) => run.state),
        ['errored', 'completed', 'pending'],
      );
      assert.equal(
        interrupted.checkpoint_sha256,
        sha256Digest(await fs.readFile(fixture.checkpoint)),
      );
      failWrites = false;
      const resumed = await fixture.run(['--resume', 'exp-1', '--jobs', '2']);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.executed, 2);
      assert.equal(resumed.summary.skipped, 1);
      assert.deepEqual(
        (await fixture.readCheckpoint()).entries.map(
          (entry) => entry.attempts.length,
        ),
        [2, 1, 1],
      );
    } finally {
      failWrites = false;
      commit.resolve();
      cleanup.resolve();
      await running;
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('creates three independent executions and resumes the first by its ID', async () => {
    const fixture = await createFixture();
    const first = await fixture.run([], {
      execute: async (input) => {
        if (input.plan.selection.repetition === 1)
          throw new Error('transient execution error');
        return defaultForgeEngine.executeEval(input);
      },
    });
    const second = await fixture.run();
    const third = await fixture.run();
    assert.deepEqual(
      [
        first.summary.experiment_run_id,
        second.summary.experiment_run_id,
        third.summary.experiment_run_id,
      ],
      ['exp-1', 'exp-2', 'exp-3'],
    );
    const laterCheckpoints = await Promise.all(
      ['exp-2', 'exp-3'].map((id) =>
        fs.readFile(
          path.join(fixture.output, 'experiments', id, 'experiment.json'),
          'utf8',
        ),
      ),
    );
    const executed: number[] = [];
    const resumed = await fixture.run(['--resume', 'exp-1'], {
      execute: async (input) => {
        executed.push(input.plan.selection.repetition);
        return defaultForgeEngine.executeEval(input);
      },
    });
    assert.equal(resumed.code, 0);
    assert.deepEqual(executed, [1]);
    assert.equal(resumed.summary.experiment_run_id, 'exp-1');
    assert.deepEqual(
      await Promise.all(
        ['exp-2', 'exp-3'].map((id) =>
          fs.readFile(
            path.join(fixture.output, 'experiments', id, 'experiment.json'),
            'utf8',
          ),
        ),
      ),
      laterCheckpoints,
    );
    assert.equal(
      (await fixture.readCheckpoint()).entries[1]!.attempts.at(-1)!.run_id,
      'attempt-10',
    );
  });

  it('runs multiple cases and treatments by default and resumes a saved case filter', async () => {
    const fixture = await createFixture({ anotherCase: true });
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experiment, 'utf8'),
    );
    assert.ok(config.matrix.groups === undefined);
    config.treatments.seeded = {
      setup: [
        {
          uses: 'forge/write',
          with: { target: 'seed.txt', source: { content: 'seed' } },
        },
      ],
    };
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

  it('runs and reports only the three authored grouped combinations and skips them on resume', async () => {
    const fixture = await createGroupedFixture();
    const expected: RunSelection[] = [
      {
        case_id: 'examples/hello-file',
        treatment: 'baseline',
        agent: {
          adapter: 'claude-code',
          provider: 'anthropic',
          model: 'group-a-model',
        },
        repetition: 0,
      },
      {
        case_id: 'examples/other-file',
        treatment: 'baseline',
        agent: {
          adapter: 'claude-code',
          provider: 'anthropic',
          model: 'group-b-model',
        },
        repetition: 0,
      },
      {
        case_id: 'examples/other-file',
        treatment: 'seeded',
        agent: {
          adapter: 'claude-code',
          provider: 'anthropic',
          model: 'group-b-model',
        },
        repetition: 0,
      },
    ];
    const first = await fixture.run();
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.summary.total, 3);
    assert.equal(first.summary.executed, 3);
    assert.equal(first.summary.completed, 3);
    assert.equal(first.summary.errored, 0);
    const checkpoint = await fs.readFile(fixture.checkpoint);
    const entries = (await fixture.readCheckpoint()).entries;
    assert.deepEqual(
      entries.map(({ selection }) => selection),
      expected,
    );
    assert.deepEqual(
      entries.map(({ attempts }) => attempts.length),
      [1, 1, 1],
    );
    const report = await readReport(fixture.root);
    assert.deepEqual(
      report.runs.map(({ selection }) => selection),
      expected,
    );
    assert.deepEqual(
      report.runs.map(({ selection_index }) => selection_index),
      [0, 1, 2],
    );
    assert.deepEqual(
      report.runs.map(({ state }) => state),
      ['completed', 'completed', 'completed'],
    );
    assert.equal(report.summary.selections, 3);
    assert.equal(report.summary.completed, 3);
    assert.equal(report.summary.pending, 0);
    assert.equal(report.summary.coverage, 1);
    assert.equal(report.summary.passed, 3);
    assert.equal(report.summary.attempts_total, 3);
    assert.equal(report.summary.retry_attempts, 0);
    assert.equal(report.checkpoint_sha256, sha256Digest(checkpoint));
    assert.deepEqual(
      report.cases.map(({ case_id, treatment, agent }) => ({
        case_id,
        treatment,
        agent,
      })),
      expected.map(({ case_id, treatment, agent }) => ({
        case_id,
        treatment,
        agent,
      })),
    );
    for (const row of report.cases) {
      assert.equal(row.selections, 1);
      assert.equal(row.completed, 1);
      assert.equal(row.pending, 0);
      assert.equal(row.coverage, 1);
    }
    const results = await Promise.all(
      entries.map(async (entry) => {
        const run = await verifyCompletedRun(
          path.join(fixture.root, 'runs', entry.attempts[0]!.run_id),
        );
        assert.deepEqual(run.result.selection, entry.selection);
        return fs.readFile(path.join(run.location, 'result.json'));
      }),
    );

    const resumed = await fixture.run(['--resume', 'exp-1'], {
      execute: async () => {
        throw new Error('completed grouped selections must be skipped');
      },
    });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.summary.total, 3);
    assert.equal(resumed.summary.executed, 0);
    assert.equal(resumed.summary.skipped, 3);
    assert.deepEqual(await fs.readFile(fixture.checkpoint), checkpoint);
    const refreshed = await readReport(fixture.root);
    assert.deepEqual(refreshed.runs, report.runs);
    assert.deepEqual(refreshed.cases, report.cases);
    assert.deepEqual(refreshed.summary, report.summary);
    assert.deepEqual(
      await Promise.all(
        entries.map((entry) =>
          fs.readFile(
            path.join(
              fixture.root,
              'runs',
              entry.attempts[0]!.run_id,
              'result.json',
            ),
          ),
        ),
      ),
      results,
    );
  });

  it('filters grouped selections and resumes the original group subset', async () => {
    const fixture = await createGroupedFixture();
    const filtered = await fixture.run(['--case', 'examples/other-file']);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.equal(filtered.summary.total, 2);
    const report = await readReport(fixture.root);
    assert.deepEqual(
      report.runs.map(({ selection }) => [
        selection.case_id,
        selection.treatment,
        selection.agent.model,
      ]),
      [
        ['examples/other-file', 'baseline', 'group-b-model'],
        ['examples/other-file', 'seeded', 'group-b-model'],
      ],
    );
    const resumed = await fixture.run(['--resume', 'exp-1'], {
      execute: async () => {
        throw new Error('the filtered selections must be skipped');
      },
    });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.summary.total, 2);
    assert.equal(resumed.summary.executed, 0);
    assert.equal(resumed.summary.skipped, 2);
    assert.deepEqual((await readReport(fixture.root)).runs, report.runs);

    const baseline = await fixture.run(['--treatment', 'baseline']);
    assert.equal(baseline.code, 0, baseline.stderr);
    assert.equal(baseline.summary.total, 2);
    const baselineReport = await readReport(
      path.join(fixture.output, 'experiments', 'exp-2'),
    );
    assert.deepEqual(
      baselineReport.runs.map(({ selection }) => [
        selection.case_id,
        selection.treatment,
        selection.agent.model,
      ]),
      [
        ['examples/hello-file', 'baseline', 'group-a-model'],
        ['examples/other-file', 'baseline', 'group-b-model'],
      ],
    );
  });

  it('rejects saved selections removed from a group before creating execution capabilities', async () => {
    const fixture = await createGroupedFixture();
    assert.equal((await fixture.run()).code, 0);
    const checkpoint = await fs.readFile(fixture.checkpoint);
    const report = await fs.readFile(path.join(fixture.root, 'report.json'));
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experiment, 'utf8'),
    );
    assert.ok(config.matrix.groups !== undefined);
    config.matrix.groups[0]!.agents[0]!.model = 'group-b-model';
    config.matrix.groups[1]!.agents[0]!.model = 'group-a-model';
    await fs.writeFile(fixture.experiment, JSON.stringify(config));
    let compositions = 0;
    let executions = 0;
    const rejected = await fixture.run(['--resume', 'exp-1'], {
      compositionFactory: async () => {
        compositions += 1;
        throw new Error(
          'invalid grouped selections must fail before composition',
        );
      },
      execute: async () => {
        executions += 1;
        throw new Error('invalid grouped selections must not execute');
      },
    });
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /selection.*matrix/i);
    assert.equal(compositions, 0);
    assert.equal(executions, 0);
    assert.deepEqual(await fs.readFile(fixture.checkpoint), checkpoint);
    assert.deepEqual(
      await fs.readFile(path.join(fixture.root, 'report.json')),
      report,
    );
    assert.deepEqual(
      (await fs.readdir(path.join(fixture.root, 'runs'))).sort(),
      ['attempt-1', 'attempt-2', 'attempt-3'],
    );
  });

  it('continues after execution errors and resumes only errored entries with new run IDs', async () => {
    const fixture = await createFixture();
    const executed: number[] = [];
    let fail = true;
    const options: RunCliOptions = {
      execute: async (input) => {
        executed.push(input.plan.selection.repetition);
        if (fail && input.plan.selection.repetition === 1) {
          throw new ForgeExecutionError(
            'agent_failed',
            'interaction',
            'secret-adapter-detail',
          );
        }
        return defaultForgeEngine.executeEval(input);
      },
    };
    const first = await fixture.run(['--jobs', '2'], options);
    assert.equal(first.code, 1);
    assert.deepEqual(executed, [0, 1, 2]);
    assert.deepEqual(first.summary, {
      experiment_run_id: 'exp-1',
      location: fixture.root,
      checkpoint: fixture.checkpoint,
      report: path.join(fixture.root, 'report.json'),
      total: 3,
      executed: 3,
      skipped: 0,
      completed: 2,
      errored: 1,
    });
    const before = await fs.readFile(
      path.join(fixture.root, 'runs', 'attempt-1', 'result.json'),
    );
    const journal = await fixture.readCheckpoint();
    assert.deepEqual(journal.entries[1]!.attempts, [
      { run_id: 'attempt-2', state: 'errored', error_code: 'agent_failed' },
    ]);
    assert.equal(
      (await fs.readFile(fixture.checkpoint, 'utf8')).includes(
        'secret-adapter-detail',
      ),
      false,
    );
    assert.equal(first.stderr.includes('secret-adapter-detail'), false);
    const logged = await fs.readFile(
      path.join(fixture.root, 'events.jsonl'),
      'utf8',
    );
    assert.equal(logged.includes('secret-adapter-detail'), false);
    const failureEvent = logged
      .trimEnd()
      .split('\n')
      .map((line) => parseExperimentRunEvent(JSON.parse(line)))
      .find((event) => event.state === 'errored');
    assert.equal(failureEvent?.state, 'errored');
    if (failureEvent?.state === 'errored')
      assert.equal(failureEvent.error_code, 'agent_failed');
    const initialReport = await readReport(fixture.root);
    assert.equal(initialReport.summary.completed, 2);
    assert.equal(initialReport.summary.errored, 1);
    assert.equal(initialReport.cases[0]!.selections, 3);
    assert.deepEqual(
      initialReport.runs.map((run) => run.run_id),
      ['attempt-1', 'attempt-2', 'attempt-3'],
    );
    assert.equal(
      JSON.stringify(initialReport).includes('secret-adapter-detail'),
      false,
    );

    fail = false;
    executed.length = 0;
    const resumed = await fixture.run(
      ['--resume', 'exp-1', '--jobs', '3'],
      options,
    );
    assert.equal(resumed.code, 0);
    assert.deepEqual(executed, [1]);
    assert.equal(resumed.summary.skipped, 2);
    assert.equal(resumed.summary.completed, 3);
    const resumedReport = await readReport(fixture.root);
    assert.equal(resumedReport.summary.completed, 3);
    assert.equal(resumedReport.summary.retry_attempts, 1);
    assert.deepEqual(
      resumedReport.runs.map((run) => run.run_id),
      ['attempt-1', 'attempt-4', 'attempt-3'],
    );
    assert.deepEqual((await fixture.readCheckpoint()).entries[1]!.attempts, [
      { run_id: 'attempt-2', state: 'errored', error_code: 'agent_failed' },
      { run_id: 'attempt-4', state: 'completed' },
    ]);
    assert.deepEqual(
      await fs.readFile(
        path.join(fixture.root, 'runs', 'attempt-1', 'result.json'),
      ),
      before,
    );
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
    const run = await verifyCompletedRun(
      path.join(fixture.root, 'runs', 'attempt-1'),
    );
    assert.equal(run.result.evaluation.status, 'failed');
    const report = await readReport(fixture.root);
    assert.equal(report.summary.failed, 3);
    assert.equal(report.summary.pass_rate, 0);
    assert.equal(report.summary.coverage, 1);
    assert.equal(report.summary.judging_score.mean, null);
    const journal = await fixture.readCheckpoint();
    journal.entries[0]!.attempts[0] = { run_id: 'attempt-1', state: 'running' };
    await fs.writeFile(fixture.checkpoint, JSON.stringify(journal));
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.executed, 0);
    assert.equal(resumed.summary.skipped, 3);
    assert.equal(
      (await fixture.readCheckpoint()).entries[0]!.attempts[0]!.state,
      'completed',
    );
  });

  it('completes and resumes through a symlinked output directory without new attempts', async () => {
    const fixture = await createFixture();
    await fs.mkdir(fixture.output);
    const alias = path.join(path.dirname(fixture.output), 'results-alias');
    await fs.symlink(fixture.output, alias, 'dir');
    const first = await fixture.run(['--output', alias]);
    assert.equal(first.code, 0);
    assert.equal(first.summary.completed, 3);
    assert.equal(first.summary.errored, 0);
    const checkpoint = await fixture.readCheckpoint();
    for (const entry of checkpoint.entries) {
      assert.equal(entry.attempts[0]!.state, 'completed');
      const result = await verifyCompletedRun(
        path.join(fixture.root, 'runs', entry.attempts[0]!.run_id),
      );
      assert.equal(result.result.failure, null);
    }
    for (const output of [alias, fixture.output]) {
      const resumed = await fixture.run([
        '--output',
        output,
        '--resume',
        'exp-1',
      ]);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.executed, 0);
      assert.equal(resumed.summary.skipped, 3);
      assert.deepEqual(await fixture.readCheckpoint(), checkpoint);
    }
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
    journal.entries[1]!.attempts[0] = { run_id: 'attempt-2', state: 'running' };
    await fs.writeFile(fixture.checkpoint, JSON.stringify(journal));
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.executed, 2);
    assert.equal(resumed.summary.skipped, 1);
  });

  it('verifies artifacts before skipping and preserves corrupt attempts', async () => {
    const fixture = await createFixture();
    await fixture.run();
    const trajectory = path.join(
      fixture.root,
      'runs',
      'attempt-2',
      'trajectory.json',
    );
    await fs.writeFile(trajectory, 'corrupted');
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.executed, 1);
    assert.equal(resumed.summary.skipped, 2);
    assert.equal(await fs.readFile(trajectory, 'utf8'), 'corrupted');
    await verifyCompletedRun(path.join(fixture.root, 'runs', 'attempt-4'));
    const report = await readReport(fixture.root);
    assert.equal(report.runs[1]!.run_id, 'attempt-4');
    assert.equal(report.summary.retry_attempts, 1);
  });

  it('refuses changed plans and selector sets before executing', async () => {
    const fixture = await createFixture();
    await fixture.run();
    let calls = 0;
    const execute: RunCliOptions['execute'] = async () => {
      calls += 1;
      throw new Error('must not execute');
    };
    const filtered = await fixture.run(
      ['--resume', 'exp-1', '--repetition', '1'],
      { execute },
    );
    assert.equal(filtered.code, 2);
    assert.match(filtered.stderr, /saved selections/);
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experiment, 'utf8'),
    );
    config.limits.run_timeout_ms += 1;
    await fs.writeFile(fixture.experiment, JSON.stringify(config));
    const changed = await fixture.run(['--resume', 'exp-1'], { execute });
    assert.equal(changed.code, 1);
    assert.match(changed.stderr, /resolved plans differ/);
    assert.equal(calls, 0);
  });

  it('requires explicit resume and a valid existing checkpoint', async () => {
    const fixture = await createFixture();
    const missing = await fixture.run(['--resume', 'missing-execution']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No experiment run/);
    await fixture.run();
    const nextExecution = await fixture.run();
    assert.equal(nextExecution.code, 0);
    assert.equal(nextExecution.summary.experiment_run_id, 'exp-2');
    const journal = await fixture.readCheckpoint();
    await fs.writeFile(
      fixture.checkpoint,
      JSON.stringify({ ...journal, unknown: true }),
    );
    const invalid = await fixture.run(['--resume', 'exp-1']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /compatible Forge experiment.json/);
  });

  it('rejects invalid flag combinations and filters the initial experiment run', async () => {
    const fixture = await createFixture();
    const single = await fixture.run(['--repetition', '1']);
    assert.equal(single.code, 0);
    assert.equal(single.summary.total, 1);
    assert.equal(
      (await fixture.readCheckpoint()).entries[0]!.selection.repetition,
      1,
    );
    for (const argv of [
      ['run', '--resume'],
      ['run', '--experiment', fixture.experiment, '--resume'],
      ['run', '--resume', '../other'],
      ['plan', '--all'],
      ['run', '--dataset', 'dataset'],
      ['run', '--all'],
    ]) {
      assert.equal(await runCli(argv, { stderr: () => undefined }), 2);
    }
  });

  it('preflights every plan before executing or creating a checkpoint', async () => {
    const fixture = await createFixture();
    const engine = {
      ...defaultForgeEngine,
      preflightEval(
        input: Parameters<typeof defaultForgeEngine.preflightEval>[0],
      ) {
        if (input.plan.selection.repetition === 2)
          throw new Error('unsupported final selection');
        defaultForgeEngine.preflightEval(input);
      },
    };
    let calls = 0;
    const outcome = await fixture.run([], {
      engine,
      execute: async () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    assert.equal(outcome.code, 1);
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(fixture.checkpoint), { code: 'ENOENT' });
  });

  it('prevents simultaneous writers to the same experiment run', async () => {
    const fixture = await createFixture();
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = fixture.run([], {
      execute: async (input) => {
        started();
        await gate;
        return defaultForgeEngine.executeEval(input);
      },
    });
    await ready;
    try {
      const second = await fixture.run(['--resume', 'exp-1']);
      assert.equal(second.code, 1);
      assert.match(second.stderr, /Another experiment run process/);
    } finally {
      finish();
    }
    assert.equal((await first).code, 0);
    assert.equal(
      (await fixture.run(['--resume', 'exp-1'])).summary.executed,
      0,
    );
  });

  it('reclaims a local process lock after its owner exits', async () => {
    const fixture = await createFixture();
    await fixture.run();
    const { lock } = await createDeadOwnerLock(fixture.root);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.skipped, 3);
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  });

  it('rejects a delayed competing stale-owner removal without disturbing the active writer', async () => {
    const fixture = await createFixture();
    await fixture.run(['--repetition', '0'], {
      execute: async () => {
        throw new Error('interrupted');
      },
    });
    const { lock, ownerFile } = await createDeadOwnerLock(fixture.root);
    const removals = [createGate(), createGate()];
    const firstRemoval = createGate();
    const bothRemovals = createGate();
    const started = createGate();
    const finish = createGate();
    let removalCount = 0;
    let executions = 0;
    const originalUnlink = fsPromises.unlink;
    vi.spyOn(fsPromises, 'unlink').mockImplementation(
      async (...args: Parameters<typeof originalUnlink>) => {
        if (args[0] === ownerFile && removalCount < 2) {
          const gate = removals[removalCount++]!;
          if (removalCount === 1) firstRemoval.resolve();
          if (removalCount === 2) bothRemovals.resolve();
          await gate.promise;
        }
        return originalUnlink(...args);
      },
    );
    syncBuiltinESMExports();
    const options: RunCliOptions = {
      execute: async (input) => {
        executions += 1;
        started.resolve();
        await finish.promise;
        return defaultForgeEngine.executeEval(input);
      },
    };
    const first = fixture.run(['--resume', 'exp-1'], options);
    let second: ReturnType<typeof fixture.run> | undefined;
    try {
      await waitFor(firstRemoval.promise);
      second = fixture.run(['--resume', 'exp-1'], options);
      await waitFor(bothRemovals.promise);
      removals[0]!.resolve();
      await waitFor(started.promise);
      removals[1]!.resolve();
      const rejected = await waitFor(second);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /Another experiment run process/);
      assert.equal(executions, 1);
      assert.equal((await fs.readdir(lock)).length, 1);
      const active = await fixture.readCheckpoint();
      assert.equal(active.entries[0]!.attempts.at(-1)!.state, 'running');
      finish.resolve();
      assert.equal((await waitFor(first)).code, 0);
      assert.equal(
        (await fixture.readCheckpoint()).entries[0]!.attempts.length,
        2,
      );
    } finally {
      for (const gate of removals) gate.resolve();
      finish.resolve();
      await Promise.allSettled([
        first,
        ...(second === undefined ? [] : [second]),
      ]);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('rejects delayed empty-lock cleanup after another writer publishes its owner', async () => {
    const fixture = await createFixture();
    await fixture.run(['--repetition', '0'], {
      execute: async () => {
        throw new Error('interrupted');
      },
    });
    const { lock } = await createDeadOwnerLock(fixture.root);
    const removing = createGate();
    const remove = createGate();
    const started = createGate();
    const finish = createGate();
    let delayed = false;
    let executions = 0;
    const originalRmdir = fsPromises.rmdir;
    vi.spyOn(fsPromises, 'rmdir').mockImplementation(
      async (...args: Parameters<typeof originalRmdir>) => {
        if (args[0] === lock && !delayed) {
          delayed = true;
          removing.resolve();
          await remove.promise;
        }
        return originalRmdir(...args);
      },
    );
    syncBuiltinESMExports();
    const options: RunCliOptions = {
      execute: async (input) => {
        executions += 1;
        started.resolve();
        await finish.promise;
        return defaultForgeEngine.executeEval(input);
      },
    };
    const first = fixture.run(['--resume', 'exp-1'], options);
    let second: ReturnType<typeof fixture.run> | undefined;
    try {
      await waitFor(removing.promise);
      second = fixture.run(['--resume', 'exp-1'], options);
      await waitFor(started.promise);
      remove.resolve();
      const rejected = await waitFor(first);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /Another experiment run process/);
      assert.equal(executions, 1);
      assert.equal((await fs.readdir(lock)).length, 1);
      finish.resolve();
      assert.equal((await waitFor(second)).code, 0);
      assert.equal(
        (await fixture.readCheckpoint()).entries[0]!.attempts.length,
        2,
      );
    } finally {
      remove.resolve();
      finish.resolve();
      await Promise.allSettled([
        first,
        ...(second === undefined ? [] : [second]),
      ]);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('recovers an empty lock directory left during interrupted cleanup', async () => {
    const fixture = await createFixture();
    await fixture.run();
    const lock = path.join(fixture.root, '.experiment.lock');
    await fs.mkdir(lock);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.summary.skipped, 3);
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  });

  it('reclaims a stale lock when directory contention reports Windows EPERM', async () => {
    const fixture = await createFixture();
    await fixture.run();
    const { lock } = await createDeadOwnerLock(fixture.root);
    const originalRename = fsPromises.rename;
    let collision = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof originalRename>) => {
        if (args[1] === lock && !collision) {
          collision = true;
          throw Object.assign(new Error('Directory collision'), {
            code: 'EPERM',
          });
        }
        return originalRename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      const resumed = await fixture.run(['--resume', 'exp-1']);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.skipped, 3);
      assert.equal(collision, true);
      await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('preserves a genuine publication permission error when no lock exists', async () => {
    const fixture = await createFixture();
    const originalRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof originalRename>) => {
        if (path.basename(String(args[1])) === '.experiment.lock') {
          throw Object.assign(new Error('Publication permission denied'), {
            code: 'EPERM',
          });
        }
        return originalRename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      const first = await fixture.run();
      assert.equal(first.code, 1);
      assert.match(first.stderr, /Publication permission denied/);
      await assert.rejects(fs.stat(fixture.checkpoint), { code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('retries committed role-player errors while retaining their valid artifacts', async () => {
    const fixture = await createFixture();
    const dataset = path.join(path.dirname(fixture.experiment), 'dataset');
    const relative = 'cases/examples/hello-file.case.yaml';
    const body = (
      await fs.readFile(path.join(dataset, relative), 'utf8')
    ).replace(
      'execution_mode: one_shot',
      'execution_mode: multi_turn\ntask: Complete the task',
    );
    await fs.writeFile(path.join(dataset, relative), body);
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experiment, 'utf8'),
    );
    config.matrix.repetitions = 1;
    config.models.role_player = {
      provider: 'scripted',
      model: 'test-role-player',
    };
    await fs.writeFile(fixture.experiment, JSON.stringify(config));
    const options: RunCliOptions = {
      compositionFactory: async ({ resultsRoot }) => {
        const runtime = createFakeRuntimeAdapter();
        const agent = createScriptedAgentAdapter({ id: 'claude-code' });
        const completion = createScriptedCompletionProvider({
          id: 'scripted',
          responses: [
            new Error('unavailable'),
            new Error('unavailable'),
            new Error('unavailable'),
          ],
        });
        return {
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          completionProviders: new Map([
            [completion.provider.id, completion.provider],
          ]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root: resultsRoot }),
        };
      },
      execute: (input) =>
        executeEvalWithTestHooks(input, {
          waitBeforeCompletionRetry: async () => undefined,
        }),
    };
    const first = await fixture.run([], options);
    assert.equal(first.code, 1);
    const completed = await verifyCompletedRun(
      path.join(fixture.root, 'runs', 'attempt-1'),
    );
    assert.equal(completed.result.stop_reason, 'role_player_error');
    assert.deepEqual((await fixture.readCheckpoint()).entries[0]!.attempts, [
      {
        run_id: 'attempt-1',
        state: 'errored',
        error_code: 'role_player_error',
        diagnostic: {
          phase: 'interaction',
          reason: 'failure',
          message: 'unavailable',
        },
      },
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
  entries: Array<{
    selection: RunSelection;
    plan_sha256: string;
    attempts: Array<{ run_id: string; state: string; error_code?: string }>;
  }>;
}

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function readReport(root: string) {
  return parseExperimentRunReport(
    JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8')),
  );
}

async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Timed out waiting for the lock interleaving.')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createDeadOwnerLock(root: string) {
  const owner = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    { encoding: 'utf8' },
  );
  assert.equal(owner.status, 0);
  const lock = path.join(root, '.experiment.lock');
  const ownerFile = path.join(lock, `owner-${randomUUID()}.json`);
  await fs.mkdir(lock);
  await fs.writeFile(ownerFile, JSON.stringify({ pid: Number(owner.stdout) }));
  return { lock, ownerFile };
}

async function createGroupedFixture() {
  const fixture = await createFixture({
    anotherCase: true,
    repetitions: 1,
    initialFiles: { 'hello.txt': 'hello, forge!\n' },
  });
  const config = parseExperimentConfigYaml(
    await fs.readFile(fixture.experiment, 'utf8'),
  );
  config.treatments.seeded = {
    setup: [
      {
        uses: 'forge/write',
        with: { target: 'seed.txt', source: { content: 'seed' } },
      },
    ],
  };
  config.matrix = {
    groups: [
      {
        cases: ['cases/examples/hello-file.case.yaml'],
        treatments: ['baseline'],
        agents: [
          {
            adapter: 'claude-code',
            provider: 'anthropic',
            model: 'group-a-model',
          },
        ],
      },
      {
        cases: ['cases/examples/other-file.case.yaml'],
        treatments: ['baseline', 'seeded'],
        agents: [
          {
            adapter: 'claude-code',
            provider: 'anthropic',
            model: 'group-b-model',
          },
        ],
      },
    ],
    repetitions: 1,
    retries: 0,
  };
  await fs.writeFile(fixture.experiment, JSON.stringify(config));
  return fixture;
}

async function createFixture(
  options: {
    anotherCase?: boolean;
    repetitions?: number;
    initialFiles?: Readonly<Record<string, string>>;
  } = {},
) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-experiment-run-'),
  );
  temporaryDirectories.push(temporary);
  const output = path.join(temporary, 'results');
  const root = path.join(output, 'experiments', 'exp-1');
  const fixtureRoot = path.resolve('test/fixtures/one-shot');
  const experiment = path.join(temporary, 'experiment.yaml');
  const config = parseExperimentConfigYaml(
    await fs.readFile(path.join(fixtureRoot, 'experiment.yaml'), 'utf8'),
  );
  assert.ok(config.matrix.groups === undefined);
  config.matrix.repetitions = options.repetitions ?? 3;
  const initialFiles = options.initialFiles;
  const dataset = path.join(temporary, 'dataset');
  await fs.cp(path.join(fixtureRoot, 'dataset'), dataset, { recursive: true });
  config.dataset.path = './dataset';
  if (options.anotherCase) {
    const body = (
      await fs.readFile(
        path.join(dataset, 'cases/examples/hello-file.case.yaml'),
        'utf8',
      )
    ).replace('id: examples/hello-file', 'id: examples/other-file');
    const relative = 'cases/examples/other-file.case.yaml';
    await fs.writeFile(path.join(dataset, relative), body);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dataset, 'manifest.json'), 'utf8'),
    ) as DatasetManifestV1;
    manifest.cases.push({
      id: 'examples/other-file',
      version: '0.1.0',
      path: relative,
    });
    const raw = `${JSON.stringify(manifest)}\n`;
    await fs.writeFile(path.join(dataset, 'manifest.json'), raw);
    config.matrix.cases.push(relative);
  }
  await fs.writeFile(experiment, JSON.stringify(config));
  const checkpoint = path.join(root, 'experiment.json');
  let nextId = 0;
  let nextExecutionId = 0;
  return {
    root,
    output,
    experiment,
    checkpoint,
    readCheckpoint: async (): Promise<Checkpoint> =>
      JSON.parse(await fs.readFile(checkpoint, 'utf8')),
    async run(extra: string[] = [], options: RunCliOptions = {}) {
      let stdout = '';
      let stderr = '';
      const runtime = createFakeRuntimeAdapter(
        initialFiles === undefined ? {} : { initialFiles },
      );
      const agent = createScriptedAgentAdapter({
        id: 'claude-code',
        turns: Array.from({ length: 6 }, () => ({
          text: 'Done',
          sessionId: 'experiment-run-session',
          toolCalls: [],
        })),
      });
      const code = await runCli(
        ['run', '--experiment', experiment, '--output', output, ...extra],
        {
          runIdFactory: () => `attempt-${++nextId}`,
          experimentRunIdFactory: () => `exp-${++nextExecutionId}`,
          stdout: (value) => {
            stdout += value;
          },
          stderr: (value) => {
            stderr += value;
          },
          compositionFactory: async ({ resultsRoot }) => ({
            runtime: runtime.adapter,
            agents: new Map([[agent.adapter.id, agent.adapter]]),
            credentialResolver: createStaticCredentialResolver(),
            inputProvider: createMemoryRunInputProvider(),
            artifactStore: createArtifactStore({ root: resultsRoot }),
          }),
          ...options,
        },
      );
      return {
        code,
        stderr,
        summary: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {},
      };
    },
  };
}
