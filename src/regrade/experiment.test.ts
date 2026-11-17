import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { credentialReference } from '../contracts/credentials.ts';
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

/** The parts of a saved regrade the corruption cases edit. */
interface SavedRegrade {
  forge?: { version: string };
  extra?: boolean;
  source: { result_sha256: string };
  evaluation: {
    judging_criteria: { criterion: string }[] | null;
    checks: { passed: unknown }[] | null;
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
  });

  it('rejects an output holding another judge before any call or write', async () => {
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
    const before = await snapshotTree(output);
    const other = dependencies([ORIGINAL_JUDGMENT]);
    await assert.rejects(
      regradeExperimentRun(
        {
          experimentRun: source.experimentLocation,
          judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          output,
        },
        other.dependencies,
      ),
      /already holds regrades from a different judge/,
    );
    assert.equal(other.scripted.calls.length, 0);
    assert.deepEqual(await snapshotTree(output), before);
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

  it.each([
    ['provider preflight', 'preflight'],
    ['credential resolver', 'resolver'],
  ] as const)('does not persist a credential from a failing %s', async (_name, failing) => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    const key = 'synthetic-judge-key-4f9c2a71';
    const scripted = createScriptedCompletionProvider({
      id: 'anthropic',
      responses: [ORIGINAL_JUDGMENT],
      requirements: {
        credentials: { token: { reference: credentialReference('judge.key') } },
      },
      preflight: () => {
        throw new Error(`Rejected key ${key}.`);
      },
    });
    const staticResolver = createStaticCredentialResolver({
      'judge.key': key,
    });
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        output,
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver:
          failing === 'preflight'
            ? staticResolver
            : {
                async resolve() {
                  throw new Error(`Vault refused ${key}.`);
                },
              },
      },
    );
    assert.equal(summary.failed.length, 1);
    assert.equal(scripted.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(key));
    assert.doesNotMatch(
      await fs.readFile(path.join(output, 'regrade.json'), 'utf8'),
      new RegExp(key),
    );
  });

  it.each([
    [
      'a missing producer',
      (saved: SavedRegrade) => {
        delete saved.forge;
      },
    ],
    [
      'an incompatible producer',
      (saved: SavedRegrade) => {
        saved.forge!.version = '0.0.1';
      },
    ],
    [
      'an extra field',
      (saved: SavedRegrade) => {
        saved.extra = true;
      },
    ],
    [
      'a criterion changed from the source',
      (saved: SavedRegrade) => {
        saved.evaluation.judging_criteria![0]!.criterion =
          'The release summary must say something else.';
      },
    ],
    [
      'a wrongly typed check result',
      (saved: SavedRegrade) => {
        saved.evaluation.checks![0]!.passed = 'false';
      },
    ],
    [
      'checks that differ from the source',
      (saved: SavedRegrade) => {
        saved.evaluation.checks = [];
      },
    ],
    [
      'null evaluation arrays',
      (saved: SavedRegrade) => {
        saved.evaluation.judging_criteria = null;
        saved.evaluation.checks = null;
      },
    ],
    [
      'a different source result',
      (saved: SavedRegrade) => {
        saved.source.result_sha256 = `sha256:${'0'.repeat(64)}`;
      },
    ],
  ])('fails only the run whose saved regrade has %s, without judge calls', async (_name, mutate) => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      dependencies([failingJudgment]).dependencies,
    );
    const file = path.join(output, 'runs', 'regrade-source.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(saved.evaluation.checks!.length > 0);
    mutate(saved);
    await fs.writeFile(file, JSON.stringify(saved));
    const rerun = dependencies([failingJudgment]);
    const summary = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      rerun.dependencies,
    );
    assert.equal(summary.reused, 0);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0]!.run_id, 'regrade-source');
    assert.equal(rerun.scripted.calls.length, 0);
  });

  it('rejects an existing output/runs symlink into the source before any work', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    await fs.mkdir(output);
    // The output itself is outside the source, but its runs directory is a
    // physical alias of one committed run.
    await fs.symlink(source.runLocation, path.join(output, 'runs'));
    const before = await snapshotTree(source.experimentLocation);
    const scripted = dependencies([ORIGINAL_JUDGMENT]);
    await assert.rejects(
      regradeExperimentRun(
        {
          experimentRun: source.experimentLocation,
          judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          output,
        },
        scripted.dependencies,
      ),
      /outside the source experiment run/,
    );
    assert.equal(scripted.scripted.calls.length, 0);
    assert.deepEqual(await snapshotTree(source.experimentLocation), before);
  });
});

/** Relative path to content digest of every file under a directory. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else
        snapshot[path.relative(root, entryPath)] = (
          await fs.readFile(entryPath)
        ).toString('base64');
    }
  };
  await visit(root);
  return snapshot;
}
