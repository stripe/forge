import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseAtifTrajectory } from '../atif/index.ts';
import type { AtifTrajectoryV1_8 } from '../atif/types.ts';
import type { CompletionProviderCollection } from '../contracts/composition.ts';
import type { CredentialResolver } from '../contracts/credentials.ts';
import { defaultForgeEngine, type ForgeEngine } from '../engine.ts';
import { createCompletionDecisionModel } from '../evaluation/completionDecisionModel.ts';
import { criterionEvidenceWarnings } from '../evaluation/criterionEvidence.ts';
import {
  type CriterionJudgeExecutionOptions,
  type CriterionJudgeInput,
  createJudgeTranscriptProjection,
  judgeCriteria,
  scoreEvaluation,
} from '../evaluation/index.ts';
import { renderRecordedJudgeWorkspaceEvidence } from '../evaluation/judgeWorkspace.ts';
import {
  completionBindingFor,
  prepareCompletionRuntime,
} from '../execution/completionRuntime.ts';
import { sha256Digest } from '../model/hashes.ts';
import type { ModelRefV1, ResolvedRunPlanV1 } from '../model/types.ts';
import { parseEvaluationResult, parseJudgeEvidence } from '../results/parse.ts';
import type {
  CompletionCallSummaryV1,
  CompletionCallTotalsV1,
  EvaluationResultV1,
  JudgeEvidenceV1,
  RunEvidenceV1,
  RunResultV1,
} from '../results/types.ts';
import { FORGE_BUILD_IDENTITY, type ForgeBuildIdentity } from '../version.ts';

export const REGRADE_RESULT_FORMAT = 'forge-regrade-result-v1' as const;

/** One saved run graded again by a chosen judge, without changing its artifacts. */
export interface RegradeResultV1 {
  readonly format: typeof REGRADE_RESULT_FORMAT;
  readonly run_id: string;
  /** The judge used for this regrade. */
  readonly judge: ModelRefV1;
  /** Digests of the exact saved inputs, so a regrade is tied to one committed run. */
  readonly source: {
    readonly result_sha256: string;
    readonly judge_evidence_sha256: string;
    readonly original_judge: ModelRefV1 | null;
    readonly original_evaluation: Pick<EvaluationResultV1, 'status' | 'score'>;
  };
  /** Regraded criteria plus the run's original deterministic check results. */
  readonly evaluation: EvaluationResultV1;
  readonly completion_calls: readonly CompletionCallSummaryV1[];
  readonly completion_call_totals?: CompletionCallTotalsV1;
  readonly regraded_at: string;
  readonly forge: ForgeBuildIdentity;
}

/** Host capabilities a regrade needs; no runtime, agents, or artifact store. */
export interface RegradeDependencies {
  readonly completionProviders: CompletionProviderCollection;
  readonly credentialResolver: CredentialResolver;
  readonly engine?: ForgeEngine;
}

/** The verified inputs of one committed run that determine its judgments. */
export interface SavedJudgeInputs {
  readonly plan: ResolvedRunPlanV1;
  readonly trajectory: AtifTrajectoryV1_8;
  readonly judgeEvidence: JudgeEvidenceV1;
  readonly evidence?: Pick<RunEvidenceV1, 'completeness' | 'warnings'>;
}

/**
 * Rebuild the judge input a completed run used. The transcript is projected
 * from the saved trajectory (verification proves it equals the saved judge
 * evidence), and the workspace text is rendered from the saved evidence.
 */
export function judgeInputFromSavedRun(
  saved: SavedJudgeInputs,
): Omit<CriterionJudgeInput, 'signal'> {
  const workspaceText = renderRecordedJudgeWorkspaceEvidence(
    saved.judgeEvidence.workspace,
  );
  return {
    transcript: createJudgeTranscriptProjection(saved.trajectory),
    criteria: saved.plan.evaluation.judging_criteria,
    evidenceWarnings: criterionEvidenceWarnings({
      trajectory: saved.evidence ?? {
        completeness: 'partial',
        warnings: [
          {
            code: 'source_unavailable',
            message: 'Trajectory completeness was not supplied.',
          },
        ],
      },
      workspace: saved.judgeEvidence.workspace,
    }),
    ...(saved.plan.evaluation.example_answer === undefined
      ? {}
      : { exampleAnswer: saved.plan.evaluation.example_answer }),
    ...(workspaceText.length === 0 ? {} : { workspaceText }),
  };
}

