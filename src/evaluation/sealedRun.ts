import type { AtifTrajectoryV1_8 } from '../atif/index.ts';
import type { ReadonlyWorkspace } from '../contracts/runtime.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import { parseJudgeEvidence } from '../results/parse.ts';
import type { CriterionResultV1, JudgeEvidenceV1 } from '../results/types.ts';
import { redactSecrets } from '../security/redaction.ts';
import { FORGE_VERSION } from '../version.ts';
import { type EvaluatedRunEvidence, evaluateRunEvidence } from './checks.ts';
import {
  type CriterionCompletionInvoker,
  type CriterionCompletionRequest,
  type CriterionJudgeExecutionOptions,
  judgeCriteria,
} from './criterionJudge.ts';
import {
  createJudgeTranscriptProjection,
  type JudgeTranscriptProjectionV1,
} from './judgeTranscript.ts';
import {
  boundJudgeWorkspaceEvidence,
  collectJudgeWorkspaceEvidence,
  type JudgeWorkspaceEvidenceV1,
  renderJudgeWorkspaceEvidence,
} from './judgeWorkspace.ts';

export interface EvaluateSealedRunInput {
  readonly plan: ResolvedRunPlanV1;
  /** The run's redacted canonical trajectory. */
  readonly trajectory: AtifTrajectoryV1_8;
  /** The sealed workspace. */
  readonly workspace: ReadonlyWorkspace;
  readonly invokeJudge: CriterionCompletionInvoker;
  /** Credential values to redact from judge evidence and to keep out of judge prompts. */
  readonly secrets: readonly string[];
  readonly signal: AbortSignal;
  /** Test seam for the judge's fixed retry waits. */
  readonly waitBeforeRetry?: CriterionJudgeExecutionOptions['waitBeforeRetry'];
}

export interface EvaluatedSealedRun extends EvaluatedRunEvidence {
  /** Present when the plan has judging criteria. */
  readonly judgeEvidence: JudgeEvidenceV1 | undefined;
}

interface SealedRunJudgment {
  readonly criterionResults: readonly CriterionResultV1[];
  readonly judgeEvidence: JudgeEvidenceV1;
}

/** Judge a sealed run's criteria, if it has any, then run its checks and score it. */
export const evaluateSealedRun = async (
  input: EvaluateSealedRunInput,
): Promise<EvaluatedSealedRun> => {
  const judgment = await judgeSealedRun(input);
  const evaluated = await evaluateRunEvidence({
    plan: input.plan,
    trajectory: input.trajectory,
    workspace: input.workspace,
    ...(judgment === undefined
      ? {}
      : { criterionResults: judgment.criterionResults }),
    signal: input.signal,
  });
  return { ...evaluated, judgeEvidence: judgment?.judgeEvidence };
};

const judgeSealedRun = async (
  input: EvaluateSealedRunInput,
): Promise<SealedRunJudgment | undefined> => {
  const criteria = input.plan.evaluation.judging_criteria;
  if (criteria.length === 0) return undefined;
  const collected = await collectJudgeWorkspaceEvidence(input.workspace, {
    signal: input.signal,
  });
  const safeWorkspace = redactJudgeWorkspaceEvidence(
    collected.evidence,
    input.secrets,
  );
  const safeWorkspaceText = renderJudgeWorkspaceEvidence(safeWorkspace);
  const judgeTranscript = createJudgeTranscriptProjection(input.trajectory);
  const criterionResults = await judgeCriteria(
    {
      transcript: judgeTranscript,
      criteria,
      ...(input.plan.evaluation.example_answer === undefined
        ? {}
        : { exampleAnswer: input.plan.evaluation.example_answer }),
      ...(safeWorkspaceText.length === 0
        ? {}
        : { workspaceText: safeWorkspaceText }),
      signal: input.signal,
    },
    input.invokeJudge,
    {
      redactionSecrets: input.secrets,
      validateRequest: (request) =>
        assertJudgePromptWillRemainUnchanged(request, input.secrets),
      ...(input.waitBeforeRetry === undefined
        ? {}
        : { waitBeforeRetry: input.waitBeforeRetry }),
    },
  );
  return {
    criterionResults,
    judgeEvidence: buildJudgeEvidence(judgeTranscript, safeWorkspace),
  };
};

const buildJudgeEvidence = (
  judgeTranscript: JudgeTranscriptProjectionV1,
  safeWorkspace: JudgeWorkspaceEvidenceV1,
): JudgeEvidenceV1 =>
  parseJudgeEvidence(
    {
      transcript: {
        source: judgeTranscript.source,
        projection_id: judgeTranscript.projectionId,
        trajectory_scope: judgeTranscript.trajectoryScope,
        included_step_sources: [...judgeTranscript.includedStepSources],
        copied_context: judgeTranscript.copiedContext,
        included_fields: [...judgeTranscript.includedFields],
        steps: JSON.parse(judgeTranscript.transcriptJson),
      },
      workspace: {
        entries: safeWorkspace.entries.map((entry) => ({
          path: entry.path,
          content: entry.content,
          truncated: entry.truncated,
        })),
        complete: safeWorkspace.complete,
        warnings: safeWorkspace.warnings.map((warning) => ({
          ...warning,
        })),
      },
    },
    { forgeVersion: FORGE_VERSION },
  );

const redactJudgeWorkspaceEvidence = (
  evidence: JudgeWorkspaceEvidenceV1,
  secrets: readonly string[],
): JudgeWorkspaceEvidenceV1 =>
  boundJudgeWorkspaceEvidence(redactSecrets(evidence, secrets).value);

/**
 * The projected transcript and recorded workspace evidence are exact
 * substrings of the final judge prompt. CompletionRuntime still performs
 * defensive redaction, so fail closed if that final pass would rewrite any
 * prompt bytes after those evidence values were constructed. This also
 * catches secret-shaped strings formed only at JSON or prompt-template
 * boundaries.
 */
const assertJudgePromptWillRemainUnchanged = (
  request: Pick<CriterionCompletionRequest, 'systemPrompt' | 'messages'>,
  secrets: readonly string[],
): void => {
  const projected = redactSecrets(
    { systemPrompt: request.systemPrompt, messages: request.messages },
    secrets,
  );
  if (projected.replacements !== 0) {
    throw new TypeError(
      'Judge prompt cannot be sent without changing its audited evidence.',
    );
  }
};
