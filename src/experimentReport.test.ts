import * as assert from 'node:assert/strict';
import fsPromises, * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { defaultForgeEngine } from './engine.js';
import {
  type ExperimentRunOptions,
  ExperimentRunReportError,
  parseExperimentRunReport,
  runExperiment,
} from './experiment.js';
import {
  buildExperimentRunReport,
  type ExperimentRunReportRunV1,
} from './experimentReport.js';
import { sha256Digest } from './model/hashes.js';
import { createArtifactStore } from './results/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './testing/index.js';
import { FORGE_BUILD_IDENTITY, FORGE_VERSION } from './version.js';

const temporaryDirectories: string[] = [];
type MutableExperimentRunOptions = {
  -readonly [K in keyof ExperimentRunOptions]: ExperimentRunOptions[K];
};
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('experiment run scorecards', () => {
  it('records the producing Forge build and reads standalone pending scorecards', () => {
    const pending = row(0);
    Object.assign(pending, {
      state: 'pending',
      run_id: null,
      result_path: null,
      evaluation: null,
      attempt_count: 0,
    });
    const report = build([pending]);
    assert.deepEqual(report.forge, FORGE_BUILD_IDENTITY);
    assert.equal(Object.hasOwn(report, 'schema_version'), false);
    assert.equal(parseExperimentRunReport(report).summary.pending, 1);
    assert.throws(() =>
      parseExperimentRunReport({ ...report, forge: undefined }),
    );
    assert.throws(() =>
      parseExperimentRunReport({
        ...report,
        forge: { ...report.forge, unknown: true },
      }),
    );
    assert.throws(() =>
      parseExperimentRunReport({ ...report, schema_version: 1 }),
    );
    assert.throws(
      () =>
        parseExperimentRunReport({
          forge: { version: '9999.0.0' },
          runs: 'invalid',
        }),
      /incompatible with installed Forge/,
    );
    const diagnosticIdentity = {
      version: FORGE_VERSION,
      commit_sha: 'b'.repeat(40),
      dirty: true,
    };
    assert.deepEqual(
      parseExperimentRunReport({ ...report, forge: diagnosticIdentity }).forge,
      diagnosticIdentity,
    );
  });

  it('permits different development releases only when the reader is also a development build', () => {
    const report = {
      ...build([row(0)]),
      forge: {
        version: '9999.0.0-dev.123',
        commit_sha: 'c'.repeat(40),
        dirty: false,
      },
    };
    if (/^\d+\.\d+\.\d+-dev(?:\.|$)/.test(FORGE_VERSION)) {
      assert.deepEqual(parseExperimentRunReport(report).forge, report.forge);
    } else {
      assert.throws(
        () => parseExperimentRunReport(report),
        /incompatible with installed Forge/,
      );
    }
  });

  it('keeps Codex hook policies in report coordinates and separates their score groups', () => {
    const runs = [row(0), row(1)];
    runs[0]!.selection.agent = {
      adapter: 'codex',
      provider: 'openai',
      model: 'gpt',
      hook_trust: 'native',
    };
    runs[1]!.selection.agent = {
      ...runs[0]!.selection.agent,
      hook_trust: 'automation',
    };
    const report = build(runs);
    assert.equal(report.cases.length, 2);
    assert.deepEqual(
      report.cases.map(({ agent }) => agent.hook_trust),
      ['native', 'automation'],
    );
    assert.deepEqual(parseExperimentRunReport(report), report);
  });

  it('rejects former judging counter and score aggregate fields', () => {
    const report = build([row(0)]);
    assert.throws(() =>
      parseExperimentRunReport({
        ...report,
        summary: {
          ...report.summary,
          guideline_score: report.summary.judging_score,
        },
      }),
    );
    const { judging_score, ...summary } = report.summary;
    assert.throws(() =>
      parseExperimentRunReport({
        ...report,
        summary: { ...summary, guideline_score: judging_score },
      }),
    );
    for (const former of ['guidelines_passed', 'guidelines_total']) {
      assert.throws(() =>
        parseExperimentRunReport({
          ...report,
          runs: [
            {
              ...report.runs[0],
              evaluation: { ...report.runs[0]!.evaluation, [former]: 0 },
            },
          ],
        }),
      );
    }
  });
  it('groups repetitions by exact case/treatment/agent coordinates and separates execution coverage from scores', () => {
    const runs = [row(0), row(1), row(2), row(3), row(4), row(5)];
    runs[0]!.evaluation = evaluation(2, 2, 'passed');
    runs[1]!.evaluation = evaluation(1, 2, 'partial');
    runs[2]!.evaluation = evaluation(0, 2, 'failed');
    runs[3]!.selection.treatment = 'other';
    runs[4]!.selection.agent.model = 'other-model';
    runs[4]!.state = 'errored';
    runs[4]!.evaluation = null;
    runs[4]!.error_code = 'agent_failed';
    runs[4]!.result_path = null;
    runs[4]!.attempt_count = 2;
    runs[5]!.selection.case_id = 'testing/second';
    runs[5]!.state = 'pending';
    runs[5]!.run_id = null;
    runs[5]!.evaluation = null;
    runs[5]!.result_path = null;
    runs[5]!.attempt_count = 0;
    const report = build(runs);
    assert.deepEqual(report.summary, {
      selections: 6,
      completed: 4,
      errored: 1,
      pending: 1,
      passed: 2,
      partial: 1,
      failed: 1,
      attempts_total: 6,
      retry_attempts: 1,
      coverage: 4 / 6,
      pass_rate: 0.5,
      judging_score: { mean: 0.5, evaluations: 3 },
    });
    assert.equal(report.cases.length, 4);
    assert.equal(report.cases[0]!.selections, 3);
    assert.equal(report.cases[0]!.judging_score.mean, 0.5);
    assert.equal(report.cases[1]!.judging_score.mean, null);
    assert.equal(report.cases[2]!.pass_rate, null);
    assert.equal(report.cases[3]!.coverage, 0);
    assert.equal(report.checkpoint_sha256, sha256Digest('{}\n'));
  });

  it('distinguishes adapter, provider and model while preserving the original selection order', () => {
    const runs = [row(0), row(1), row(2), row(3)];
    runs[1]!.selection.agent.adapter = 'other-agent';
    runs[2]!.selection.agent.provider = 'other-provider';
    runs[3]!.selection.agent.model = 'other-model';
    const report = build(runs);
    assert.equal(report.cases.length, 4);
    assert.deepEqual(
      report.runs.map((run) => run.selection_index),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      report.cases.map((group) => group.agent),
      runs.map((run) => run.selection.agent),
    );
  });

  it('uses status for checks-only pass rates and leaves criterion means unavailable', () => {
    const failed = row(1);
    failed.evaluation = { ...evaluation(0, 0, 'failed'), checks_passed: 0 };
    const report = build([row(0), failed]);
    assert.equal(report.summary.pass_rate, 0.5);
    assert.deepEqual(report.summary.judging_score, {
      mean: null,
      evaluations: 0,
    });
    assert.equal(report.runs[0]!.evaluation!.score, 0);
    assert.equal(report.runs[0]!.evaluation!.checks_passed, 1);
  });

  it('rejects unknown fields, false aggregates and invalid run references', () => {
    const report = build([row(0)]);
    for (const mutate of [
      (value: typeof report) => {
        Object.assign(value, { schema_version: 1 });
      },
      (value: typeof report) => {
        Object.assign(value, { transcript: 'not scorecard data' });
      },
      (value: typeof report) => {
        value.summary.passed = 0;
      },
      (value: typeof report) => {
        value.cases[0]!.agent.model = 'different';
      },
      (value: typeof report) => {
        value.runs[0]!.selection_index = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.result_path = '../other/result.json';
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation = null;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.checks_passed = 2;
      },
      (value: typeof report) => {
        Object.assign(value.runs[0]!, { extra: true });
      },
      (value: typeof report) => {
        Object.assign(value.runs[0]!.evaluation!, { extra: true });
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.judging_criteria_passed = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.error_code = 'execution_error';
      },
      (value: typeof report) => {
        value.runs[0]!.state = 'errored';
      },
      (value: typeof report) => {
        value.runs[0]!.state = 'pending';
        value.runs[0]!.run_id = null;
      },
      (value: typeof report) => {
        value.runs[0]!.run_id = '../unsafe';
        value.runs[0]!.result_path = 'runs/../unsafe/result.json';
      },
    ]) {
      const changed = structuredClone(report);
      mutate(changed);
      assert.throws(() => parseExperimentRunReport(changed));
    }
    assert.deepEqual(parseExperimentRunReport(report), report);
    const duplicate = build([row(0), row(1)]);
    duplicate.runs[1]!.run_id = duplicate.runs[0]!.run_id;
    duplicate.runs[1]!.result_path = duplicate.runs[0]!.result_path;
    assert.throws(
      () => parseExperimentRunReport(duplicate),
      /duplicate run IDs/,
    );
  });

  it('writes partial results after execution errors and refreshes only latest attempts on resume', async () => {
    const fixture = await experimentRunFixture();
    let fail = true;
    let verified = 0;
    fixture.options.engine = {
      ...defaultForgeEngine,
      async verifyCompletedRun(location) {
        verified += 1;
        return defaultForgeEngine.verifyCompletedRun(location);
      },
    };
    fixture.options.execute = async (input) => {
      if (fail && input.plan.selection.case_id === 'testing/second')
        throw new Error('private execution failure');
      return defaultForgeEngine.executeEval({
        ...input,
        composition: composition(fixture.root),
      });
    };
    const first = await runExperiment(fixture.options);
    const report = await readReport(first.report);
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.errored, 1);
    assert.equal(report.summary.pass_rate, 1);
    assert.equal(report.summary.coverage, 0.5);
    assert.equal(report.runs[1]!.error_code, 'execution_error');
    assert.equal(report.runs[1]!.evaluation, null);
    assert.equal(
      JSON.stringify(report).includes('private execution failure'),
      false,
    );
    assert.equal(
      report.checkpoint_sha256,
      sha256Digest(await fs.readFile(first.checkpoint)),
    );
    assert.equal(verified, 2, 'report reuses each latest attempt verification');
    const previousResult = await fs.readFile(
      path.join(fixture.root, report.runs[0]!.result_path!),
    );
    fail = false;
    const resumed = await runExperiment({ ...fixture.options, resume: true });
    const refreshed = await readReport(resumed.report);
    assert.equal(resumed.executed, 1);
    assert.equal(refreshed.summary.completed, 2);
    assert.equal(refreshed.summary.errored, 0);
    assert.equal(refreshed.summary.attempts_total, 3);
    assert.equal(refreshed.summary.retry_attempts, 1);
    assert.deepEqual(
      refreshed.runs.map((run) => run.attempt_count),
      [1, 2],
    );
    assert.equal(refreshed.runs[0]!.run_id, report.runs[0]!.run_id);
    assert.notEqual(refreshed.runs[1]!.run_id, report.runs[1]!.run_id);
    assert.deepEqual(
      await fs.readFile(
        path.join(fixture.root, refreshed.runs[0]!.result_path!),
      ),
      previousResult,
    );
    assert.equal(
      refreshed.checkpoint_sha256,
      sha256Digest(await fs.readFile(resumed.checkpoint)),
    );
  });

  it('regenerates missing or corrupt reports on a no-op resume without changing eval artifacts', async () => {
    const fixture = await experimentRunFixture();
    const first = await runExperiment(fixture.options);
    const report = await readReport(first.report);
    const checkpoint = await fs.readFile(first.checkpoint);
    for (const corrupt of [false, true]) {
      if (corrupt) await fs.writeFile(first.report, '{invalid report');
      else await fs.rm(first.report);
      const resumed = await runExperiment({
        ...fixture.options,
        resume: true,
        execute: async () => {
          throw new Error('must skip completed evals');
        },
      });
      assert.equal(resumed.executed, 0);
      const restored = await readReport(resumed.report);
      assert.deepEqual(restored.runs, report.runs);
      assert.deepEqual(restored.summary, report.summary);
      assert.deepEqual(await fs.readFile(first.checkpoint), checkpoint);
    }
  });

  it('extracts criterion and check scores from real engine commits and averages repetitions', async () => {
    const fixture = await experimentRunFixture();
    const plan = createTestResolvedRunPlan({
      caseId: 'testing/criteria',
      judgingCriteria: [
        { value: 'The answer is complete.', label: 'correctness' },
        { value: 'Read docs', label: 'source', include_in_score: false },
      ],
      judge: { provider: 'scripted', model: 'judge' },
      checks: { file_checks: [{ file: 'missing.txt', exists: true }] },
    });
    const repeated = structuredClone(plan);
    repeated.selection.repetition = 1;
    fixture.options.plans = [
      plan,
      defaultForgeEngine.parseResolvedRunPlan(repeated),
    ];
    fixture.options.execute = (input) => {
      const passed = input.plan.selection.repetition === 0;
      const provider = createScriptedCompletionProvider({
        id: 'scripted',
        responses: [
          JSON.stringify({
            results: [{ index: 0, passed, explanation: 'Scripted judgment.' }],
          }),
          JSON.stringify({
            results: [
              { index: 0, passed: !passed, explanation: 'Source observation.' },
            ],
          }),
        ],
      }).provider;
      return defaultForgeEngine.executeEval({
        ...input,
        composition: {
          ...composition(fixture.root),
          completionProviders: new Map([[provider.id, provider]]),
        },
      });
    };
    const provider = createScriptedCompletionProvider({
      id: 'scripted',
    }).provider;
    fixture.options.composition = {
      ...composition(fixture.root),
      completionProviders: new Map([[provider.id, provider]]),
    };
    const summary = await runExperiment(fixture.options);
    const report = await readReport(summary.report);
    assert.equal(report.summary.completed, 2);
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0]!.selections, 2);
    assert.deepEqual(report.summary.judging_score, {
      mean: 0.5,
      evaluations: 2,
    });
    assert.equal(report.summary.pass_rate, 0);
    assert.deepEqual(
      report.runs.map((run) => run.evaluation),
      [
        {
          status: 'partial',
          score: 1,
          judging_criteria_passed: 1,
          judging_criteria_total: 1,
          checks_passed: 0,
          checks_total: 1,
        },
        {
          status: 'failed',
          score: 0,
          judging_criteria_passed: 0,
          judging_criteria_total: 1,
          checks_passed: 0,
          checks_total: 1,
        },
      ],
    );
  });

  it('writes a cancellation report after cleanup, including cases that never started', async () => {
    const fixture = await experimentRunFixture();
    fixture.options.plans = [
      ...fixture.options.plans,
      createTestResolvedRunPlan({ caseId: 'testing/third' }),
    ];
    const controller = new AbortController();
    fixture.options.signal = controller.signal;
    let cleaned = false;
    fixture.options.execute = async (input) => {
      if (input.plan.selection.case_id === 'testing/first') {
        return defaultForgeEngine.executeEval({
          ...input,
          composition: composition(fixture.root),
        });
      }
      controller.abort(new Error('cancelled by test'));
      try {
        input.signal!.throwIfAborted();
        throw new Error('unreachable');
      } finally {
        cleaned = true;
      }
    };
    await assert.rejects(runExperiment(fixture.options), /cancelled by test/);
    assert.equal(cleaned, true);
    const report = await readReport(path.join(fixture.root, 'report.json'));
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.errored, 1);
    assert.equal(report.summary.pending, 1);
    assert.equal(report.runs[1]!.error_code, 'aborted');
    assert.equal(report.runs[2]!.run_id, null);
    await assert.rejects(fs.stat(path.join(fixture.root, '.experiment.lock')), {
      code: 'ENOENT',
    });
  });

  it('atomically preserves the previous report on write failure and retains completed evals', async () => {
    const fixture = await experimentRunFixture();
    const first = await runExperiment(fixture.options);
    const previous = await fs.readFile(first.report);
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof rename>) => {
        if (args[1] === first.report)
          throw new Error('private filesystem detail');
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runExperiment({ ...fixture.options, resume: true }),
        (error) => {
          assert.ok(error instanceof ExperimentRunReportError);
          assert.equal(error.report, first.report);
          assert.equal(
            error.message.includes('private filesystem detail'),
            false,
          );
          return true;
        },
      );
      assert.deepEqual(await fs.readFile(first.report), previous);
      assert.equal(
        (await fs.readdir(fixture.root)).some((name) => name.endsWith('.tmp')),
        false,
      );
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    const resumed = await runExperiment({ ...fixture.options, resume: true });
    assert.equal(resumed.executed, 0);
  });

  it('holds the experiment run lock through report persistence and rejects late cancellation', async () => {
    const fixture = await experimentRunFixture();
    const controller = new AbortController();
    fixture.options.signal = controller.signal;
    const rename = fsPromises.rename;
    const reportPath = path.join(fixture.root, 'report.json');
    let blocked = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof rename>) => {
        if (args[1] === reportPath) {
          await assert.rejects(
            runExperiment({
              ...fixture.options,
              resume: true,
              signal: new AbortController().signal,
            }),
            /Another experiment run process/,
          );
          blocked = true;
          controller.abort(new Error('cancelled while writing report'));
        }
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runExperiment(fixture.options),
        /cancelled while writing report/,
      );
      assert.equal(blocked, true);
      assert.equal((await readReport(reportPath)).summary.completed, 2);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('preserves a coordinator failure even when writing its partial report also fails', async () => {
    const fixture = await experimentRunFixture();
    const original = new Error('primary callback failure');
    fixture.options.progress = (event) => {
      if (event.state === 'started') throw original;
    };
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof rename>) => {
        if (args[1] === path.join(fixture.root, 'report.json'))
          throw new Error('secondary report failure');
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runExperiment(fixture.options),
        (error) => error === original,
      );
      await assert.rejects(
        fs.stat(path.join(fixture.root, '.experiment.lock')),
        { code: 'ENOENT' },
      );
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
});

