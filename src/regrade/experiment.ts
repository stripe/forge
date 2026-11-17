import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defaultForgeEngine } from '../engine.ts';
import { inspectExperimentRun } from '../experiment.ts';
import {
  buildExperimentRunReport,
  type ExperimentRunReportRunV1,
  serializeExperimentRunReport,
  summarizeReportEvaluation,
} from '../experimentReport.ts';
import { sha256Digest } from '../model/hashes.ts';
import type { ModelRefV1 } from '../model/types.ts';
import { FORGE_BUILD_IDENTITY, type ForgeBuildIdentity } from '../version.ts';
import {
  REGRADE_RESULT_FORMAT,
  type RegradeDependencies,
  type RegradeResultV1,
  regradeCompletedRun,
} from './run.ts';

export const REGRADE_SUMMARY_FORMAT = 'forge-regrade-experiment-v1' as const;

/** Outcome of regrading one saved experiment run into a separate directory. */
export interface RegradeExperimentSummaryV1 {
  readonly format: typeof REGRADE_SUMMARY_FORMAT;
  readonly experiment_run_id: string;
  /** Source experiment run; the report records it as `result_root`, which its rows' `result_path` values resolve against. */
  readonly source_location: string;
  readonly output_location: string;
  readonly judge: ModelRefV1;
  readonly regraded: number;
  /** Regrades already present for the same judge and committed result. */
  readonly reused: number;
  /** Completed runs without judging criteria; their checks-only evaluation is unchanged. */
  readonly not_judged: number;
  /** Selections with no completed run to regrade (pending or errored at the source). */
  readonly not_completed: number;
  /** Completed runs that could not be regraded, including those that no longer verify; their report rows are pending. */
  readonly failed: readonly {
    readonly run_id: string;
    readonly message: string;
  }[];
  readonly report: string;
  readonly generated_at: string;
  readonly forge: ForgeBuildIdentity;
}

