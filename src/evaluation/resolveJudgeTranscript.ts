import {
  type AtifNormalizationWarning,
  createNormalizedTrajectory,
  type NormalizedTrajectory,
} from '../atif/index.ts';
import { selectJudgeEvidence } from './judgeEvidenceBudget.ts';
import {
  createJudgeTranscriptProjection,
  EMPTY_JUDGE_TRANSCRIPT,
  type JudgeTranscriptProjectionV1,
} from './judgeTranscript.ts';

export interface RedactedJudgeEvidence {
  readonly evidence: NormalizedTrajectory;
  /** Replacements in the selected normalized evidence that will be saved. */
  readonly replacements: number;
}

export interface ResolvedJudgeTranscript {
  readonly redacted: RedactedJudgeEvidence;
  readonly transcript: JudgeTranscriptProjectionV1;
  readonly reason:
    | 'within_budget'
    | 'native_budget_exceeded'
    | 'judge_budget_exceeded';
}

/** Pure native → driver → code-only choice; the driver builder must also be pure. */
export function resolveJudgeTranscript(input: {
  readonly promptOverheadBytes: number;
  readonly selected: RedactedJudgeEvidence;
  readonly buildDriver: (
    reason: AtifNormalizationWarning,
  ) => RedactedJudgeEvidence;
}): ResolvedJudgeTranscript {
  const selectedTranscript = createJudgeTranscriptProjection(
    input.selected.evidence.trajectory,
  );
  const source = input.selected.evidence.provenance.source;
  const nativeSelected = source.kind === 'native_log' || source.kind === 'atif';
  const selectedTranscriptBytes = Buffer.byteLength(
    selectedTranscript.transcriptJson,
    'utf8',
  );
  const budget = selectJudgeEvidence({
    promptOverheadBytes: input.promptOverheadBytes,
    ...(nativeSelected
      ? { nativeTranscriptBytes: selectedTranscriptBytes }
      : { driverTranscriptBytes: selectedTranscriptBytes }),
  });
  if (budget.evidence !== 'omitted') {
    return {
      redacted: input.selected,
      transcript: selectedTranscript,
      reason: 'within_budget',
    };
  }

  const driver = nativeSelected
    ? input.buildDriver({
        code: 'value_omitted',
        message:
          'Native evidence exceeded the judge budget; driver fallback is selected if it fits.',
      })
    : input.selected;
  const driverTranscript = nativeSelected
    ? createJudgeTranscriptProjection(driver.evidence.trajectory)
    : selectedTranscript;
  const driverBudget = selectJudgeEvidence({
    promptOverheadBytes: input.promptOverheadBytes,
    driverTranscriptBytes: Buffer.byteLength(
      driverTranscript.transcriptJson,
      'utf8',
    ),
  });
  if (driverBudget.evidence === 'driver') {
    return {
      redacted: driver,
      transcript: driverTranscript,
      reason: 'native_budget_exceeded',
    };
  }
  return {
    redacted: {
      ...driver,
      evidence: createNormalizedTrajectory({
        ...driver.evidence,
        warnings: [
          ...driver.evidence.warnings,
          {
            code: 'value_omitted',
            message:
              'Transcript exceeded the judge budget; graded on workspace evidence only.',
          },
        ],
      }),
    },
    transcript: EMPTY_JUDGE_TRANSCRIPT,
    reason: 'judge_budget_exceeded',
  };
}
