import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defaultForgeEngine, type ForgeEngine } from '../engine.ts';
import { inspectExperimentRun } from '../experiment.ts';
import { sha256Digest } from '../model/hashes.ts';
import { REQUIREMENT_LEVELS, type RequirementLevelV1 } from '../model/types.ts';
import { parseEvaluationResult } from '../results/parse.ts';
import type {
  CriterionResultV1,
  EvaluationResultV1,
} from '../results/types.ts';
import { readExistingRegrade } from './experiment.ts';
import type { RegradeResultV1 } from './run.ts';

export interface RegradeDiffSourceRun {
  readonly run_id: string;
  readonly result_sha256: string;
  readonly evaluation: EvaluationResultV1;
}

export interface VerdictAgreement {
  readonly matched: number;
  /** Criteria with a boolean verdict on both sides, including OPTIONAL. */
  readonly total: number;
  readonly rate: number | null;
}

interface DiffCriterion {
  readonly run_id: string;
  /** Zero-based position in the saved criterion list. */
  readonly criterion_index: number;
  readonly criterion: string;
  readonly label?: string;
  readonly requirement_level: RequirementLevelV1;
}

export interface RegradeDiff {
  readonly agreement: VerdictAgreement;
  readonly agreement_by_requirement: Readonly<
    Record<RequirementLevelV1, VerdictAgreement>
  >;
  readonly runs: readonly {
    readonly run_id: string;
    readonly source_score: number | null;
    readonly regrade_score: number | null;
    readonly score_change: number | null;
  }[];
  /** Mean of paired score changes; null scores do not contribute. */
  readonly mean_score_change: number | null;
  readonly flipped_criteria: readonly (DiffCriterion & {
    readonly source_passed: boolean;
    readonly regrade_passed: boolean;
  })[];
  readonly judge_errors: readonly (DiffCriterion & {
    readonly side: 'source' | 'regrade';
    readonly error: Extract<CriterionResultV1, { passed: null }>['error'];
  })[];
  readonly missing_regrades: readonly string[];
  readonly not_judged: readonly string[];
}

