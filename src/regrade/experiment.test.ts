import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { defaultForgeEngine } from '../engine.ts';
import { scoreEvaluation } from '../evaluation/score.ts';
import { parseExperimentRunReport } from '../experimentReport.ts';
import { CompletionInvocationError } from '../contracts/completion.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  type ScriptedCompletionStep,
} from '../testing/index.ts';
import {
  ORIGINAL_JUDGMENT,
  runJudgedFixture,
  temporaryRoot,
} from './__tests__/judgedFixture.ts';
import { REGRADE_SUMMARY_FORMAT, regradeExperimentRun } from './experiment.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const failingJudgment = JSON.stringify({
  results: [{ index: 0, passed: false, explanation: 'Not shown.' }],
});

function dependencies(responses: ScriptedCompletionStep[]) {
  const scripted = createScriptedCompletionProvider({
    id: 'anthropic',
    responses,
  });
  return {
    scripted,
    dependencies: {
      completionProviders: new Map([['anthropic', scripted.provider]]),
      credentialResolver: createStaticCredentialResolver(),
    },
  };
}

describe('regradeExperimentRun', () => {
  it('regrades completed runs into a separate report and reuses them on rerun', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade-opus');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    const first = dependencies([failingJudgment]);
    const summary = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      first.dependencies,
    );
    assert.equal(summary.format, REGRADE_SUMMARY_FORMAT);
    assert.equal(summary.regraded, 1);
    assert.equal(summary.reused, 0);
    assert.deepEqual(summary.failed, []);
    assert.equal(first.scripted.calls.length, 1);

    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(report.summary.completed, 1);
    assert.equal(report.runs[0]!.evaluation!.score, 0);
    assert.equal(
      report.runs[0]!.result_path,
      'runs/regrade-source/result.json',
    );
    // regrade_path (under the report's directory) holds the evaluation behind the row's score;
    // result_path (under result_root, the source run) keeps the original execution for provenance.
    assert.equal(report.runs[0]!.regrade_path, 'runs/regrade-source.json');
    assert.equal(
      report.result_root,
      await fs.realpath(source.experimentLocation),
    );
    const saved = JSON.parse(
      await fs.readFile(
        path.join(output, report.runs[0]!.regrade_path!),
        'utf8',
      ),
    );
    assert.deepEqual(saved.judge, judge);
    assert.equal(saved.evaluation.score, report.runs[0]!.evaluation!.score);
    assert.equal(saved.source.original_evaluation.score, 1);
    const original = JSON.parse(
      await fs.readFile(
        path.join(report.result_root!, report.runs[0]!.result_path!),
        'utf8',
      ),
    );
    assert.equal(original.evaluation.score, 1);
    await assert.rejects(fs.access(path.join(output, '.regrade.lock')));
    assert.ok(
      saved.completion_calls.every(
        (call: { purpose: string }) => call.purpose === 'judge',
      ),
    );
    assert.equal(
      report.runs[0]!.rate_limit_wait_ms,
      saved.completion_call_totals.rate_limit_wait_ms,
    );
    assert.equal(report.summary.rate_limit_wait_ms, 0);

    // A rerun with the same judge reuses the saved regrade without judge calls.
    const second = dependencies([]);
    const rerun = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      second.dependencies,
    );
    assert.equal(rerun.reused, 1);
    assert.equal(rerun.regraded, 0);
    assert.equal(second.scripted.calls.length, 0);

    // Reusing a legacy regrade cannot invent a measured wait total.
    delete saved.completion_call_totals;
    await fs.writeFile(
      path.join(output, 'runs', 'regrade-source.json'),
      JSON.stringify(saved),
    );
    const legacy = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      second.dependencies,
    );
    assert.equal(legacy.reused, 1);
    const legacyReport = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(legacyReport.runs[0]!.rate_limit_wait_ms, undefined);
    assert.equal(legacyReport.summary.rate_limit_wait_ms, undefined);
    assert.equal(second.scripted.calls.length, 0);

    // The source experiment run is untouched and still has its original score.
    const sourceReport = parseExperimentRunReport(
      JSON.parse(
        await fs.readFile(
          path.join(source.experimentLocation, 'report.json'),
          'utf8',
        ),
      ),
    );
    assert.equal(sourceReport.runs[0]!.evaluation!.score, 1);
  });

  it('refuses to mix judges in one output and leaves that run unscored', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        output,
      },
      dependencies([ORIGINAL_JUDGMENT]).dependencies,
    );
    const other = dependencies([ORIGINAL_JUDGMENT]);
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        output,
      },
      other.dependencies,
    );
    assert.equal(other.scripted.calls.length, 0);
    assert.equal(summary.failed.length, 1);
    assert.match(summary.failed[0]!.message, /different judge/);
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(report.runs[0]!.state, 'pending');
  });

  it('refuses a second regrade writing to the same output at the same time', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    const a = dependencies([failingJudgment]);
    const b = dependencies([ORIGINAL_JUDGMENT]);
    const results = await Promise.allSettled([
      regradeExperimentRun(
        { experimentRun: source.experimentLocation, judge, output },
        a.dependencies,
      ),
      regradeExperimentRun(
        {
          experimentRun: source.experimentLocation,
          judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          output,
        },
        b.dependencies,
      ),
    ]);
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(refused.length, 1);
    assert.match(
      String((refused[0] as PromiseRejectedResult).reason),
      /Another regrade is writing to/,
    );
    // Every output file describes the one invocation that held the lock.
    const winner = (
      results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof regradeExperimentRun>>
      >
    ).value;
    const saved = JSON.parse(
      await fs.readFile(
        path.join(output, 'runs', 'regrade-source.json'),
        'utf8',
      ),
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(output, 'regrade.json'), 'utf8'),
    );
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.deepEqual(saved.judge, winner.judge);
    assert.deepEqual(summary.judge, winner.judge);
    assert.equal(report.runs[0]!.evaluation!.score, saved.evaluation.score);
    assert.equal(a.scripted.calls.length + b.scripted.calls.length, 1);
    await assert.rejects(fs.access(path.join(output, '.regrade.lock')));
  });

  it('rejects an output inside the source experiment run before any work', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const scripted = dependencies([ORIGINAL_JUDGMENT]);
    await assert.rejects(
      regradeExperimentRun(
        {
          experimentRun: source.experimentLocation,
          judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          output: path.join(source.experimentLocation, 'regrades'),
        },
        scripted.dependencies,
      ),
      /outside the source experiment run/,
    );
    assert.equal(scripted.scripted.calls.length, 0);
  });

  it('reports the regrade judge calls and measured rate-limit waits', async () => {
    const root = await temporaryRoot('forge-regrade-wait-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade-waits');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    const limited = dependencies([
      new CompletionInvocationError('http_error', 'Rate limited', {
        origin: 'host_transport',
        http_status: 429,
        retry_after_ms: 3000,
      }),
      failingJudgment,
    ]);
    let elapsed = 0;
    await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge,
        output,
        completionRetry: {
          now: () => elapsed,
          random: () => 1,
          sleep: async (ms) => {
            elapsed += ms;
          },
        },
      },
      limited.dependencies,
    );
    const saved = JSON.parse(
      await fs.readFile(
        path.join(output, 'runs', 'regrade-source.json'),
        'utf8',
      ),
    );
    assert.deepEqual(saved.completion_calls[0].retry, {
      decision: 'rate_limit_retry',
      wait_ms: 3000,
    });
    assert.equal(saved.completion_call_totals.rate_limit_wait_ms, 3000);
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(report.runs[0]!.rate_limit_wait_ms, 3000);
    assert.equal(report.summary.rate_limit_wait_ms, 3000);
  });

  it('reports no wait for runs without judging criteria, whatever the source run waited', async () => {
    const root = await temporaryRoot('forge-regrade-notjudged-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const unjudged = {
      ...defaultForgeEngine,
      async verifyCompletedRun(location: string) {
        const completed = await defaultForgeEngine.verifyCompletedRun(location);
        return {
          ...completed,
          result: {
            ...completed.result,
            evaluation: scoreEvaluation([], completed.result.evaluation.checks),
            completion_call_totals: {
              calls: 3,
              failed: 2,
              omitted: 0,
              rate_limit_wait_ms: 9000,
            },
          },
        };
      },
    };
    const output = path.join(root, 'regrade-unjudged');
    const none = dependencies([]);
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        output,
      },
      { ...none.dependencies, engine: unjudged },
    );
    assert.equal(summary.not_judged, 1);
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(report.runs[0]!.rate_limit_wait_ms, undefined);
    assert.equal(report.summary.rate_limit_wait_ms, undefined);
  });
});
