import {
  parseAtifTrajectory,
  type AtifStep,
  type AtifTrajectoryV1_8,
} from '../atif/index.js';
import {sha256Digest} from '../model/hashes.js';
import type {Sha256Digest} from '../model/types.js';
import {serializeCanonicalJson} from '../serialization.js';

export const JUDGE_TRANSCRIPT_SOURCE = 'trajectory.json' as const;
export const JUDGE_TRANSCRIPT_PROJECTION_ID =
  'forge-visible-atif-steps' as const;
export const JUDGE_TRANSCRIPT_PROJECTION_VERSION = 1 as const;
export const JUDGE_TRANSCRIPT_EXCLUDED_FIELDS = Object.freeze(
  ['reasoning_content', 'reasoning_effort'] as const,
);

/** Exact, versioned transcript projection supplied to a guideline judge. */
export interface JudgeTranscriptProjectionV1 {
  readonly source: typeof JUDGE_TRANSCRIPT_SOURCE;
  readonly projectionId: typeof JUDGE_TRANSCRIPT_PROJECTION_ID;
  readonly projectionVersion: typeof JUDGE_TRANSCRIPT_PROJECTION_VERSION;
  readonly excludedFields: typeof JUDGE_TRANSCRIPT_EXCLUDED_FIELDS;
  /** Exact canonical JSON supplied to the judge, including its final LF. */
  readonly transcriptJson: string;
  readonly transcriptSha256: Sha256Digest;
}

/**
 * Project canonical ATIF into the root-step transcript visible to a judge.
 *
 * The input is parsed first so this public boundary accepts only bounded,
 * valid ATIF and operates on a fresh clone. Only the schema-defined reasoning
 * fields directly on root steps are removed. Opaque nested values remain
 * intact, even when they contain properties with the same names.
 */
export function createJudgeTranscriptProjection(
  trajectory: AtifTrajectoryV1_8,
): JudgeTranscriptProjectionV1 {
  const parsed = parseAtifTrajectory(trajectory);
  const projectedSteps = parsed.steps.map(projectStep);
  const transcriptJson = serializeCanonicalJson(projectedSteps);

  return Object.freeze({
    source: JUDGE_TRANSCRIPT_SOURCE,
    projectionId: JUDGE_TRANSCRIPT_PROJECTION_ID,
    projectionVersion: JUDGE_TRANSCRIPT_PROJECTION_VERSION,
    excludedFields: JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
    transcriptJson,
    transcriptSha256: sha256Digest(transcriptJson),
  });
}

function projectStep(step: AtifStep): AtifStep {
  const projected = {...step};
  delete projected.reasoning_content;
  delete projected.reasoning_effort;
  return projected;
}
