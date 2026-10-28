import { ZodError } from 'zod';
import { REQUIREMENT_LEVELS, type RequirementLevelV1 } from '../model/types.ts';
import { parseEvaluationResult } from '../results/parse.ts';
import type {
  CriterionResultV1,
  EvaluationResultV1,
} from '../results/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';
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

/** Bounded categories, never raw filesystem errors or artifact contents. */
export interface RegradeDiffIssue {
  readonly side: 'source' | 'regrade';
  readonly run_id: string | null;
  readonly selection_index?: number;
  readonly state: 'pending' | 'errored' | 'invalid' | 'unavailable';
  readonly reason:
    | 'never_attempted'
    | 'not_committed'
    | 'execution_error'
    | 'source_verification_failed'
    | 'source_changed'
    | 'source_unavailable'
    | 'checkpoint_unavailable'
    | 'regrade_directory_unavailable'
    | 'regrade_unavailable'
    | 'regrade_invalid'
    | 'invalid_filename'
    | 'filename_mismatch'
    | 'no_completed_source'
    | 'duplicate_source'
    | 'duplicate_regrade'
    | 'source_digest_mismatch'
    | 'criterion_mismatch'
    | 'checks_mismatch'
    | 'evaluation_invalid'
    | 'mixed_judges'
    | 'read_limit'
    | 'timeout'
    | 'cancelled';
}

interface DiffCriterion {
  readonly run_id: string;
  /** Zero-based position in the saved criterion list. */
  readonly criterion_index: number;
  readonly requirement_level: RequirementLevelV1;
}

export interface RegradeDiff {
  readonly coverage: 'complete' | 'incomplete';
  readonly issues: readonly RegradeDiffIssue[];
  readonly agreement: VerdictAgreement;
  readonly agreement_by_requirement: Readonly<
    Record<RequirementLevelV1, VerdictAgreement>
  >;
  readonly runs: readonly {
    readonly run_id: string;
    readonly source_score: number | null;
    readonly regrade_score: number | null;
    readonly score_change: number | null;
    readonly source_status: EvaluationResultV1['status'];
    readonly regrade_status: EvaluationResultV1['status'];
    readonly status_changed: boolean;
  }[];
  /** Mean of paired score changes; null scores do not contribute. */
  readonly mean_score_change: number | null;
  readonly flipped_criteria: readonly (DiffCriterion & {
    readonly source_passed: boolean;
    readonly regrade_passed: boolean;
  })[];
  readonly judge_errors: readonly (DiffCriterion & {
    readonly side: 'source' | 'regrade';
    readonly error: Pick<
      Extract<CriterionResultV1, { passed: null }>['error'],
      'type' | 'attempts'
    >;
  })[];
  readonly missing_regrades: readonly string[];
  readonly not_judged: readonly string[];
}

