import { judgeMethodOf } from '../model/judgeMethod.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import type { JudgeEvidenceV1 } from '../results/types.ts';
import {
  criterionJudgePromptOverheadBytes,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
} from './criterionJudge.ts';
import { EMPTY_JUDGE_TRANSCRIPT } from './judgeTranscript.ts';
import { renderRecordedJudgeWorkspaceEvidence } from './judgeWorkspace.ts';

/** Size the same plan and recorded workspace subset during execution and verification. */
export function sizeJudgePrompt(
  plan: ResolvedRunPlanV1,
  workspace: JudgeEvidenceV1['workspace'],
): { readonly workspaceText: string; readonly promptOverheadBytes: number } {
  const workspaceText = renderRecordedJudgeWorkspaceEvidence(workspace);
  return {
    workspaceText,
    promptOverheadBytes: criterionJudgePromptOverheadBytes({
      criteria: plan.evaluation.judging_criteria,
      exampleAnswer: plan.evaluation.example_answer,
      workspaceText,
      ...(plan.evaluation.judge === undefined
        ? {}
        : { method: judgeMethodOf(plan.evaluation.judge) }),
    }),
  };
}

export interface JudgeEvidenceBudgetInput {
  /** Largest complete criterion prompt, excluding only transcript JSON bytes. */
  readonly promptOverheadBytes: number;
  readonly nativeTranscriptBytes?: number;
  /** May be absent until native overflow requires constructing driver evidence. */
  readonly driverTranscriptBytes?: number;
}

export interface JudgeEvidenceBudgetSelection {
  readonly transcriptBudgetBytes: number;
  readonly evidence: 'native' | 'driver' | 'omitted';
}

/**
 * Reserve mandatory text and the minimum empty transcript before choosing among
 * sized candidates. An unsized candidate cannot be selected; execution sizes
 * driver evidence only after native overflow, then repeats this pure choice.
 */
export function selectJudgeEvidence(
  input: JudgeEvidenceBudgetInput,
): JudgeEvidenceBudgetSelection {
  // Even code-only grading sends canonical empty-array JSON with its final LF.
  const minimumTranscriptBytes = Buffer.byteLength(
    EMPTY_JUDGE_TRANSCRIPT.transcriptJson,
    'utf8',
  );
  const transcriptBudgetBytes =
    MAX_CRITERION_JUDGE_PROMPT_BYTES - input.promptOverheadBytes;
  if (transcriptBudgetBytes < minimumTranscriptBytes) {
    throw new TypeError(
      'Mandatory criterion judge prompt exceeds the limit even with an empty transcript.',
    );
  }
  const evidence =
    input.nativeTranscriptBytes !== undefined &&
    input.nativeTranscriptBytes <= transcriptBudgetBytes
      ? 'native'
      : input.driverTranscriptBytes !== undefined &&
          input.driverTranscriptBytes <= transcriptBudgetBytes
        ? 'driver'
        : 'omitted';
  return { transcriptBudgetBytes, evidence };
}
