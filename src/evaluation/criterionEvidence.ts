import type { CriterionEvidenceWarningV1 } from '../results/types.ts';

export const MAX_CRITERION_EVIDENCE_WARNINGS = 64;
export const MAX_CRITERION_EVIDENCE_WARNING_BYTES = 16 * 1024;

export function boundCriterionEvidenceWarnings(
  warnings: readonly CriterionEvidenceWarningV1[],
): CriterionEvidenceWarningV1[] {
  const retained: CriterionEvidenceWarningV1[] = [];
  let bytes = 2;
  for (const [index, warning] of warnings.entries()) {
    const marker: CriterionEvidenceWarningV1 = {
      source: warning.source,
      code: 'evidence_warnings_truncated',
      message:
        'Additional evidence warnings were omitted from this evaluation; see the saved evidence.',
    };
    const size = Buffer.byteLength(JSON.stringify(warning)) + 1;
    const reserve =
      index < warnings.length - 1
        ? Buffer.byteLength(JSON.stringify(marker)) + 1
        : 0;
    if (
      retained.length >=
        MAX_CRITERION_EVIDENCE_WARNINGS - (reserve > 0 ? 1 : 0) ||
      bytes + size + reserve > MAX_CRITERION_EVIDENCE_WARNING_BYTES
    ) {
      retained.push(marker);
      break;
    }
    retained.push({ ...warning });
    bytes += size;
  }
  return retained;
}

/** Use the same saved provenance for initial judging and later regrades. */
export function criterionEvidenceWarnings(input: {
  /** Absent when the run's trajectory completeness was not recorded. */
  readonly trajectory?: {
    readonly completeness: 'complete' | 'partial' | 'fallback';
    readonly warnings: readonly {
      readonly code: string;
      readonly message: string;
      readonly path?: string;
    }[];
  };
  readonly workspace: {
    readonly complete: boolean;
    readonly warnings: readonly {
      readonly code: string;
      readonly message: string;
      readonly path?: string;
    }[];
  };
}): CriterionEvidenceWarningV1[] {
  return boundCriterionEvidenceWarnings([
    ...(input.trajectory === undefined
      ? UNKNOWN_EVIDENCE_WARNINGS
      : input.trajectory.completeness === 'complete'
        ? []
        : [
            {
              source: 'trajectory' as const,
              code: 'trajectory_incomplete',
              message:
                'The selected trajectory is partial or uses driver fallback.',
            },
          ]),
    ...(input.trajectory?.warnings ?? []).map((warning) => ({
      ...warning,
      source: 'trajectory' as const,
    })),
    ...(input.workspace.complete
      ? []
      : [
          {
            source: 'workspace' as const,
            code: 'workspace_incomplete',
            message: 'The workspace evidence is incomplete.',
          },
        ]),
    ...input.workspace.warnings.map((warning) => ({
      ...warning,
      source: 'workspace' as const,
    })),
  ]);
}

/** Only fixed capture facts enter the prompt; warning text and paths stay out. */
export function renderTrajectoryCaptureStatus(
  warnings: readonly CriterionEvidenceWarningV1[] | undefined,
): string {
  if (warnings === undefined)
    return 'Trajectory capture status: unknown. Missing steps may not be inferred.';
  const trajectory = warnings.filter(
    (warning) => warning.source === 'trajectory',
  );
  if (
    trajectory.some(
      (warning) => warning.code === 'evidence_completeness_unknown',
    )
  )
    return 'Trajectory capture status: unknown. Missing steps may not be inferred.';
  if (trajectory.length === 0) return 'Trajectory capture status: complete.';
  if (trajectory.some((warning) => warning.code === 'source_unavailable'))
    return 'Trajectory capture status: native evidence unavailable; the supplied transcript may use driver fallback. Missing steps may not be inferred.';
  return 'Trajectory capture status: partial or fallback evidence with capture warnings. Missing steps may not be inferred.';
}

/**
 * Warnings that render the longest capture-status line. Whole-prompt sizing
 * reserves this once so one overhead holds for native, driver, and code-only
 * evidence, whose real status lines are never longer.
 */
export const LONGEST_CAPTURE_STATUS_WARNINGS: readonly CriterionEvidenceWarningV1[] =
  Object.freeze([
    Object.freeze({
      source: 'trajectory' as const,
      code: 'source_unavailable',
      message: 'Native evidence is unavailable.',
    }),
  ]);

export const UNKNOWN_EVIDENCE_WARNINGS: readonly CriterionEvidenceWarningV1[] =
  Object.freeze([
    Object.freeze({
      source: 'trajectory' as const,
      code: 'evidence_completeness_unknown',
      message: 'Evidence completeness was not recorded for this judgment.',
    }),
  ]);