/** Compare verified source evaluations with regrades, without I/O or model calls. */
export function compareRegradeResults(input: {
  readonly sourceRuns: readonly RegradeDiffSourceRun[];
  readonly regrades: readonly RegradeResultV1[];
}): RegradeDiff {
  const sources = new Map(input.sourceRuns.map((run) => [run.run_id, run]));
  if (sources.size !== input.sourceRuns.length)
    throw new Error('Duplicate source run ID.');
  const regrades = new Map(input.regrades.map((run) => [run.run_id, run]));
  if (regrades.size !== input.regrades.length)
    throw new Error('Duplicate regrade run ID.');
  const judge = input.regrades[0]?.judge;
  for (const regrade of input.regrades) {
    if (!sources.has(regrade.run_id))
      throw new Error(
        `Regrade has no completed source run: ${regrade.run_id}.`,
      );
    if (
      regrade.judge.provider !== judge?.provider ||
      regrade.judge.model !== judge?.model
    )
      throw new Error('Regrades use different judges.');
  }

  const counts = Object.fromEntries(
    REQUIREMENT_LEVELS.map((level) => [level, { matched: 0, total: 0 }]),
  ) as Record<RequirementLevelV1, { matched: number; total: number }>;
  const runs: RegradeDiff['runs'][number][] = [];
  const flips: RegradeDiff['flipped_criteria'][number][] = [];
  const errors: RegradeDiff['judge_errors'][number][] = [];
  const missing: string[] = [];
  const notJudged: string[] = [];
  for (const source of input.sourceRuns) {
    const original = parseEvaluationResult(source.evaluation);
    const regrade = regrades.get(source.run_id);
    if (original.judging_criteria.length === 0) {
      if (regrade !== undefined)
        throw new Error(`Regrade has no source criteria: ${source.run_id}.`);
      notJudged.push(source.run_id);
      continue;
    }
    const identify = (
      criterion: {
        readonly criterion: string;
        readonly label?: string | undefined;
        readonly requirement_level: RequirementLevelV1;
      },
      index: number,
    ): DiffCriterion => ({
      run_id: source.run_id,
      criterion_index: index,
      criterion: criterion.criterion,
      ...(criterion.label === undefined ? {} : { label: criterion.label }),
      requirement_level: criterion.requirement_level,
    });
    for (const [index, criterion] of original.judging_criteria.entries()) {
      if (criterion.passed === null)
        errors.push({
          ...identify(criterion, index),
          side: 'source',
          error: { ...criterion.error },
        });
    }
    if (regrade === undefined) {
      missing.push(source.run_id);
      continue;
    }
    if (regrade.source.result_sha256 !== source.result_sha256)
      throw new Error(
        `Regrade source digest does not match: ${source.run_id}.`,
      );
    const revised = parseEvaluationResult(regrade.evaluation);
    if (original.judging_criteria.length !== revised.judging_criteria.length)
      throw new Error(`Regrade criteria do not match: ${source.run_id}.`);
    for (const [index, before] of original.judging_criteria.entries()) {
      const after = revised.judging_criteria[index]!;
      if (
        after.criterion !== before.criterion ||
        after.label !== before.label ||
        after.requirement_level !== before.requirement_level
      )
        throw new Error(
          `Regrade criterion does not match: ${source.run_id} at index ${index}.`,
        );
      const identity = identify(before, index);
      if (after.passed === null)
        errors.push({
          ...identity,
          side: 'regrade',
          error: { ...after.error },
        });
      if (before.passed === null || after.passed === null) continue;
      const count = counts[before.requirement_level];
      count.total++;
      if (before.passed === after.passed) count.matched++;
      else
        flips.push({
          ...identity,
          source_passed: before.passed,
          regrade_passed: after.passed,
        });
    }
    runs.push({
      run_id: source.run_id,
      source_score: original.score,
      regrade_score: revised.score,
      score_change:
        original.score === null || revised.score === null
          ? null
          : revised.score - original.score,
    });
  }
  const agreement = (matched: number, total: number): VerdictAgreement => ({
    matched,
    total,
    rate: total === 0 ? null : matched / total,
  });
  const changes = runs.flatMap((run) =>
    run.score_change === null ? [] : [run.score_change],
  );
  return {
    agreement: agreement(
      REQUIREMENT_LEVELS.reduce((sum, level) => sum + counts[level].matched, 0),
      REQUIREMENT_LEVELS.reduce((sum, level) => sum + counts[level].total, 0),
    ),
    agreement_by_requirement: Object.fromEntries(
      REQUIREMENT_LEVELS.map((level) => [
        level,
        agreement(counts[level].matched, counts[level].total),
      ]),
    ) as Record<RequirementLevelV1, VerdictAgreement>,
    runs,
    mean_score_change:
      changes.length === 0
        ? null
        : changes.reduce((sum, change) => sum + change, 0) / changes.length,
    flipped_criteria: flips,
    judge_errors: errors,
    missing_regrades: missing,
    not_judged: notJudged,
  };
}

/** Load the source's verified latest completed attempts and saved regrade files. */
export async function diffRegradeExperimentRun(input: {
  readonly experimentRun: string;
  readonly regrade: string;
  readonly engine?: ForgeEngine;
  readonly signal?: AbortSignal;
}): Promise<RegradeDiff> {
  const engine = input.engine ?? defaultForgeEngine;
  const inspection = await inspectExperimentRun({
    root: input.experimentRun,
    engine,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const sources: RegradeDiffSourceRun[] = [];
  for (const outcome of inspection.outcomes) {
    input.signal?.throwIfAborted();
    if (outcome.error_code === 'invalid_artifacts')
      throw new Error(
        `Source run failed artifact verification: ${outcome.run_id}.`,
      );
    if (outcome.state !== 'completed' || outcome.artifact === null) continue;
    const completed = await engine.verifyCompletedRun(
      outcome.artifact.location,
    );
    sources.push({
      run_id: completed.result.run_id,
      result_sha256: sha256Digest(
        await fs.readFile(path.join(completed.location, 'result.json')),
      ),
      evaluation: completed.result.evaluation,
    });
  }
  const regrades: RegradeResultV1[] = [];
  const directory = path.join(input.regrade, 'runs');
  for (const file of (await fs.readdir(directory)).sort()) {
    input.signal?.throwIfAborted();
    if (!file.endsWith('.json')) continue;
    const regrade = await readExistingRegrade(path.join(directory, file));
    if (regrade === undefined) throw new Error(`Regrade disappeared: ${file}.`);
    if (file !== `${regrade.run_id}.json`)
      throw new Error(`Regrade filename does not match its run ID: ${file}.`);
    regrades.push(regrade);
  }
  return compareRegradeResults({ sourceRuns: sources, regrades });
}
