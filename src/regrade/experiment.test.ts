import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { defaultForgeEngine } from '../engine.ts';
import { parseExperimentRunReport } from '../experimentReport.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
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

function dependencies(responses: string[]) {
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
  it('uses worker-verified source data without a serial report verification pass', async () => {
    const root = await temporaryRoot('forge-regrade-verify-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    let verifications = 0;
    const deps = dependencies([failingJudgment]);
    const engine = {
      ...defaultForgeEngine,
      async verifyCompletedRun(location: string) {
        verifications += 1;
        return defaultForgeEngine.verifyCompletedRun(location);
      },
    };
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        output: path.join(root, 'regrade'),
      },
      { ...deps.dependencies, engine },
    );
    assert.deepEqual(summary.failed, []);
    assert.equal(summary.regraded, 1);
    assert.equal(verifications, 2); // Source inspection and regrade worker, with no third report pass.
  });

  it('regrades completed runs into a separate report and reuses them on rerun', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const log = path.join(source.experimentLocation, 'events.jsonl');
    const events = await fs.readFile(log);
    assert.ok(events.byteLength > 0);
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
    const saved = JSON.parse(
      await fs.readFile(
        path.join(output, 'runs', 'regrade-source.json'),
        'utf8',
      ),
    );
    assert.deepEqual(saved.judge, judge);
    assert.equal(saved.source.original_evaluation.score, 1);

    // A rerun with the same judge reuses the saved regrade without judge calls.
    const second = dependencies([]);
    const rerun = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      second.dependencies,
    );
    assert.equal(rerun.reused, 1);
    assert.equal(rerun.regraded, 0);
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
    assert.deepEqual(await fs.readFile(log), events);
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
});