/** Compare independent artifact pairs; invalid pairs never discard valid ones. */
export function compareRegradeResults(input: {
  readonly sourceRuns: readonly RegradeDiffSourceRun[];
  readonly regrades: readonly RegradeResultV1[];
  readonly issues?: readonly RegradeDiffIssue[];
}): RegradeDiff {
  const issues: RegradeDiffIssue[] = (input.issues ?? []).map((issue) => ({
    ...issue,
  }));
  const sourceIds = new Set(input.sourceRuns.map((run) => run.run_id));
  const sources = groupRuns(input.sourceRuns);
  const regrades = groupRuns(input.regrades);
  const excludedSources = new Set(
    issues
      .filter((issue) => issue.side === 'source')
      .map((issue) => issue.run_id),
  );
  const unavailableRegrades = new Set(
    issues
      .filter((issue) => issue.side === 'regrade')
      .map((issue) => issue.run_id),
  );
  const pairs: {
    runId: string;
    judge: RegradeResultV1['judge'];
    original: ReturnType<typeof parseEvaluationResult>;
    revised: ReturnType<typeof parseEvaluationResult>;
  }[] = [];
  const counts = Object.fromEntries(
    REQUIREMENT_LEVELS.map((level) => [level, { matched: 0, total: 0 }]),
  ) as Record<RequirementLevelV1, { matched: number; total: number }>;
  const runs: RegradeDiff['runs'][number][] = [];
  const flips: RegradeDiff['flipped_criteria'][number][] = [];
  const errors: RegradeDiff['judge_errors'][number][] = [];
  const missing: string[] = [];
  const notJudged: string[] = [];
  const invalid = (
    runId: string,
    side: RegradeDiffIssue['side'],
    reason: RegradeDiffIssue['reason'],
  ) => {
    issues.push({ run_id: runId, side, state: 'invalid', reason });
  };
  const identify = (
    runId: string,
    criterion: Pick<CriterionResultV1, 'requirement_level'>,
    index: number,
  ): DiffCriterion => ({
    run_id: runId,
    criterion_index: index,
    requirement_level: criterion.requirement_level,
  });
  const addErrors = (
    runId: string,
    evaluation: ReturnType<typeof parseEvaluationResult>,
    side: 'source' | 'regrade',
  ) => {
    for (const [index, criterion] of evaluation.judging_criteria.entries()) {
      if (criterion.passed === null)
        errors.push({
          ...identify(runId, criterion, index),
          side,
          error: {
            type: criterion.error.type,
            attempts: criterion.error.attempts,
          },
        });
    }
  };
  for (const runId of regrades.keys()) {
    if (!sourceIds.has(runId) && !excludedSources.has(runId))
      invalid(runId, 'regrade', 'no_completed_source');
  }
  for (const [runId, candidates] of sources) {
    if (candidates.length !== 1) {
      invalid(runId, 'source', 'duplicate_source');
      continue;
    }
    const source = candidates[0]!;
    const original = parseEvaluation(source.evaluation);
    if (original === undefined) {
      invalid(runId, 'source', 'evaluation_invalid');
      continue;
    }
    addErrors(runId, original, 'source');
    const saved = regrades.get(runId);
    if (original.judging_criteria.length === 0) {
      if (saved !== undefined) invalid(runId, 'regrade', 'criterion_mismatch');
      else notJudged.push(runId);
      continue;
    }
    if (saved === undefined) {
      if (!unavailableRegrades.has(runId) && !unavailableRegrades.has(null))
        missing.push(runId);
      continue;
    }
    if (saved.length !== 1) {
      invalid(runId, 'regrade', 'duplicate_regrade');
      continue;
    }
    const regrade = saved[0]!;
    if (regrade.source.result_sha256 !== source.result_sha256) {
      invalid(runId, 'regrade', 'source_digest_mismatch');
      continue;
    }
    const revised = parseEvaluation(regrade.evaluation);
    if (revised === undefined) {
      invalid(runId, 'regrade', 'evaluation_invalid');
      continue;
    }
    if (
      original.judging_criteria.length !== revised.judging_criteria.length ||
      original.judging_criteria.some((before, index) => {
        const after = revised.judging_criteria[index]!;
        return (
          before.criterion !== after.criterion ||
          before.label !== after.label ||
          before.requirement_level !== after.requirement_level
        );
      })
    ) {
      invalid(runId, 'regrade', 'criterion_mismatch');
      continue;
    }
    if (
      serializeCanonicalJson(original.checks) !==
      serializeCanonicalJson(revised.checks)
    ) {
      invalid(runId, 'regrade', 'checks_mismatch');
      continue;
    }
    addErrors(runId, revised, 'regrade');
    pairs.push({ runId, judge: regrade.judge, original, revised });
  }
  const judges = new Set(
    pairs.map((pair) => serializeCanonicalJson(pair.judge)),
  );
  for (const { runId, original, revised } of pairs) {
    if (judges.size > 1) {
      invalid(runId, 'regrade', 'mixed_judges');
      continue;
    }
    for (const [index, before] of original.judging_criteria.entries()) {
      const after = revised.judging_criteria[index]!;
      if (before.passed === null || after.passed === null) continue;
      const count = counts[before.requirement_level];
      count.total++;
      if (before.passed === after.passed) count.matched++;
      else
        flips.push({
          ...identify(runId, before, index),
          source_passed: before.passed,
          regrade_passed: after.passed,
        });
    }
    runs.push({
      run_id: runId,
      source_score: original.score,
      regrade_score: revised.score,
      score_change:
        original.score === null || revised.score === null
          ? null
          : revised.score - original.score,
      source_status: original.status,
      regrade_status: revised.status,
      status_changed: original.status !== revised.status,
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
    coverage:
      issues.length > 0 || missing.length > 0 || errors.length > 0
        ? 'incomplete'
        : 'complete',
    issues: issues.sort((left, right) => {
      const key = (issue: RegradeDiffIssue) =>
        JSON.stringify([issue.side, issue.run_id, issue.state, issue.reason]);
      if (
        left.selection_index !== undefined &&
        right.selection_index !== undefined
      )
        return left.selection_index - right.selection_index;
      if (left.selection_index !== undefined) return -1;
      if (right.selection_index !== undefined) return 1;
      return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
    }),
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

function groupRuns<T extends { readonly run_id: string }>(
  runs: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const run of runs) {
    const group = groups.get(run.run_id) ?? [];
    group.push(run);
    groups.set(run.run_id, group);
  }
  return groups;
}

function parseEvaluation(
  value: unknown,
): ReturnType<typeof parseEvaluationResult> | undefined {
  try {
    return parseEvaluationResult(value);
  } catch (error) {
    if (error instanceof ZodError) return undefined;
    throw error;
  }
}
