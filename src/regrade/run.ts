import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { parseAtifTrajectory } from '../atif/index.ts';
import type { AtifTrajectoryV1_8 } from '../atif/types.ts';
import type { CompletionProviderCollection } from '../contracts/composition.ts';
import type { CredentialResolver } from '../contracts/credentials.ts';
import { defaultForgeEngine, type ForgeEngine } from '../engine.ts';
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
  type PreparedCompletionRuntime,
  prepareCompletionRuntime,
} from '../execution/completionRuntime.ts';
import { assertJudgePromptWillRemainUnchanged } from '../execution/judgePrompt.ts';
import { sha256Digest } from '../model/hashes.ts';
import type { ModelRefV1, ResolvedRunPlanV1 } from '../model/types.ts';
import {
  completionCallSummarySchema,
  evaluationResultSchema,
  parseJudgeEvidence,
} from '../results/parse.ts';
import type {
  CompletionCallSummaryV1,
  EvaluationResultV1,
  JudgeEvidenceV1,
  RunResultV1,
} from '../results/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  assertCompatibleForgeVersion,
  FORGE_BUILD_IDENTITY,
  type ForgeBuildIdentity,
  parseForgeBuildIdentity,
} from '../version.ts';

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
  readonly regraded_at: string;
  readonly forge: ForgeBuildIdentity;
}

/** Upper bound on a saved regrade file, as for other persisted scored artifacts. */
export const MAX_REGRADE_RESULT_BYTES = 16 * 1024 * 1024;

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const modelRef = z
  .object({
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
  })
  .strict();
const regradeResultSchema = z
  .object({
    format: z.literal(REGRADE_RESULT_FORMAT),
    run_id: z.string().min(1).max(128),
    judge: modelRef,
    source: z
      .object({
        result_sha256: sha256,
        judge_evidence_sha256: sha256,
        original_judge: modelRef.nullable(),
        original_evaluation: z
          .object({
            status: z.enum(['passed', 'partial', 'failed', 'judge_error']),
            score: z.number().finite().min(0).max(1).nullable(),
          })
          .strict(),
      })
      .strict(),
    evaluation: evaluationResultSchema,
    completion_calls: z.array(completionCallSummarySchema).max(10_000),
    regraded_at: z.string().datetime({ offset: true }),
    forge: z.unknown(),
  })
  .strict();

/** The verified committed run a regrade is bound to. */
export interface RegradeSource {
  readonly result: RunResultV1;
  /** Digest of the committed `result.json` bytes. */
  readonly resultSha256: string;
}

/**
 * The one strict reader of a persisted regrade: exact format, compatible
 * Forge producer, the evaluation validator committed results use, and
 * criteria, checks and digests bound to the verified source run. Fresh
 * regrades pass through it before they are written, so saved and fresh
 * results obey the same contract. Callers bound the input size first
 * (`MAX_REGRADE_RESULT_BYTES`).
 */
export function parseRegradeResult(
  input: unknown,
  source: RegradeSource,
): RegradeResultV1 {
  const parsed = regradeResultSchema.parse(input);
  const forge = parseForgeBuildIdentity(parsed.forge);
  assertCompatibleForgeVersion(forge.version);
  const { result } = source;
  const judgeEvidence = result.artifacts.find(
    (entry) => entry.path === 'judge-evidence.json',
  );
  const same = (left: unknown, right: unknown) =>
    serializeCanonicalJson(left) === serializeCanonicalJson(right);
  const criterionIdentity = (criterion: {
    label?: string | undefined;
    requirement_level?: string | undefined;
    criterion: string;
  }) => ({
    criterion: criterion.criterion,
    ...(criterion.label === undefined ? {} : { label: criterion.label }),
    ...(criterion.requirement_level === undefined
      ? {}
      : { requirement_level: criterion.requirement_level }),
  });
  if (
    parsed.run_id !== result.run_id ||
    parsed.source.result_sha256 !== source.resultSha256 ||
    parsed.source.judge_evidence_sha256 !== judgeEvidence?.sha256 ||
    !same(parsed.source.original_evaluation, {
      status: result.evaluation.status,
      score: result.evaluation.score,
    })
  )
    throw new Error('A saved regrade does not belong to this source run.');
  if (
    !same(
      parsed.evaluation.judging_criteria.map(criterionIdentity),
      result.evaluation.judging_criteria.map(criterionIdentity),
    ) ||
    !same(parsed.evaluation.checks, result.evaluation.checks)
  )
    throw new Error(
      'A saved regrade has criteria or checks that differ from its source run.',
    );
  if (
    parsed.completion_calls.some(
      (call) => call.purpose !== 'judge' || call.model !== parsed.judge.model,
    )
  )
    throw new Error('A saved regrade has completion calls from another judge.');
  return { ...parsed, forge } as RegradeResultV1;
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

  const binding = completionBindingFor(
    dependencies.completionProviders,
    'judge',
    input.judge,
  );
  let completions: PreparedCompletionRuntime;
  try {
    completions = await prepareCompletionRuntime({
      runId: result.run_id,
      bindings: [binding],
      credentialResolver: dependencies.credentialResolver,
      signal,
    });
  } catch {
    signal.throwIfAborted();
    // Provider preflight and credential resolvers receive resolved secrets, and their errors are not
    // redacted before this point, so only a fixed message may leave this boundary (as in execution).
    throw new Error(
      'Forge could not prepare the completion provider required by this regrade.',
    );
  }
  const criteria = await judgeCriteria(
    { ...judgeInputFromSavedRun({ plan, trajectory, judgeEvidence }), signal },
    async (request) =>
      (await completions.invoke('judge', request, request.signal ?? signal))
        .content,
    {
      redactionSecrets: completions.secrets,
      // The saved evidence must reach the new judge unchanged, as in execution.
      validateRequest: (request) =>
        assertJudgePromptWillRemainUnchanged(request, completions.secrets),
      ...(input.waitBeforeJudgeRetry === undefined
        ? {}
        : { waitBeforeRetry: input.waitBeforeJudgeRetry }),
    },
  );
  const evaluation = scoreEvaluation(criteria, result.evaluation.checks);
  const resultSha256 = sha256Digest(
    await fs.readFile(path.join(completed.location, 'result.json')),
  );
  return Object.freeze(
    parseRegradeResult(
      {
        format: REGRADE_RESULT_FORMAT,
        run_id: result.run_id,
        judge: { ...input.judge },
        source: {
          result_sha256: resultSha256,
          judge_evidence_sha256: sha256Digest(judgeEvidenceBody),
          original_judge: plan.evaluation.judge ?? null,
          original_evaluation: {
            status: result.evaluation.status,
            score: result.evaluation.score,
          },
        },
        evaluation,
        completion_calls: completions.calls,
        regraded_at: (input.now ?? (() => new Date()))().toISOString(),
        forge: FORGE_BUILD_IDENTITY,
      },
      { result, resultSha256 },
    ),
  );
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
