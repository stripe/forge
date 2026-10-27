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
        'Additional evidence warnings were omitted from this criterion; see the saved evidence.',
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
  readonly trajectory: {
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
    ...(input.trajectory.completeness === 'complete'
      ? []
      : [
          {
            source: 'trajectory' as const,
            code: 'trajectory_incomplete',
            message:
              'The selected trajectory is partial or uses driver fallback.',
          },
        ]),
    ...input.trajectory.warnings.map((warning) => ({
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