type RegradeOutcome =
  | { readonly kind: 'regraded' | 'reused'; readonly regrade: RegradeResultV1 }
  | { readonly kind: 'not_judged' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Regrade every completed run of one saved experiment run with `judge`. The
 * source experiment run is only read. Each regrade is written to
 * `<output>/runs/<run_id>.json`, then `<output>/report.json` aggregates the
 * regraded evaluations with the source checkpoint's selections, and
 * `<output>/regrade.json` summarizes the invocation. Report rows keep
 * `result_path` (the original execution, under the report's `result_root`)
 * and add `regrade_path` (the evaluation behind their scores, under the
 * report's directory). One invocation at a time may write an output: an
 * exclusive lock is held from the first read of saved regrades until
 * `regrade.json` is written.
 */
export async function regradeExperimentRun(
  input: {
    readonly experimentRun: string;
    readonly judge: ModelRefV1;
    readonly output: string;
    readonly jobs?: number;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
    readonly progress?: (event: {
      readonly run_id: string;
      readonly state: RegradeOutcome['kind'];
    }) => void;
    readonly waitBeforeJudgeRetry?: Parameters<
      typeof regradeCompletedRun
    >[0]['waitBeforeJudgeRetry'];
  },
  dependencies: RegradeDependencies,
): Promise<RegradeExperimentSummaryV1> {
  const engine = dependencies.engine ?? defaultForgeEngine;
  const signal = input.signal ?? new AbortController().signal;
  const now = input.now ?? (() => new Date());
  const source = await fs.realpath(path.resolve(input.experimentRun));
  const output = path.resolve(input.output);
  // Every directory this command writes into, resolved physically: the output itself and its `runs`
  // directory, which may be a symlink even when the output is not.
  for (const directory of [output, path.join(output, 'runs')]) {
    if (isWithin(source, await realpathOfNearestExisting(directory)))
      throw new Error(
        'The regrade output must be outside the source experiment run, whose runs must stay unchanged.',
      );
  }
  const jobs = input.jobs ?? 1;
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new TypeError('jobs must be a positive integer.');

  const inspection = await inspectExperimentRun({
    root: source,
    engine,
    signal,
  });
  const checkpointBody = await fs.readFile(
    path.join(source, 'experiment.json'),
    'utf8',
  );
  const checkpointEntries = (
    JSON.parse(checkpointBody) as {
      entries: { attempts: { state: string }[] }[];
    }
  ).entries;
  const attemptCounts = checkpointEntries.map((entry) => entry.attempts.length);
  // A completed attempt that no longer verifies is inspected as errored; it is a failure to regrade,
  // unlike a selection that never completed.
  const corruptIndexes = new Set(
    inspection.outcomes.flatMap((outcome, index) =>
      outcome.state !== 'completed' &&
      checkpointEntries[index]?.attempts.at(-1)?.state === 'completed'
        ? [index]
        : [],
    ),
  );
  await fs.mkdir(path.join(output, 'runs'), { recursive: true });
  const lock = await acquireOutputLock(output);
  try {
    return await regradeLocked();
  } finally {
    await lock.release();
  }

  async function regradeLocked(): Promise<RegradeExperimentSummaryV1> {
    const completedIndexes = inspection.outcomes.flatMap((outcome, index) =>
      outcome.state === 'completed' && outcome.artifact !== null ? [index] : [],
    );
    const outcomes = new Map<number, RegradeOutcome>();
    for (const index of corruptIndexes)
      outcomes.set(index, {
        kind: 'failed',
        message: 'The saved run failed artifact verification.',
      });
    let next = 0;
    const worker = async () => {
      for (;;) {
        signal.throwIfAborted();
        const index = completedIndexes[next++];
        if (index === undefined) return;
        const outcome = inspection.outcomes[index]!;
        const result = await regradeOne(
          outcome.run_id!,
          outcome.artifact!.location,
        );
        outcomes.set(index, result);
        input.progress?.({ run_id: outcome.run_id!, state: result.kind });
      }
    };
    const regradeOne = async (
      runId: string,
      location: string,
    ): Promise<RegradeOutcome> => {
      const file = path.join(output, 'runs', `${runId}.json`);
      try {
        const resultSha256 = sha256Digest(
          await fs.readFile(path.join(location, 'result.json')),
        );
        const existing = await readExistingRegrade(file);
        if (existing !== undefined) {
          if (
            existing.run_id !== runId ||
            existing.judge.provider !== input.judge.provider ||
            existing.judge.model !== input.judge.model ||
            existing.source.result_sha256 !== resultSha256
          )
            throw new Error(
              'An existing regrade in the output uses a different judge or result.',
            );
          return { kind: 'reused', regrade: existing };
        }
        const regrade = await regradeCompletedRun(
          {
            location,
            judge: input.judge,
            signal,
            now,
            ...(input.waitBeforeJudgeRetry === undefined
              ? {}
              : { waitBeforeJudgeRetry: input.waitBeforeJudgeRetry }),
          },
          { ...dependencies, engine },
        );
        if (regrade === undefined) return { kind: 'not_judged' };
        await writeAtomic(file, `${JSON.stringify(regrade, null, 2)}\n`);
        return { kind: 'regraded', regrade };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          kind: 'failed',
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
        };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(jobs, completedIndexes.length) }, worker),
    );

    const runs: ExperimentRunReportRunV1[] = [];
    for (const [index, outcome] of inspection.outcomes.entries()) {
      const base = {
        selection_index: index,
        selection: outcome.selection,
        attempt_count: attemptCounts[index] ?? 0,
      };
      const regraded = outcomes.get(index);
      if (outcome.state === 'pending' || regraded?.kind === 'failed') {
        runs.push({
          ...base,
          attempt_count: 0,
          run_id: null,
          state: 'pending',
          error_code: null,
          result_path: null,
          evaluation: null,
        });
        continue;
      }
      const resultPath =
        outcome.artifact === null ? null : `runs/${outcome.run_id}/result.json`;
      if (outcome.state === 'errored') {
        runs.push({
          ...base,
          run_id: outcome.run_id,
          state: 'errored',
          error_code: outcome.error_code,
          result_path: resultPath,
          evaluation: null,
        });
        continue;
      }
      const evaluation =
        regraded?.kind === 'regraded' || regraded?.kind === 'reused'
          ? regraded.regrade.evaluation
          : (await engine.verifyCompletedRun(outcome.artifact!.location)).result
              .evaluation;
      runs.push({
        ...base,
        run_id: outcome.run_id,
        state: 'completed',
        error_code: null,
        result_path: resultPath,
        ...(regraded?.kind === 'regraded' || regraded?.kind === 'reused'
          ? { regrade_path: `runs/${outcome.run_id}.json` }
          : {}),
        evaluation: summarizeReportEvaluation(evaluation),
      });
    }
    const generatedAt = now().toISOString();
    const report = buildExperimentRunReport({
      experimentRunId: inspection.experiment_run_id,
      generatedAt,
      checkpointBody,
      runs,
      resultRoot: source,
    });
    const reportPath = path.join(output, 'report.json');
    await writeAtomic(reportPath, serializeExperimentRunReport(report));

    const count = (kind: RegradeOutcome['kind']) =>
      [...outcomes.values()].filter((outcome) => outcome.kind === kind).length;
    const summary: RegradeExperimentSummaryV1 = Object.freeze({
      format: REGRADE_SUMMARY_FORMAT,
      experiment_run_id: inspection.experiment_run_id,
      source_location: source,
      output_location: output,
      judge: Object.freeze({ ...input.judge }),
      regraded: count('regraded'),
      reused: count('reused'),
      not_judged: count('not_judged'),
      not_completed:
        inspection.outcomes.length -
        completedIndexes.length -
        corruptIndexes.size,
      failed: Object.freeze(
        [...outcomes.entries()].flatMap(([index, outcome]) =>
          outcome.kind === 'failed'
            ? [
                {
                  run_id: inspection.outcomes[index]!.run_id!,
                  message: outcome.message,
                },
              ]
            : [],
        ),
      ),
      report: reportPath,
      generated_at: generatedAt,
      forge: FORGE_BUILD_IDENTITY,
    });
    await writeAtomic(
      path.join(output, 'regrade.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    return summary;
  }
}

const OUTPUT_LOCK = '.regrade.lock';

/** Exclusively claim a regrade output directory; a second writer fails instead of mixing results. */
async function acquireOutputLock(
  output: string,
): Promise<{ release: () => Promise<void> }> {
  const file = path.join(output, OUTPUT_LOCK);
  try {
    await fs.writeFile(
      file,
      `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o644 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Another regrade is writing to ${output}. Wait for it to finish; if none is running, remove ${file}.`,
      );
    throw error;
  }
  return { release: () => fs.rm(file, { force: true }) };
}

/**
 * Resolve symlinks in a path that may not exist yet, so it compares with the realpath of the source run (e.g. macOS
 * `/var` → `/private/var`): the nearest existing ancestor is resolved and the missing tail is appended unchanged.
 */
async function realpathOfNearestExisting(candidate: string): Promise<string> {
  const missing: string[] = [];
  let existing = candidate;
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(existing);
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        parent === existing
      )
        throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function readExistingRegrade(
  file: string,
): Promise<RegradeResultV1 | undefined> {
  let body: string;
  try {
    body = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(body) as RegradeResultV1;
  if (value.format !== REGRADE_RESULT_FORMAT)
    throw new Error('An existing regrade file has an unknown format.');
  return value;
}

async function writeAtomic(file: string, body: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
