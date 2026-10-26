import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import type { ForgeComposition } from './contracts/composition.ts';
import { createForgeEngine, defaultForgeEngine } from './engine.ts';
import * as experimentRunExports from './experiment.ts';
import {
  type ExperimentRunOptions,
  type ExperimentRunProgressEvent,
  ExperimentRunReportError,
  type ExperimentRunReportV1,
  type ExperimentRunSummary,
  inspectExperimentRun,
  parseExperimentRunReport,
  readExperimentRunSelections,
  runExperiment,
} from './experiment.ts';
import { parseExperimentRunCheckpoint } from './experimentModel.ts';
import { createArtifactStore } from './results/index.ts';
import { defineSetupActionBundle } from './setup/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './testing/index.ts';
import { FORGE_BUILD_IDENTITY, FORGE_VERSION } from './version.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('public experiment run API', () => {
  it('exports orchestration through its subpath, separate from the root engine API', () => {
    assert.equal(typeof runExperiment, 'function');
    assert.equal(typeof readExperimentRunSelections, 'function');
    assert.equal(typeof inspectExperimentRun, 'function');
    assert.equal(typeof parseExperimentRunReport, 'function');
    assert.equal(typeof ExperimentRunReportError, 'function');
    assert.equal(
      'EXPERIMENT_RUN_REPORT_SCHEMA_VERSION' in experimentRunExports,
      false,
    );
    const _optionsType = (_options: ExperimentRunOptions): void => undefined;
    const _summaryType = (_summary: ExperimentRunSummary): void => undefined;
    const _reportType = (_report: ExperimentRunReportV1): void => undefined;
    const _eventType = (event: ExperimentRunProgressEvent): string => {
      if ('location' in event) return event.location;
      if (event.state === 'errored') return event.error_code;
      return event.run_id;
    };
  });

  it('persists execution diagnostics without run artifacts and retains them in retry history', async () => {
    const root = await experimentRunRoot();
    const plan = createTestResolvedRunPlan();
    const composition = makeComposition(root);
    const selected = composition.agents.get(plan.agent.adapter)!;
    let fail = true;
    let nextId = 0;
    const events: ExperimentRunProgressEvent[] = [];
    const configured = {
      ...composition,
      agents: new Map([
        [
          selected.id,
          {
            ...selected,
            async openSession(
              context: Parameters<typeof selected.openSession>[0],
            ) {
              if (fail)
                throw new Error('Agent stream ended before a completed turn.');
              return selected.openSession(context);
            },
          },
        ],
      ]),
    };
    const options: ExperimentRunOptions = {
      root,
      engine: defaultForgeEngine,
      plans: [plan],
      composition: configured,
      resume: false,
      signal: new AbortController().signal,
      runIdFactory: () => `diagnostic-${++nextId}`,
      execute: (input) => defaultForgeEngine.executeEval(input),
      progress: (event) => events.push(event),
    };
    const result = await runExperiment(options);
    assert.equal(result.errored, 1);
    const expected = {
      phase: 'interaction',
      reason: 'failure',
      message: 'Agent stream ended before a completed turn.',
    };
    const checkpoint = parseExperimentRunCheckpoint(
      JSON.parse(await fs.readFile(result.checkpoint, 'utf8')),
    );
    const last = checkpoint.entries[0]!.attempts[0]!;
    assert.equal(last.state, 'errored');
    if (last.state !== 'errored') throw new Error('Expected failed attempt');
    assert.deepEqual(last.diagnostic, expected);
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(result.report, 'utf8')),
    );
    assert.deepEqual(report.runs[0]!.diagnostic, expected);
    assert.equal(report.runs[0]!.result_path, null);
    const inspected = await inspectExperimentRun({
      root,
      engine: defaultForgeEngine,
    });
    assert.deepEqual(inspected.outcomes[0]!.diagnostic, expected);
    const event = events.find((event) => event.state === 'errored');
    assert.equal(event?.state, 'errored');
    if (event?.state === 'errored')
      assert.deepEqual(event.diagnostic, expected);
    for (const diagnostic of [
      { ...expected, phase: 'unknown' },
      { ...expected, reason: 'unknown' },
      { ...expected, message: 'x'.repeat(4097) },
      { ...expected, response: 'private' },
    ]) {
      const invalid = structuredClone(checkpoint);
      const attempt = invalid.entries[0]!.attempts[0]!;
      Object.assign(attempt, { diagnostic });
      assert.throws(() => parseExperimentRunCheckpoint(invalid));
      assert.throws(() =>
        parseExperimentRunReport({
          ...report,
          runs: [{ ...report.runs[0]!, diagnostic }],
        }),
      );
    }
    await fs.mkdir(path.join(root, 'diagnostics', 'orphan-attempt'), {
      mode: 0o700,
    });
    await assert.rejects(
      runExperiment({
        ...options,
        resume: true,
        runIdFactory: () => 'orphan-attempt',
      }),
      /Eval run ID already exists/,
    );
    const diagnosticPath = path.join(
      root,
      'diagnostics',
      last.run_id,
      'attempt.json',
    );
    const savedDiagnostic = await fs.readFile(diagnosticPath, 'utf8');
    const record = JSON.parse(savedDiagnostic);
    assert.equal(record.state, 'errored');
    assert.equal(record.timing.started_at, last.started_at);
    assert.equal(record.timing.finished_at, report.runs[0]!.finished_at);
    record.identity.plan_sha256 = `sha256:${'f'.repeat(64)}`;
    await fs.writeFile(diagnosticPath, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(
      runExperiment({ ...options, resume: true }),
      /identity/,
    );
    await fs.writeFile(diagnosticPath, savedDiagnostic, { mode: 0o600 });
    const interruptedCheckpoint = structuredClone(checkpoint);
    interruptedCheckpoint.entries[0]!.attempts[0] = {
      run_id: last.run_id,
      state: 'running',
      reserved_at: last.reserved_at,
      started_at: last.started_at,
      finished_at: last.finished_at,
      diagnostics_status: last.diagnostics_status,
    };
    await fs.writeFile(
      result.checkpoint,
      JSON.stringify(interruptedCheckpoint),
    );
    fail = false;
    const resumed = await runExperiment({ ...options, resume: true });
    assert.equal(await fs.readFile(diagnosticPath, 'utf8'), savedDiagnostic);
    assert.equal(resumed.completed, 1);
    const history = parseExperimentRunCheckpoint(
      JSON.parse(await fs.readFile(result.checkpoint, 'utf8')),
    ).entries[0]!.attempts;
    assert.deepEqual(history[0], last);
    assert.equal(history[1]!.state, 'completed');
  });

  it('reads a pending-only checkpoint using its Forge identity without companion artifacts', async () => {
    const root = await experimentRunRoot();
    const plan = createTestResolvedRunPlan();
    const checkpoint = {
      forge: FORGE_BUILD_IDENTITY,
      experiment_run_id: path.basename(root),
      entries: [
        {
          selection: plan.selection,
          plan_sha256: `sha256:${'a'.repeat(64)}`,
          attempts: [],
        },
      ],
    };
    await fs.mkdir(root);
    const location = path.join(root, 'experiment.json');
    await fs.writeFile(location, JSON.stringify(checkpoint));
    assert.deepEqual(await readExperimentRunSelections(root), [plan.selection]);
    const inspected = await inspectExperimentRun({
      root,
      engine: defaultForgeEngine,
    });
    assert.equal(inspected.outcomes[0]!.state, 'pending');
    assert.equal(inspected.outcomes[0]!.artifact, null);
    assert.deepEqual(
      parseExperimentRunCheckpoint(checkpoint).forge,
      FORGE_BUILD_IDENTITY,
    );
    assert.equal(
      Object.hasOwn(parseExperimentRunCheckpoint(checkpoint), 'schema_version'),
      false,
    );

    for (const invalid of [
      { ...checkpoint, forge: undefined },
      { ...checkpoint, forge: { ...checkpoint.forge, unknown: true } },
      { ...checkpoint, schema_version: 1 },
      { ...checkpoint, forge: { version: '9999.0.0' } },
    ]) {
      await fs.writeFile(location, JSON.stringify(invalid));
      await assert.rejects(
        readExperimentRunSelections(root),
        /compatible Forge experiment.json/,
      );
      await assert.rejects(
        inspectExperimentRun({ root, engine: defaultForgeEngine }),
        /compatible Forge experiment.json/,
      );
    }
  });

  it('checks a checkpoint release before interpreting its selections and treats diagnostics as provenance', () => {
    assert.throws(
      () =>
        parseExperimentRunCheckpoint({
          forge: { version: '9999.0.0' },
          entries: 'invalid',
        }),
      /incompatible with installed Forge/,
    );
    const checkpoint = {
      forge: {
        version: FORGE_VERSION,
        commit_sha: 'a'.repeat(40),
        dirty: true,
      },
      experiment_run_id: 'test-checkpoint',
      entries: [
        {
          selection: createTestResolvedRunPlan().selection,
          plan_sha256: `sha256:${'a'.repeat(64)}`,
          attempts: [],
        },
      ],
    };
    assert.deepEqual(
      parseExperimentRunCheckpoint(checkpoint).forge,
      checkpoint.forge,
    );
  });

  it('stamps the current build when rewriting a resumed checkpoint without changing committed runs', async () => {
    const root = await experimentRunRoot();
    const options: ExperimentRunOptions = {
      root,
      plans: [createTestResolvedRunPlan()],
      composition: makeComposition(root),
      engine: defaultForgeEngine,
      resume: false,
      signal: new AbortController().signal,
      runIdFactory: () => 'retained-run',
      progress: () => undefined,
      execute: (input) =>
        defaultForgeEngine.executeEval({
          ...input,
          composition: makeComposition(root),
        }),
    };
    const first = await runExperiment(options);
    const checkpoint = parseExperimentRunCheckpoint(
      JSON.parse(await fs.readFile(first.checkpoint, 'utf8')),
    );
    const oldBuild = {
      version: FORGE_VERSION,
      commit_sha: 'a'.repeat(40),
      dirty: FORGE_BUILD_IDENTITY.dirty !== true,
    };
    assert.notDeepEqual(oldBuild, FORGE_BUILD_IDENTITY);
    await fs.writeFile(
      first.checkpoint,
      JSON.stringify({ ...checkpoint, forge: oldBuild }),
    );
    const runRoot = path.join(root, 'runs', 'retained-run');
    const savedPlan = await fs.readFile(path.join(runRoot, 'plan.json'));
    const savedResult = await fs.readFile(path.join(runRoot, 'result.json'));

    const resumed = await runExperiment({
      ...options,
      resume: true,
      execute: async () => {
        throw new Error('must skip committed runs');
      },
    });
    assert.equal(resumed.executed, 0);
    assert.equal(resumed.skipped, 1);
    const rewritten = parseExperimentRunCheckpoint(
      JSON.parse(await fs.readFile(first.checkpoint, 'utf8')),
    );
    assert.deepEqual(rewritten.forge, FORGE_BUILD_IDENTITY);
    assert.deepEqual(rewritten.entries, checkpoint.entries);
    assert.deepEqual(
      await fs.readFile(path.join(runRoot, 'plan.json')),
      savedPlan,
    );
    assert.deepEqual(
      await fs.readFile(path.join(runRoot, 'result.json')),
      savedResult,
    );
  });

  it('rejects invalid library concurrency before preflight or filesystem writes', async () => {
    const root = await experimentRunRoot();
    const composition = makeComposition(root);
    let calls = 0;
    for (const jobs of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await assert.rejects(
        runExperiment({
          root,
          composition,
          jobs,
          plans: [createTestResolvedRunPlan()],
          engine: {
            ...defaultForgeEngine,
            preflightEval() {
              calls += 1;
            },
          },
          resume: false,
          signal: new AbortController().signal,
          execute: async () => {
            throw new Error('must not execute');
          },
          runIdFactory: () => 'never',
          progress: () => undefined,
        }),
        /positive safe integer/,
      );
    }
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  });

  it('preflights every plan before acquiring per-run host resources', async () => {
    const root = await experimentRunRoot();
    const plans = ['first', 'last'].map((id) =>
      createTestResolvedRunPlan({ caseId: `testing/${id}` }),
    );
    const preflighted: string[] = [];
    let calls = 0;
    await assert.rejects(
      runExperiment({
        root,
        plans,
        jobs: 2,
        composition: makeComposition(root),
        engine: {
          ...defaultForgeEngine,
          preflightEval({ plan }) {
            preflighted.push(plan.selection.case_id);
            if (plan === plans[1]) throw new Error('unsupported final plan');
          },
        },
        resume: false,
        signal: new AbortController().signal,
        execute: async () => {
          calls += 1;
          throw new Error('must not execute');
        },
        runIdFactory: () => 'never',
        progress: () => undefined,
      }),
      /unsupported final plan/,
    );
    assert.deepEqual(preflighted, ['testing/first', 'testing/last']);
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  });

  it('shares scheduling and resume with a custom engine and per-run host compositions', async () => {
    const root = await experimentRunRoot();
    const manifest = {
      namespace: 'acme-evals',
      version: '1.0.0',
      sha256: `sha256:${'a'.repeat(64)}` as const,
    };
    const bundle = defineSetupActionBundle({
      manifest,
      actions: [
        {
          uses: 'acme-evals/seed',
          parseWith(input) {
            if (
              typeof input !== 'object' ||
              input === null ||
              Array.isArray(input) ||
              Object.keys(input).length !== 0
            ) {
              throw new Error('Expected empty seed configuration.');
            }
            return {};
          },
          preflight() {
            return {
              requirements: {},
              async apply(context) {
                await context.workspace.writeFile(
                  'seed.txt',
                  Buffer.from('ready'),
                );
                return { seed: 'ready' };
              },
            };
          },
        },
      ],
    });
    const engine = createForgeEngine({ setupActionBundles: [bundle] });
    const plans = ['first', 'second'].map((id) => {
      const plan = structuredClone(
        createTestResolvedRunPlan({
          caseId: `testing/${id}`,
          checks: {
            file_checks: [
              { file: 'seed.txt', exists: true, contains: '^ready$' },
            ],
          },
        }),
      );
      plan.provenance.forge.action_bundles = [manifest];
      plan.treatment.setup = [{ uses: 'acme-evals/seed', with: {} }];
      plan.setup = [...plan.treatment.setup];
      return engine.parseResolvedRunPlan(plan);
    });
    const composition = makeComposition(root);
    const events: ExperimentRunProgressEvent[] = [];
    const opened: string[] = [];
    const closed: string[] = [];
    let nextId = 0;
    let fail = true;
    const options: ExperimentRunOptions = {
      root,
      plans,
      composition,
      engine,
      resume: false,
      jobs: 2,
      signal: new AbortController().signal,
      runIdFactory: () => `host-run-${++nextId}`,
      progress: (event) => events.push(event),
      execute: async (input) => {
        assert.equal(input.composition, composition);
        opened.push(input.runId);
        try {
          if (fail && input.plan.selection.case_id === 'testing/second')
            throw new Error('transient host failure');
          // The host can supply independent bridge/runtime/agent resources for
          // each run after the shared pure preflight boundary.
          return await engine.executeEval({
            ...input,
            composition: makeComposition(root),
          });
        } finally {
          closed.push(input.runId);
        }
      },
    };
    assert.deepEqual(await runExperiment(options), {
      checkpoint: path.join(root, 'experiment.json'),
      report: path.join(root, 'report.json'),
      total: 2,
      executed: 2,
      skipped: 0,
      completed: 1,
      errored: 1,
    });
    assert.deepEqual(
      await readExperimentRunSelections(root),
      plans.map((plan) => plan.selection),
    );
    assert.deepEqual(
      await readExperimentRunSelections(`${root}/.`),
      plans.map((plan) => plan.selection),
    );
    assert.deepEqual(
      await readExperimentRunSelections(path.relative(process.cwd(), root)),
      plans.map((plan) => plan.selection),
    );
    fail = false;
    const resumed = await runExperiment({ ...options, resume: true, jobs: 3 });
    assert.equal(resumed.executed, 1);
    assert.equal(resumed.skipped, 1);
    assert.equal(resumed.completed, 2);
    assert.deepEqual(opened, ['host-run-1', 'host-run-2', 'host-run-3']);
    assert.deepEqual([...closed].sort(), opened);
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(root, 'experiment.json'), 'utf8'),
    );
    assert.deepEqual(
      checkpoint.entries.map(
        (entry: { attempts: unknown[] }) => entry.attempts.length,
      ),
      [1, 2],
    );
    for (const runId of ['host-run-1', 'host-run-3']) {
      const completed = await engine.verifyCompletedRun(
        path.join(root, 'runs', runId),
      );
      assert.equal(completed.result.evaluation.status, 'passed');
      await assert.rejects(
        defaultForgeEngine.verifyCompletedRun(completed.location),
        /plan.json does not match its schema/,
      );
    }
    assert.ok(events.some((event) => event.state === 'resuming'));
    assert.ok(events.some((event) => event.state === 'skipped'));
    assert.ok(
      events.some(
        (event) =>
          event.state === 'errored' && event.error_code === 'execution_error',
      ),
    );
  });

  it('drains siblings under the lock when an outcome callback throws and resumes only unfinished work', async () => {
    const root = await experimentRunRoot();
    const plans = ['first', 'second', 'third'].map((id) =>
      createTestResolvedRunPlan({ caseId: `testing/${id}` }),
    );
    const started = createGate();
    const cancelled = createGate();
    const cleanup = createGate();
    const controller = new AbortController();
    const sentinel = new Error('outcome callback failed');
    const calls: string[] = [];
    let nextId = 0;
    const options: ExperimentRunOptions = {
      root,
      plans,
      composition: makeComposition(root),
      engine: defaultForgeEngine,
      jobs: 2,
      resume: false,
      signal: controller.signal,
      runIdFactory: () => `callback-${++nextId}`,
      progress: () => undefined,
      onOutcome(_outcome, index) {
        if (index === 0) throw sentinel;
      },
      async execute(input) {
        calls.push(input.plan.selection.case_id);
        if (input.plan === plans[0]) {
          await waitFor(started.promise);
          return defaultForgeEngine.executeEval({
            ...input,
            composition: makeComposition(root),
          });
        }
        assert.equal(
          input.plan,
          plans[1],
          'No third worker may start after callback failure',
        );
        started.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal!.aborted) resolve();
          else
            input.signal!.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
        cancelled.resolve();
        await cleanup.promise;
        throw input.signal!.reason;
      },
    };
    let settled = false;
    const running = runExperiment(options).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await waitFor(cancelled.promise);
      await fs.stat(path.join(root, '.experiment.lock'));
      assert.equal(
        settled,
        false,
        'The callback failure must wait for sibling cleanup',
      );
      assert.deepEqual(calls, ['testing/first', 'testing/second']);
      cleanup.resolve();
      assert.equal(await waitFor(running), sentinel);
      await assert.rejects(fs.stat(path.join(root, '.experiment.lock')), {
        code: 'ENOENT',
      });
      const retained = await fs.readFile(
        path.join(root, 'runs', 'callback-1', 'result.json'),
      );
      const resumed = await runExperiment({
        ...options,
        resume: true,
        onOutcome: () => undefined,
        execute: (input) =>
          defaultForgeEngine.executeEval({
            ...input,
            composition: makeComposition(root),
          }),
      });
      assert.equal(resumed.skipped, 1);
      assert.equal(resumed.executed, 2);
      assert.deepEqual(
        await fs.readFile(path.join(root, 'runs', 'callback-1', 'result.json')),
        retained,
      );
      let executions = 0;
      await assert.rejects(
        runExperiment({
          ...options,
          resume: true,
          execute: async () => {
            executions += 1;
            throw new Error('must not execute');
          },
        }),
        (error) => error === sentinel,
      );
      assert.equal(
        executions,
        0,
        'A failing skipped-outcome callback must stop no-op resume',
      );
    } finally {
      controller.abort();
      cleanup.resolve();
      await running;
    }
  });

  it('uses the latest attempt after an older valid result is restored', async () => {
    const root = await experimentRunRoot();
    const plans = [createTestResolvedRunPlan()];
    let nextId = 0;
    const options: ExperimentRunOptions = {
      root,
      plans,
      composition: makeComposition(root),
      engine: defaultForgeEngine,
      resume: false,
      signal: new AbortController().signal,
      runIdFactory: () => `history-${++nextId}`,
      progress: () => undefined,
      execute: (input) =>
        defaultForgeEngine.executeEval({
          ...input,
          composition: makeComposition(root),
        }),
    };
    await runExperiment(options);
    const originalPath = path.join(root, 'runs', 'history-1', 'result.json');
    const original = await fs.readFile(originalPath);
    await fs.writeFile(originalPath, 'invalid result');
    const failedRetry = await runExperiment({
      ...options,
      resume: true,
      execute: async () => {
        throw new Error('retry execution failed');
      },
    });
    assert.equal(failedRetry.errored, 1);
    await fs.writeFile(originalPath, original);
    await defaultForgeEngine.verifyCompletedRun(path.dirname(originalPath));

    const inspection = await inspectExperimentRun({
      root,
      engine: defaultForgeEngine,
    });
    assert.equal(inspection.outcomes[0]!.run_id, 'history-2');
    assert.equal(inspection.outcomes[0]!.state, 'errored');
    assert.equal(inspection.outcomes[0]!.artifact, null);
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8')),
    );
    assert.equal(report.summary.completed, 0);
    assert.equal(report.runs[0]!.run_id, 'history-2');
    assert.equal(report.runs[0]!.evaluation, null);
    const resumed = await runExperiment({ ...options, resume: true });
    assert.equal(resumed.executed, 1);
    assert.equal(resumed.skipped, 0);
    assert.equal(resumed.completed, 1);
    assert.deepEqual(await fs.readFile(originalPath), original);
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(root, 'experiment.json'), 'utf8'),
    );
    assert.deepEqual(
      checkpoint.entries[0].attempts.map(
        (attempt: { run_id: string }) => attempt.run_id,
      ),
      ['history-1', 'history-2', 'history-3'],
    );
  });
});

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error('Timed out waiting for experiment run test readiness'),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function experimentRunRoot() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-experiment-run-api-'),
  );
  temporaryDirectories.push(temporary);
  return path.join(temporary, 'host-experiment-run');
}

function makeComposition(root: string): ForgeComposition {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter();
  return {
    runtime: runtime.adapter,
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({ root }),
  };
}
