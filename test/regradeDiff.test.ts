import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { scoreEvaluation } from '../src/evaluation/score.ts';
import {
  ORIGINAL_JUDGMENT,
  runJudgedFixture,
  temporaryRoot,
} from '../src/regrade/__tests__/judgedFixture.ts';
import {
  diffRegradeExperimentRun,
  type RegradeDiff,
  regradeExperimentRun,
} from '../src/regrade/index.ts';
import type { RegradeResultV1 } from '../src/regrade/run.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../src/testing/index.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(judgment = ORIGINAL_JUDGMENT) {
  const root = await temporaryRoot('forge-regrade-diff-');
  roots.push(root);
  const source = await runJudgedFixture(root);
  const output = path.join(root, 'regrade');
  const scripted = createScriptedCompletionProvider({
    id: 'anthropic',
    responses: [judgment],
  });
  await regradeExperimentRun(
    {
      experimentRun: source.experimentLocation,
      output,
      judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
    {
      completionProviders: new Map([['anthropic', scripted.provider]]),
      credentialResolver: createStaticCredentialResolver(),
    },
  );
  return {
    root,
    source,
    output,
    file: path.join(output, 'runs', 'regrade-source.json'),
  };
}

async function invoke(argv: string[], cwd?: string) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    ...(cwd === undefined ? {} : { cwd }),
    compositionFactory: async () => {
      throw new Error(
        'Diff must not construct a runtime or look up credentials.',
      );
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('regrade diff', () => {
  it('gives full agreement for the same scripted judge without changing saved files', async () => {
    const { source, output, file } = await fixture();
    const sourceFile = path.join(source.runLocation, 'result.json');
    const before = await Promise.all([
      fs.readFile(sourceFile, 'utf8'),
      fs.readFile(file, 'utf8'),
    ]);
    const diff = await diffRegradeExperimentRun({
      experimentRun: source.experimentLocation,
      regrade: output,
    });
    assert.deepEqual(diff.agreement, { matched: 1, total: 1, rate: 1 });
    assert.deepEqual(diff.agreement_by_requirement.SHOULD, diff.agreement);
    assert.equal(diff.mean_score_change, 0);
    assert.deepEqual(diff.flipped_criteria, []);
    assert.deepEqual(diff.judge_errors, []);
    assert.deepEqual(diff.missing_regrades, []);
    assert.deepEqual(
      await Promise.all([
        fs.readFile(sourceFile, 'utf8'),
        fs.readFile(file, 'utf8'),
      ]),
      before,
    );
  });

  it('prints divergent verdicts as text and JSON with relative paths and no host composition', async () => {
    const { root, source, output } = await fixture(
      JSON.stringify({
        results: [
          {
            index: 0,
            passed: false,
            explanation: 'The required status is absent.',
          },
        ],
      }),
    );
    const args = [
      'regrade',
      'diff',
      '--experiment-run',
      path.relative(root, source.experimentLocation),
      '--regrade',
      path.relative(root, output),
    ];
    const json = await invoke([...args, '--json'], root);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, '');
    const diff = JSON.parse(json.stdout) as RegradeDiff;
    assert.deepEqual(diff.agreement, { matched: 0, total: 1, rate: 0 });
    assert.equal(diff.mean_score_change, -1);
    assert.deepEqual(diff.runs, [
      {
        run_id: 'regrade-source',
        source_score: 1,
        regrade_score: 0,
        score_change: -1,
      },
    ]);
    assert.deepEqual(
      diff.flipped_criteria.map((criterion) => [
        criterion.criterion_index,
        criterion.source_passed,
        criterion.regrade_passed,
      ]),
      [[0, true, false]],
    );
    const text = await invoke(args, root);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Verdict agreement: 0\/1 \(0.0%\)/);
    assert.match(text.stdout, /SHOULD: 0\/1/);
    assert.match(text.stdout, /Mean score change.*: -1/);
    assert.match(text.stdout, /regrade-source: 1 -> 0/);
    assert.match(text.stdout, /Flipped criteria: 1/);
    assert.match(text.stdout, /true -> false/);
  });

  it('prints a saved judge error without calling a model or counting it as a flip', async () => {
    const { source, output, file } = await fixture();
    const saved = JSON.parse(
      await fs.readFile(file, 'utf8'),
    ) as RegradeResultV1;
    const evaluation = scoreEvaluation(
      saved.evaluation.judging_criteria.map((criterion) => ({
        ...criterion,
        passed: null,
        error: {
          type: 'request_error',
          attempts: 3,
          message: 'Judge unavailable.',
        },
      })),
      saved.evaluation.checks,
    );
    await fs.writeFile(file, JSON.stringify({ ...saved, evaluation }));
    const result = await invoke([
      'regrade',
      'diff',
      '--experiment-run',
      source.experimentLocation,
      '--regrade',
      output,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Verdict agreement: 0\/0 \(n\/a\)/);
    assert.match(result.stdout, /Mean score change.*: n\/a/);
    assert.match(result.stdout, /Flipped criteria: 0/);
    assert.match(result.stdout, /Judge errors: 1/);
    assert.match(
      result.stdout,
      /regrade regrade-source \[0\].*request_error: "Judge unavailable\."/,
    );
  });

  it('shows a missing regrade without treating its criteria as matches', async () => {
    const { source, output, file } = await fixture();
    await fs.rm(file);
    const result = await invoke([
      'regrade',
      'diff',
      '--experiment-run',
      source.experimentLocation,
      '--regrade',
      output,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Verdict agreement: 0\/0 \(n\/a\)/);
    assert.match(result.stdout, /Missing regrades: 1\nregrade-source/);
  });

  it('rejects stale, malformed and unrelated saved regrades', async () => {
    const { source, output, file } = await fixture();
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    const load = () =>
      diffRegradeExperimentRun({
        experimentRun: source.experimentLocation,
        regrade: output,
      });
    for (const [changed, pattern] of [
      [
        {
          ...original,
          source: { ...original.source, result_sha256: 'c'.repeat(64) },
        },
        /digest does not match/,
      ],
      [{ ...original, format: 'unknown' }, /unknown format/],
      [
        { ...original, evaluation: { ...original.evaluation, score: 2 } },
        /Evaluation score and status do not match/,
      ],
    ] as const) {
      await fs.writeFile(file, JSON.stringify(changed));
      await assert.rejects(load(), pattern);
    }
    await fs.rm(file);
    await fs.writeFile(
      path.join(output, 'runs', 'other.json'),
      JSON.stringify({ ...original, run_id: 'other' }),
    );
    await assert.rejects(load(), /no completed source run/);
  });

  it('rejects missing options, extra arguments and model options as usage errors', async () => {
    for (const args of [
      ['regrade', 'diff'],
      ['regrade', 'diff', '--experiment-run', '/missing'],
      ['regrade', 'diff', 'extra'],
      ['regrade', 'diff', '--judge-model', 'example'],
      ['plan', '--json'],
      ['regrade', '--regrade', '/missing'],
    ]) {
      const result = await invoke(args);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, '');
    }
  });
});
