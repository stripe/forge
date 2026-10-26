import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { defaultForgeEngine } from '../src/engine.ts';
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
import { MAX_REGRADE_READ_BYTES } from '../src/regrade/read.ts';
import type { RegradeResultV1 } from '../src/regrade/run.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../src/testing/index.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
        source_status: 'passed',
        regrade_status: 'partial',
        status_changed: true,
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
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /Verdict agreement: 0\/0 \(n\/a\)/);
    assert.match(result.stdout, /Mean score change.*: n\/a/);
    assert.match(result.stdout, /Flipped criteria: 0/);
    assert.match(result.stdout, /Judge errors: 1/);
    assert.match(
      result.stdout,
      /regrade regrade-source \[0\].*request_error \(3 attempts\)/,
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
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /Verdict agreement: 0\/0 \(n\/a\)/);
    assert.match(result.stdout, /Missing regrades: 1\nregrade-source/);
  });

  it('reports a damaged completed source even when its regrade is missing', async () => {
    const { source, output, file } = await fixture();
    await fs.rm(file);
    await fs.writeFile(path.join(source.runLocation, 'result.json'), '{}');
    const result = await invoke([
      'regrade',
      'diff',
      '--experiment-run',
      source.experimentLocation,
      '--regrade',
      output,
      '--json',
    ]);
    assert.equal(result.code, 1, result.stderr);
    const diff = JSON.parse(result.stdout) as RegradeDiff;
    assert.equal(diff.coverage, 'incomplete');
    assert.equal(diff.issues[0]!.state, 'invalid');
    assert.equal(diff.issues[0]!.reason, 'source_verification_failed');
    assert.equal(result.stderr, '');
  });

  it('keeps pending and failed execution attempts outside agreement', async () => {
    const { source, output, file } = await fixture();
    await fs.rm(file);
    const checkpointFile = path.join(
      source.experimentLocation,
      'experiment.json',
    );
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    const attempt = checkpoint.entries[0].attempts[0];
    await fs.rm(source.runLocation, { recursive: true });
    for (const [attempts, reason] of [
      [[], 'never_attempted'],
      [[{ run_id: attempt.run_id, state: 'running' }], 'not_committed'],
      [
        [{ ...attempt, state: 'errored', error_code: 'agent_failed' }],
        'execution_error',
      ],
      [
        [{ ...attempt, state: 'errored', error_code: 'invalid_artifacts' }],
        'execution_error',
      ],
    ] as const) {
      checkpoint.entries[0].attempts = attempts;
      await fs.writeFile(checkpointFile, JSON.stringify(checkpoint));
      const result = await invoke([
        'regrade',
        'diff',
        '--experiment-run',
        source.experimentLocation,
        '--regrade',
        output,
        '--json',
      ]);
      assert.equal(result.code, 1, result.stderr);
      const diff = JSON.parse(result.stdout) as RegradeDiff;
      assert.deepEqual(diff.runs, []);
      assert.deepEqual(diff.missing_regrades, []);
      assert.equal(diff.agreement.total, 0);
      assert.equal(diff.issues[0]!.reason, reason);
      assert.equal(
        diff.issues[0]!.state,
        reason === 'execution_error' ? 'errored' : 'pending',
      );
    }
  });

  it('excludes saved judge identities without a nonempty provider and model', async () => {
    const { source, output, file } = await fixture();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const judge of [
      {},
      { provider: 'anthropic' },
      { model: 'example' },
      { provider: '', model: 'example' },
      { provider: 'anthropic', model: '' },
      { provider: 1, model: 'example' },
      { provider: 'anthropic', model: false },
      { provider: 'anthropic', model: '   ' },
      { provider: 'anthropic', model: 'example', extra: true },
      null,
    ]) {
      await fs.writeFile(file, JSON.stringify({ ...saved, judge }));
      const diff = await diffRegradeExperimentRun({
        experimentRun: source.experimentLocation,
        regrade: output,
      });
      assert.equal(diff.coverage, 'incomplete');
      assert.equal(diff.issues[0]!.reason, 'regrade_invalid');
      assert.deepEqual(diff.runs, []);
    }
    const result = await invoke([
      'regrade',
      'diff',
      '--experiment-run',
      source.experimentLocation,
      '--regrade',
      output,
      '--json',
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(
      (JSON.parse(result.stdout) as RegradeDiff).issues[0]!.reason,
      'regrade_invalid',
    );
    assert.equal(result.stderr, '');
  });

  it('reports stale, malformed and unrelated saved regrades', async () => {
    const { source, output, file } = await fixture();
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    const load = () =>
      diffRegradeExperimentRun({
        experimentRun: source.experimentLocation,
        regrade: output,
      });
    for (const [changed, reason] of [
      [
        {
          ...original,
          source: {
            ...original.source,
            result_sha256: `sha256:${'c'.repeat(64)}`,
          },
        },
        'source_digest_mismatch',
      ],
      [{ ...original, format: 'unknown' }, 'regrade_unavailable'],
      [
        { ...original, evaluation: { ...original.evaluation, score: 2 } },
        'evaluation_invalid',
      ],
    ] as const) {
      await fs.writeFile(file, JSON.stringify(changed));
      assert.equal((await load()).issues[0]!.reason, reason);
    }
    await fs.rm(file);
    await fs.writeFile(
      path.join(output, 'runs', 'other.json'),
      JSON.stringify({ ...original, run_id: 'other' }),
    );
    assert.equal((await load()).issues[0]!.reason, 'no_completed_source');
  });

  it('keeps valid pairs when other sources are unfinished, never attempted, failed or corrupt', async () => {
    const { source, output } = await fixture();
    const checkpointFile = path.join(
      source.experimentLocation,
      'experiment.json',
    );
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    const original = checkpoint.entries[0];
    checkpoint.entries.push(
      ...[
        [{ run_id: 'unfinished', state: 'running' }],
        [],
        [{ run_id: 'broken', state: 'completed' }],
        [
          {
            run_id: 'failed',
            state: 'errored',
            error_code: 'invalid_artifacts',
          },
        ],
      ].map((attempts, index) => ({
        ...original,
        selection: { ...original.selection, repetition: index + 1 },
        attempts,
      })),
    );
    await fs.writeFile(checkpointFile, JSON.stringify(checkpoint));
    const args = [
      'regrade',
      'diff',
      '--experiment-run',
      source.experimentLocation,
      '--regrade',
      output,
    ];
    const result = await invoke([...args, '--json']);
    assert.equal(result.code, 1, result.stderr);
    const diff = JSON.parse(result.stdout) as RegradeDiff;
    assert.equal(diff.coverage, 'incomplete');
    assert.deepEqual(
      diff.runs.map((run) => run.run_id),
      ['regrade-source'],
    );
    assert.deepEqual(diff.agreement, { total: 1, matched: 1, rate: 1 });
    assert.deepEqual(
      diff.issues.map((issue) => [
        issue.selection_index,
        issue.run_id,
        issue.state,
        issue.reason,
      ]),
      [
        [1, 'unfinished', 'pending', 'not_committed'],
        [2, null, 'pending', 'never_attempted'],
        [3, 'broken', 'invalid', 'source_verification_failed'],
        [4, 'failed', 'errored', 'execution_error'],
      ],
    );
    const text = await invoke(args);
    assert.equal(text.code, 1);
    assert.match(text.stdout, /Verdict agreement: 1\/1/);
    assert.match(text.stdout, /unfinished: pending \(not_committed\)/);
    assert.match(text.stdout, /selection 2: pending \(never_attempted\)/);
    assert.match(text.stdout, /broken: invalid \(source_verification_failed\)/);
  });

  it('compares a verified commit even when its checkpoint still records running', async () => {
    const { source, output } = await fixture();
    const checkpointFile = path.join(
      source.experimentLocation,
      'experiment.json',
    );
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    checkpoint.entries[0].attempts[0].state = 'running';
    await fs.writeFile(checkpointFile, JSON.stringify(checkpoint));
    const diff = await diffRegradeExperimentRun({
      experimentRun: source.experimentLocation,
      regrade: output,
    });
    assert.equal(diff.coverage, 'complete');
    assert.equal(diff.agreement.rate, 1);
    assert.deepEqual(diff.issues, []);
  });

  it('excludes a source whose checkpoint identity changes during inspection', async () => {
    const { source, output } = await fixture();
    const checkpointFile = path.join(
      source.experimentLocation,
      'experiment.json',
    );
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    const diff = await diffRegradeExperimentRun({
      experimentRun: source.experimentLocation,
      regrade: output,
      engine: {
        ...defaultForgeEngine,
        verifyCompletedRun: async (location) => {
          const completed =
            await defaultForgeEngine.verifyCompletedRun(location);
          checkpoint.entries[0].attempts.push({
            run_id: 'new-attempt',
            state: 'running',
          });
          await fs.writeFile(checkpointFile, JSON.stringify(checkpoint));
          return completed;
        },
      },
    });
    assert.equal(diff.coverage, 'incomplete');
    assert.deepEqual(diff.runs, []);
    assert.equal(diff.agreement.total, 0);
    assert.deepEqual(diff.issues, [
      {
        side: 'source',
        run_id: 'regrade-source',
        selection_index: 0,
        state: 'unavailable',
        reason: 'source_changed',
      },
    ]);
  });

  it('reports unavailable files without printing their contents or raw errors', async () => {
    const { source, output, file } = await fixture();
    const saved = JSON.parse(
      await fs.readFile(file, 'utf8'),
    ) as RegradeResultV1;
    const args = [
      'regrade',
      'diff',
      '--experiment-run',
      source.experimentLocation,
      '--regrade',
      output,
    ];
    await fs.writeFile(file, '{"private":"PRIVATE_PAYLOAD"');
    const malformed = await invoke([...args, '--json']);
    assert.equal(malformed.code, 1);
    assert.equal(malformed.stdout.includes('PRIVATE_PAYLOAD'), false);
    assert.equal(malformed.stderr, '');
    await fs.writeFile(
      file,
      JSON.stringify({
        ...saved,
        evaluation: scoreEvaluation(
          saved.evaluation.judging_criteria.map((criterion) => ({
            ...criterion,
            passed: null,
            error: {
              type: 'request_error',
              attempts: 3,
              message: 'PRIVATE_PAYLOAD',
            },
          })),
          saved.evaluation.checks,
        ),
      }),
    );
    for (const flags of [[], ['--json']]) {
      const result = await invoke([...args, ...flags]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout.includes('PRIVATE_PAYLOAD'), false);
      assert.equal(
        result.stdout.includes(saved.evaluation.judging_criteria[0]!.criterion),
        false,
      );
      assert.equal(result.stderr, '');
    }
    await fs.rm(path.join(output, 'runs'), { recursive: true });
    const unavailable = await diffRegradeExperimentRun({
      experimentRun: source.experimentLocation,
      regrade: output,
    });
    assert.equal(
      unavailable.issues[0]!.reason,
      'regrade_directory_unavailable',
    );
  });

  it('bounds saved reads and refuses symbolic links', async () => {
    const { source, output, file, root } = await fixture();
    await fs.truncate(file, MAX_REGRADE_READ_BYTES + 1);
    const load = () =>
      diffRegradeExperimentRun({
        experimentRun: source.experimentLocation,
        regrade: output,
      });
    assert.equal((await load()).issues[0]!.reason, 'read_limit');
    await fs.rm(file);
    const target = path.join(root, 'private.json');
    await fs.writeFile(target, 'PRIVATE_PAYLOAD');
    await fs.symlink(target, file);
    const diff = await load();
    assert.equal(diff.coverage, 'incomplete');
    assert.equal(JSON.stringify(diff).includes('PRIVATE_PAYLOAD'), false);
  });

  it('bounds the total saved bytes retained for comparison', async () => {
    const { source, output, file } = await fixture();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    for (let index = 0; index < 5; index++) {
      const run_id = `heavy-${index}`;
      await fs.writeFile(
        path.join(output, 'runs', `${run_id}.json`),
        JSON.stringify({ ...saved, run_id }).padEnd(14 * 1024 * 1024),
      );
    }
    const diff = await diffRegradeExperimentRun({
      experimentRun: source.experimentLocation,
      regrade: output,
    });
    assert.equal(diff.coverage, 'incomplete');
    assert.equal(
      diff.issues.some((issue) => issue.reason === 'read_limit'),
      true,
    );
  });

  it('returns unavailable for a missing checkpoint and caller cancellation', async () => {
    const { source, output } = await fixture();
    const load = (signal?: AbortSignal) =>
      diffRegradeExperimentRun({
        experimentRun: source.experimentLocation,
        regrade: output,
        ...(signal ? { signal } : {}),
      });
    const cancelled = await load(AbortSignal.abort());
    assert.equal(cancelled.issues[0]!.reason, 'cancelled');
    await fs.rm(path.join(source.experimentLocation, 'experiment.json'));
    const missing = await load();
    assert.equal(missing.issues[0]!.reason, 'checkpoint_unavailable');
    assert.equal(missing.coverage, 'incomplete');
  });

  it('enforces a read deadline even when source verification never settles', async () => {
    const { source, output } = await fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.useFakeTimers();
    const reading = diffRegradeExperimentRun({
      experimentRun: source.experimentLocation,
      regrade: output,
      engine: {
        ...defaultForgeEngine,
        verifyCompletedRun: async () => {
          started();
          return new Promise(() => {});
        },
      },
    });
    await ready;
    await vi.runOnlyPendingTimersAsync();
    const diff = await reading;
    assert.equal(diff.coverage, 'incomplete');
    assert.equal(diff.issues[0]!.reason, 'timeout');
    assert.deepEqual(diff.runs, []);
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
