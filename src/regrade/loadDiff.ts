import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defaultForgeEngine, type ForgeEngine } from '../engine.ts';
import { inspectExperimentRun } from '../experiment.ts';
import { experimentRunIdSchema } from '../experimentModel.ts';
import { sha256Digest } from '../model/hashes.ts';
import {
  compareRegradeResults,
  type RegradeDiff,
  type RegradeDiffIssue,
  type RegradeDiffSourceRun,
} from './diff.ts';
import { parseSavedRegrade } from './experiment.ts';
import { RegradeReadError, readRegradeArtifact } from './read.ts';
import type { RegradeResultV1 } from './run.ts';

const DIFF_READ_TIMEOUT_MS = 30_000;
const MAX_DIFF_FILES = 100_000;
const MAX_DIFF_TOTAL_BYTES = 64 * 1024 * 1024;

/** Inspect saved inputs without letting one unavailable record discard other pairs. */
export async function diffRegradeExperimentRun(input: {
  readonly experimentRun: string;
  readonly regrade: string;
  readonly engine?: ForgeEngine;
  readonly signal?: AbortSignal;
}): Promise<RegradeDiff> {
  const engine = input.engine ?? defaultForgeEngine;
  const deadline = new AbortController();
  const signal = AbortSignal.any([
    deadline.signal,
    ...(input.signal === undefined ? [] : [input.signal]),
  ]);
  const timer = setTimeout(() => deadline.abort(), DIFF_READ_TIMEOUT_MS);
  const sources: RegradeDiffSourceRun[] = [];
  const regrades: RegradeResultV1[] = [];
  const issues: RegradeDiffIssue[] = [];
  let totalBytes = 0;
  const retain = (body: Buffer, side: RegradeDiffIssue['side']) => {
    totalBytes += body.byteLength;
    if (totalBytes <= MAX_DIFF_TOTAL_BYTES) return true;
    issue({ side, run_id: null, state: 'unavailable', reason: 'read_limit' });
    return false;
  };
  const issue = (value: RegradeDiffIssue) => {
    signal.throwIfAborted();
    issues.push(value);
  };
  const load = async () => {
    signal.throwIfAborted();
    let inspection: Awaited<ReturnType<typeof inspectExperimentRun>>;
    try {
      inspection = await inspectExperimentRun({
        root: input.experimentRun,
        engine,
        signal,
      });
    } catch {
      issue({
        side: 'source',
        run_id: null,
        state: 'unavailable',
        reason: 'checkpoint_unavailable',
      });
      return;
    }
    for (const [index, outcome] of inspection.outcomes.entries()) {
      signal.throwIfAborted();
      const identity = {
        side: 'source' as const,
        run_id: outcome.run_id,
        selection_index: index,
      };
      if (outcome.state !== 'completed' || outcome.artifact === null) {
        if (outcome.checkpoint_state === 'pending')
          issue({ ...identity, state: 'pending', reason: 'never_attempted' });
        else if (
          outcome.checkpoint_state === 'running' &&
          outcome.artifact === null
        )
          issue({ ...identity, state: 'pending', reason: 'not_committed' });
        else if (
          outcome.checkpoint_state === 'completed' &&
          outcome.artifact === null
        )
          issue({
            ...identity,
            state: 'invalid',
            reason: 'source_verification_failed',
          });
        else if (
          outcome.checkpoint_state === 'errored' ||
          outcome.artifact !== null
        )
          issue({ ...identity, state: 'errored', reason: 'execution_error' });
        else
          issue({
            ...identity,
            state: 'unavailable',
            reason: 'source_verification_failed',
          });
        continue;
      }
      try {
        const completed = await engine.verifyCompletedRun(
          outcome.artifact.location,
        );
        const body = await readRegradeArtifact(
          path.join(completed.location, 'result.json'),
        );
        signal.throwIfAborted();
        if (!retain(body, 'source')) return;
        sources.push({
          run_id: completed.result.run_id,
          result_sha256: sha256Digest(body),
          evaluation: completed.result.evaluation,
        });
      } catch (error) {
        issue(
          error instanceof RegradeReadError
            ? {
                ...identity,
                state: 'unavailable',
                reason:
                  error.reason === 'too_large'
                    ? 'read_limit'
                    : 'source_unavailable',
              }
            : { ...identity, state: 'invalid', reason: 'source_changed' },
        );
      }
    }
    const excludedSources = new Set(
      issues
        .filter((value) => value.side === 'source')
        .map((value) => value.run_id),
    );
    const directory = path.join(input.regrade, 'runs');
    try {
      let count = 0;
      for await (const entry of await fs.opendir(directory)) {
        signal.throwIfAborted();
        if (++count > MAX_DIFF_FILES) {
          issue({
            side: 'regrade',
            run_id: null,
            state: 'unavailable',
            reason: 'read_limit',
          });
          break;
        }
        if (!entry.name.endsWith('.json')) continue;
        const parsedId = experimentRunIdSchema.safeParse(
          entry.name.slice(0, -5),
        );
        if (!parsedId.success) {
          issue({
            side: 'regrade',
            run_id: null,
            state: 'invalid',
            reason: 'invalid_filename',
          });
          continue;
        }
        const runId = parsedId.data;
        if (excludedSources.has(runId)) continue;
        try {
          const body = await readRegradeArtifact(
            path.join(directory, entry.name),
          );
          signal.throwIfAborted();
          if (!retain(body, 'regrade')) break;
          const regrade = parseSavedRegrade(body);
          if (regrade.run_id !== runId) {
            issue({
              side: 'regrade',
              run_id: runId,
              state: 'invalid',
              reason: 'filename_mismatch',
            });
          } else regrades.push(regrade);
        } catch (error) {
          const unavailable =
            error instanceof RegradeReadError &&
            [
              'missing',
              'unreadable',
              'unsupported_format',
              'too_large',
            ].includes(error.reason);
          issue({
            side: 'regrade',
            run_id: runId,
            state: unavailable ? 'unavailable' : 'invalid',
            reason:
              error instanceof RegradeReadError && error.reason === 'too_large'
                ? 'read_limit'
                : unavailable
                  ? 'regrade_unavailable'
                  : 'regrade_invalid',
          });
        }
      }
    } catch {
      issue({
        side: 'regrade',
        run_id: null,
        state: 'unavailable',
        reason: 'regrade_directory_unavailable',
      });
    }
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) resolve();
  });
  try {
    await Promise.race([load(), aborted]);
    if (signal.aborted)
      issues.push({
        side: 'source',
        run_id: null,
        state: 'unavailable',
        reason: input.signal?.aborted ? 'cancelled' : 'timeout',
      });
  } catch (error) {
    if (!signal.aborted) throw error;
    issues.push({
      side: 'source',
      run_id: null,
      state: 'unavailable',
      reason: input.signal?.aborted ? 'cancelled' : 'timeout',
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  return compareRegradeResults({ sourceRuns: sources, regrades, issues });
}