/**
 * Regrade one committed run with `judge`. Returns `undefined` when the run has
 * no judging criteria. Deterministic checks are not re-run: the workspace is
 * gone, so the original check results are kept and combined with the new
 * criterion results.
 */
export async function regradeCompletedRun(
  input: {
    readonly location: string;
    readonly judge: ModelRefV1;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
    /** Test seam for the judge's fixed retry waits, as in execution. */
    readonly waitBeforeJudgeRetry?: CriterionJudgeExecutionOptions['waitBeforeRetry'];
  },
  dependencies: RegradeDependencies,
): Promise<RegradeResultV1 | undefined> {
  const engine = dependencies.engine ?? defaultForgeEngine;
  const signal = input.signal ?? new AbortController().signal;
  const completed = await engine.verifyCompletedRun(input.location);
  const result = completed.result;
  if (result.evaluation.judging_criteria.length === 0) return undefined;

  const plan = engine.parseResolvedRunPlan(
    JSON.parse(await readClaimed(completed.location, result, 'plan.json')),
  );
  const trajectory = parseAtifTrajectory(
    JSON.parse(
      await readClaimed(completed.location, result, 'trajectory.json'),
    ),
  );
  const judgeEvidenceBody = await readClaimed(
    completed.location,
    result,
    'judge-evidence.json',
  );
  const judgeEvidence = parseJudgeEvidence(JSON.parse(judgeEvidenceBody), {
    forgeVersion: result.forge.version,
  });

  const completions = await prepareCompletionRuntime({
    runId: result.run_id,
    bindings: [
      completionBindingFor(
        dependencies.completionProviders,
        'judge',
        input.judge,
      ),
    ],
    credentialResolver: dependencies.credentialResolver,
    signal,
  });
  const criteria = await judgeCriteria(
    {
      ...judgeInputFromSavedRun({
        plan,
        trajectory,
        judgeEvidence,
        evidence: result.evidence,
      }),
      signal,
    },
    createCompletionDecisionModel({
      model: input.judge,
      invoke: (request) => completions.invoke('judge', request, request.signal),
    }),
    {
      redactionSecrets: completions.secrets,
      onRetryDecision: completions.recordRetryDecision,
      ...(input.waitBeforeJudgeRetry === undefined
        ? {}
        : { waitBeforeRetry: input.waitBeforeJudgeRetry }),
    },
  );
  const evaluation = scoreEvaluation(criteria, result.evaluation.checks);
  // The same strict validator committed results pass through.
  parseEvaluationResult(evaluation);
  return Object.freeze({
    format: REGRADE_RESULT_FORMAT,
    run_id: result.run_id,
    judge: Object.freeze({ ...input.judge }),
    source: Object.freeze({
      result_sha256: sha256Digest(
        await fs.readFile(path.join(completed.location, 'result.json')),
      ),
      judge_evidence_sha256: sha256Digest(judgeEvidenceBody),
      original_judge: plan.evaluation.judge ?? null,
      original_evaluation: Object.freeze({
        status: result.evaluation.status,
        score: result.evaluation.score,
      }),
    }),
    evaluation,
    completion_calls: completions.calls,
    completion_call_totals: completions.totals,
    regraded_at: (input.now ?? (() => new Date()))().toISOString(),
    forge: FORGE_BUILD_IDENTITY,
  });
}

/** Read a claimed artifact and re-check its digest after verification. */
async function readClaimed(
  location: string,
  result: RunResultV1,
  artifactPath: string,
): Promise<string> {
  const descriptor = result.artifacts.find(
    (entry) => entry.path === artifactPath,
  );
  if (descriptor === undefined)
    throw new Error(`Completed run does not claim ${artifactPath}.`);
  const body = await fs.readFile(path.join(location, artifactPath));
  if (sha256Digest(body) !== descriptor.sha256)
    throw new Error(`${artifactPath} changed after verification.`);
  return body.toString('utf8');
}