function evaluation(
  passed: number,
  total: number,
  status: 'passed' | 'partial' | 'failed',
) {
  return {
    status,
    score: total === 0 ? 0 : passed / total,
    judging_criteria_passed: passed,
    judging_criteria_total: total,
    checks_passed: 1,
    checks_total: 1,
  };
}
function row(index: number): ExperimentRunReportRunV1 {
  const selection = structuredClone(
    createTestResolvedRunPlan({ caseId: 'testing/first' }).selection,
  );
  selection.repetition = index;
  return {
    selection_index: index,
    selection,
    run_id: `run-${index}`,
    state: 'completed',
    error_code: null,
    attempt_count: 1,
    result_path: `runs/run-${index}/result.json`,
    evaluation: evaluation(0, 0, 'passed'),
  };
}
function build(runs: ExperimentRunReportRunV1[]) {
  return buildExperimentRunReport({
    experimentRunId: 'test-report',
    generatedAt: '2026-10-02T00:00:00.000Z',
    checkpointBody: '{}\n',
    runs,
  });
}
async function readReport(location: string) {
  return parseExperimentRunReport(
    JSON.parse(await fs.readFile(location, 'utf8')),
  );
}
function composition(root: string) {
  const agent = createScriptedAgentAdapter().adapter;
  return {
    runtime: createFakeRuntimeAdapter().adapter,
    agents: new Map([[agent.id, agent]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({ root }),
  };
}
async function experimentRunFixture() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-scorecards-'),
  );
  temporaryDirectories.push(temporary);
  const root = path.join(temporary, 'experiment');
  let nextId = 0;
  const options: MutableExperimentRunOptions = {
    root,
    plans: ['first', 'second'].map((id) =>
      createTestResolvedRunPlan({ caseId: `testing/${id}` }),
    ),
    composition: composition(root),
    engine: defaultForgeEngine,
    resume: false,
    signal: new AbortController().signal,
    progress: () => undefined,
    runIdFactory: () => `attempt-${++nextId}`,
    execute: (input) =>
      defaultForgeEngine.executeEval({
        ...input,
        composition: composition(root),
      }),
  };
  return { root, options };
}
