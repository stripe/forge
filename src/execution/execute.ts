import {createHash} from 'node:crypto';

import {
  ATIF_NORMALIZATION_VERSION,
  ATIF_SCHEMA_VERSION,
  createNormalizedTrajectory,
  parseNormalizedTrajectory,
  serializeAtifTrajectory,
  type AtifNormalizationProvenance,
  type NormalizedTrajectory,
} from '../atif/index.js';
import type {
  AgentAdapter,
  AgentEvidenceRuntime,
  AgentEvidenceIdentity,
  AgentPrepareRuntime,
  AgentRuntimeRequirements,
  AgentSession,
  AgentSessionRuntime,
  AgentTurn,
} from '../contracts/agent.js';
import type {RunArtifact, RunArtifactTransaction} from '../contracts/artifacts.js';
import type {CommandOptions, CommandRunner} from '../contracts/command.js';
import type {ForgeComposition} from '../contracts/composition.js';
import {
  createEnvironmentResolver,
  type CredentialEnvironmentBinding,
  type CredentialScope,
  type EnvironmentSpecification,
  type ResolvedEnvironment,
  type ScopedEnvironmentSpecification,
} from '../contracts/credentials.js';
import type {
  MutableWorkspace,
  PreparedRuntime,
  ReadonlyWorkspace,
  SealedRuntime,
  WorkspaceListOptions,
  WorkspaceWriteOptions,
} from '../contracts/runtime.js';
import {
  GUIDELINE_JUDGE_PROMPT_VERSION,
  collectJudgeWorkspaceEvidence,
  evaluateRunEvidence,
  judgeGuidelines,
  renderJudgeWorkspaceEvidence,
  type GuidelineCompletionRequest,
  type JudgeWorkspaceEvidenceV1,
} from '../evaluation/index.js';
import {boundJudgeWorkspaceEvidence} from '../evaluation/judgeWorkspace.js';
import {
  JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_SOURCE,
  createJudgeTranscriptProjection,
} from '../evaluation/judgeTranscript.js';
import {
  AVA_PROMPT_VERSION,
  AvaRolePlayer,
  runConversation,
  type AvaConversationAudit,
  type ConversationTurn,
} from '../interaction/index.js';
import {snapshotAgentToolCalls} from '../interaction/conversation.js';
import {
  parseResolvedRunPlan,
  type JsonValue,
  type ResolvedRunPlanV1,
} from '../model/index.js';
import {hasDeterministicWorkspaceChecks} from '../model/checks.js';
import {
  resolvedRunPlanSha256,
  serializeResolvedRunPlan,
} from '../planning/index.js';
import {
  RUN_RESULT_SCHEMA_VERSION,
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseRunResult,
  type AtifEvidenceProvenanceV1,
  type ArtifactDescriptorV1,
  type AvaDecisionV1,
  type CompletedRunV1,
  type CompletionCallSummaryV1,
  type EvaluationResultV1,
  type InteractionArtifactV1,
  type JudgeEvidenceV1,
  type RolePlayerErrorV1,
  type RunResultV1,
  type RunStopReasonV1,
  type RunWarningV1,
  type WorkspaceEvidenceV1,
} from '../results/index.js';
import {assertNoSecrets, redactSecrets} from '../security/redaction.js';
import {serializeCanonicalJson} from '../serialization.js';
import {
  createSetupExecutor,
  forgeSetupHandlers,
  type SetupStepHandler,
} from '../setup/index.js';
import {executionError, ForgeExecutionError, throwIfAborted} from './errors.js';
import {createRunEventEmitter} from './events.js';
import type {RunPhase} from '../contracts/observability.js';
import {
  parseAgentEvidenceIdentity,
  selectAgentEvidence,
} from '../evidence/selection.js';
import {
  completionBindingsForPlan,
  prepareCompletionRuntime,
  type CompletionBinding,
  type PreparedCompletionRuntime,
} from './completionRuntime.js';

export const FORGE_VERSION = '0.1.0' as const;

export interface ExecuteEvalInput {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV1;
  readonly composition: ForgeComposition;
  readonly signal?: AbortSignal;
  /** Test seam; production uses the wall clock. */
  readonly now?: () => Date;
}

interface ExecuteEvalTestHooks {
  readonly waitBeforeCompletionRetry?: (
    purpose: 'role_player' | 'judge',
    failedAttempt: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface PreflightEvalInput {
  readonly plan: ResolvedRunPlanV1;
  readonly composition: ForgeComposition;
}

interface EvalPreflight {
  readonly agent: AgentAdapter;
  readonly agentEvidenceIdentity: AgentEvidenceIdentity;
  readonly setupExecutor: ReturnType<typeof createSetupExecutor>;
  readonly requirements: AgentRuntimeRequirements;
  readonly environmentSpecification: ScopedEnvironmentSpecification;
  readonly completionBindings: readonly CompletionBinding[];
}

/**
 * Validate a resolved plan against one composition without resolving
 * credentials, allocating a runtime, or performing any other authority-bearing
 * operation. CLI validation and execution share this exact boundary.
 */
export function preflightEval(request: PreflightEvalInput): void {
  try {
    const plan = parseResolvedRunPlan(request.plan);
    buildEvalPreflight(plan, request.composition);
  } catch (error) {
    throw executionError(
      'invalid_plan',
      'preflight',
      'Forge could not execute this plan with the supplied composition.',
      error,
    );
  }
}

/** Execute one already-resolved run and return only after atomic commit. */
export async function executeEval(request: ExecuteEvalInput): Promise<CompletedRunV1> {
  return executeEvalWithTestHooks(request, {});
}

/** @internal Unexported package test seam; production always uses fixed waits. */
export async function executeEvalWithTestHooks(
  request: ExecuteEvalInput,
  hooks: ExecuteEvalTestHooks,
): Promise<CompletedRunV1> {
  let input: ExecuteEvalInput;
  try {
    input = {...request, plan: parseResolvedRunPlan(request.plan)};
  } catch (error) {
    throw executionError(
      'invalid_plan',
      'preflight',
      'Forge received an invalid resolved run plan.',
      error,
    );
  }
  const externalSignal = input.signal ?? new AbortController().signal;
  const timeoutSignal = AbortSignal.timeout(input.plan.limits.run_timeout_ms);
  const signal = AbortSignal.any([externalSignal, timeoutSignal]);
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const events = createRunEventEmitter(
    input.runId,
    input.composition.observer ? [input.composition.observer] : [],
    now,
  );
  let phase: RunPhase = 'preflight';
  let prepared: PreparedRuntime | undefined;
  let sealed: SealedRuntime | undefined;
  let transaction: RunArtifactTransaction | undefined;
  let runtimeDisposed = false;

  try {
    const preflight = await events.phase('preflight', async () => {
      phase = 'preflight';
      throwIfAborted(signal, phase);
      assertRunId(input.runId);
      return buildEvalPreflight(input.plan, input.composition);
    });

    const environment = await resolveEnvironment(
      input,
      preflight.environmentSpecification,
      signal,
    );
    let completions: PreparedCompletionRuntime;
    try {
      completions = await prepareCompletionRuntime({
        runId: input.runId,
        bindings: preflight.completionBindings,
        credentialResolver: input.composition.credentialResolver,
        redactionSecrets: credentialValues(environment),
        signal,
      });
    } catch (error) {
      throw executionError(
        'credential_failed',
        'preflight',
        'Forge could not prepare the completion providers required by this run.',
        error,
      );
    }
    const secrets = uniqueStrings([
      ...credentialValues(environment),
      ...completions.secrets,
    ]);

    prepared = await events.phase('runtime_prepare', async () => {
      phase = 'runtime_prepare';
      throwIfAborted(signal, phase);
      return input.composition.runtime.prepare({
        runId: input.runId,
        plan: input.plan,
        environment,
        requirements: {
          executables: preflight.requirements.executables,
          stateDirectories: preflight.requirements.stateDirectories,
        },
        signal,
      });
    });

    await preflight.agent.prepare({
      runId: input.runId,
      plan: input.plan,
      selection: input.plan.agent,
      runtime: projectAgentPrepareRuntime(prepared),
      inputs: input.composition.inputProvider,
      signal,
    });

    await events.phase('setup', async () => {
      phase = 'setup';
      throwIfAborted(signal, phase);
      await preflight.setupExecutor.apply(input.plan.setup, {
        runId: input.runId,
        workspace: prepared!.workspace,
        commands: prepared!.commands.setup,
        inputs: input.composition.inputProvider,
        signal,
      });
    });

    const interaction = await events.phase('interaction', async () => {
      phase = 'interaction';
      throwIfAborted(signal, phase);
      const session = await preflight.agent.openSession({
        runId: input.runId,
        plan: input.plan,
        selection: input.plan.agent,
        runtime: projectAgentSessionRuntime(prepared!),
        inputs: input.composition.inputProvider,
        signal,
      });
      return executeInteraction(
        input.plan,
        session,
        completions,
        signal,
        hooks.waitBeforeCompletionRetry,
      );
    });

    sealed = await events.phase('quiesce', async () => {
      phase = 'quiesce';
      return prepared!.quiesce();
    });

    const selectedEvidence = await events.phase('evidence', async () => {
      phase = 'evidence';
      throwIfAborted(signal, phase);
      if (interaction.turns.length === 0) {
        return rolePlayerErrorEvidence(
          input.plan,
          preflight.agent,
          preflight.agentEvidenceIdentity,
        );
      }
      if (interaction.sessionId === null) {
        throw new TypeError('A completed agent turn requires a session identity.');
      }
      const collected = await preflight.agent.collectEvidence({
        runId: input.runId,
        plan: input.plan,
        selection: input.plan.agent,
        runtime: projectAgentEvidenceRuntime(sealed!),
        sessionId: interaction.sessionId,
        signal,
      });
      const evidence = selectAgentEvidence({
        agent: preflight.agent,
        identity: preflight.agentEvidenceIdentity,
        model: input.plan.agent.model,
        sessionId: interaction.sessionId,
        completedTurns: interaction.turns,
        collected,
      });
      assertEvidenceMatchesRun(
        evidence,
        preflight.agent,
        interaction.sessionId,
      );
      return evidence;
    });
    const redacted = redactNormalizedTrajectory(selectedEvidence, secrets);
    const trajectoryJson = serializeAtifTrajectory(redacted.evidence.trajectory);

    const evaluated = await events.phase('evaluation', async () => {
      phase = 'evaluation';
      throwIfAborted(signal, phase);
      const guidelines = input.plan.evaluation.success_guidelines;
      let guidelineResults = undefined;
      let judgeEvidence: JudgeEvidenceV1 | undefined;
      if (guidelines.length > 0) {
        const collected = await collectJudgeWorkspaceEvidence(
          sealed!.workspace,
          {signal},
        );
        const safeWorkspace = redactJudgeWorkspaceEvidence(
          collected.evidence,
          secrets,
        );
        const safeWorkspaceText = renderJudgeWorkspaceEvidence(safeWorkspace);
        const judgeTranscript = createJudgeTranscriptProjection(
          redacted.evidence.trajectory,
        );
        guidelineResults = await judgeGuidelines(
          {
            transcriptJson: judgeTranscript.transcriptJson,
            guidelines,
            ...(input.plan.evaluation.example_answer === undefined
              ? {}
              : {exampleAnswer: input.plan.evaluation.example_answer}),
            ...(safeWorkspaceText.length === 0
              ? {}
              : {workspaceText: safeWorkspaceText}),
            signal,
          },
          async (request) => {
            assertJudgePromptWillRemainUnchanged(request, secrets);
            return (
              await completions.invoke(
                'judge',
                request,
                request.signal,
              )
            ).content;
          },
          hooks.waitBeforeCompletionRetry === undefined
            ? {}
            : {
                waitBeforeRetry: (attempt, retrySignal) =>
                  hooks.waitBeforeCompletionRetry!(
                    'judge',
                    attempt,
                    retrySignal ?? signal,
                  ),
              },
        );
        judgeEvidence = parseJudgeEvidence({
          schema_version: 1,
          prompt_version: GUIDELINE_JUDGE_PROMPT_VERSION,
          transcript: {
            source: JUDGE_TRANSCRIPT_SOURCE,
            projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
            projection_version: JUDGE_TRANSCRIPT_PROJECTION_VERSION,
            excluded_fields: [...JUDGE_TRANSCRIPT_EXCLUDED_FIELDS],
          },
          workspace: {
            entries: safeWorkspace.entries.map((entry) => ({
              path: entry.path,
              content: entry.content,
              truncated: entry.truncated,
            })),
            complete: safeWorkspace.complete,
            warnings: safeWorkspace.warnings.map((warning) => ({...warning})),
          },
        });
      }
      const result = await evaluateRunEvidence({
        plan: input.plan,
        trajectory: redacted.evidence.trajectory,
        workspace: sealed!.workspace,
        ...(guidelineResults === undefined ? {} : {guidelineResults}),
        signal,
      });
      return {...result, judgeEvidence};
    });

    const interactionArtifact = redactInteractionArtifact(
      buildInteractionArtifact(input.plan, interaction),
      secrets,
    );

    const coreArtifacts = buildCoreArtifacts(
      input.plan,
      trajectoryJson,
      interactionArtifact,
      evaluated.workspaceEvidence,
      evaluated.judgeEvidence,
    );
    for (const artifact of coreArtifacts) {
      assertNoSecrets(artifact.body, secrets, artifact.path);
    }
    const coreDescriptors = coreArtifacts.map(describeArtifact);
    let result = buildResult({
      input,
      agent: preflight.agent,
      runtime: sealed,
      interaction,
      completionCalls: completions.calls,
      evidence: redacted.evidence,
      redactionCount: redacted.replacements,
      evaluation: evaluated.evaluation,
      coreDescriptors,
      supplementalDescriptors: [],
      warnings: rolePlayerWarnings(interaction.failure),
      startedAt,
      completedAt: now(),
    });

    const supplementalArtifacts = await buildSupplementalArtifacts(
      input,
      result,
      secrets,
      signal,
    );
    const supplementalDescriptors = supplementalArtifacts.map(describeArtifact);
    result = {...result, supplemental_artifacts: supplementalDescriptors};

    await events.phase('artifact_stage', async () => {
      phase = 'artifact_stage';
      transaction = await input.composition.artifactStore.begin(input.runId);
      for (const artifact of [...coreArtifacts, ...supplementalArtifacts]) {
        await transaction.write(artifact);
      }
    });

    const warnings: RunWarningV1[] = rolePlayerWarnings(interaction.failure);
    await events.phase('runtime_dispose', async () => {
      phase = 'runtime_dispose';
      try {
        await prepared!.dispose();
      } catch {
        const cleanupWarning: RunWarningV1 = {
          code: 'runtime_cleanup_failed',
          message: 'Runtime cleanup failed after canonical artifacts were staged.',
        };
        warnings.push(cleanupWarning);
        await events.warning('runtime_dispose', cleanupWarning.message);
      } finally {
        runtimeDisposed = true;
      }
    });

    result = buildResult({
      input,
      agent: preflight.agent,
      runtime: sealed,
      interaction,
      completionCalls: completions.calls,
      evidence: redacted.evidence,
      redactionCount: redacted.replacements,
      evaluation: evaluated.evaluation,
      coreDescriptors,
      supplementalDescriptors,
      warnings,
      startedAt,
      completedAt: now(),
    });
    assertNoSecrets(serializeCanonicalJson(result), secrets, 'result.json');

    const committed = await events.phase('result_commit', async () => {
      phase = 'result_commit';
      return transaction!.commit(
        result as unknown as Readonly<Record<string, unknown>>,
      );
    });
    transaction = undefined;
    const committedResult = parseRunResult(committed.result);
    if (committedResult.schema_version !== RUN_RESULT_SCHEMA_VERSION) {
      throw new TypeError('Artifact store returned an unexpected result schema version.');
    }
    return {
      runId: committed.runId,
      location: committed.location,
      result: committedResult,
    };
  } catch (error) {
    await transaction?.rollback().catch(() => undefined);
    if (prepared && !runtimeDisposed) {
      await prepared.dispose().catch(() => undefined);
    }
    if (signal.aborted) {
      throw new ForgeExecutionError('aborted', phase, 'The Forge run was aborted.', {
        cause: signal.reason,
      });
    }
    throw mapExecutionError(error, phase);
  }
}

interface ExecutedInteraction {
  readonly turns: readonly ConversationTurn[];
  readonly stopReason: RunStopReasonV1;
  readonly totalCostUsd: number | null;
  readonly sessionId: string | null;
  readonly avaAudit?: AvaConversationAudit;
  readonly failure: RolePlayerErrorV1 | null;
}

async function executeInteraction(
  plan: ResolvedRunPlanV1,
  session: AgentSession,
  completions: PreparedCompletionRuntime,
  signal: AbortSignal,
  waitBeforeCompletionRetry: ExecuteEvalTestHooks['waitBeforeCompletionRetry'],
): Promise<ExecutedInteraction> {
  let lastTurnSessionId: string | undefined;
  const trackedSession: AgentSession = Object.freeze({
    sessionId: () => session.sessionId(),
    async send(
      message: string,
      options: {signal: AbortSignal},
    ): Promise<AgentTurn> {
      const declaredBeforeTurn = session.sessionId();
      if (
        declaredBeforeTurn !== undefined &&
        (!isSafeSessionIdentity(declaredBeforeTurn) ||
          (lastTurnSessionId !== undefined &&
            declaredBeforeTurn !== lastTurnSessionId))
      ) {
        throw new TypeError(
          'Agent changed session identity before a completed turn.',
        );
      }
      const turn = snapshotAgentTurn(await session.send(message, options));
      if (
        (declaredBeforeTurn !== undefined &&
          declaredBeforeTurn !== turn.sessionId) ||
        (lastTurnSessionId !== undefined &&
          lastTurnSessionId !== turn.sessionId)
      ) {
        throw new TypeError('Agent changed session identity between turns.');
      }
      const declaredSessionId = session.sessionId();
      if (
        declaredSessionId !== undefined &&
        declaredSessionId !== turn.sessionId
      ) {
        throw new TypeError(
          'Agent turn identity does not match its persistent session.',
        );
      }
      lastTurnSessionId = turn.sessionId;
      return turn;
    },
  });

  if (plan.interaction.mode === 'one_shot') {
    const response = await trackedSession.send(
      plan.interaction.effective_prompt,
      {signal},
    );
    const toolCalls = response.toolCalls.map((call) => ({...call}));
    const turns: readonly ConversationTurn[] = Object.freeze([
      Object.freeze({
        turn: 1,
        user: plan.interaction.effective_prompt,
        assistant: response.text,
        toolCalls: Object.freeze(toolCalls),
      }),
    ]);
    return Object.freeze({
      turns,
      stopReason: 'task_complete',
      totalCostUsd: response.costUsd ?? null,
      sessionId: resolveSessionId(session, lastTurnSessionId, true),
      failure: null,
    });
  }

  if (plan.role_player === undefined || plan.interaction.task === undefined) {
    throw new TypeError('A multi-turn plan requires a role-player model and task.');
  }
  const ava = new AvaRolePlayer(
    {
      task: plan.interaction.task,
      ...(plan.interaction.context === undefined
        ? {}
        : {context: plan.interaction.context}),
      ...(plan.interaction.initial_prompt === undefined
        ? {}
        : {initialPrompt: plan.interaction.initial_prompt}),
      signal,
    },
    (request) => completions.invoke('role_player', request, signal),
    waitBeforeCompletionRetry === undefined
      ? {}
      : {
          waitBeforeRetry: (attempt, retrySignal) =>
            waitBeforeCompletionRetry(
              'role_player',
              attempt,
              retrySignal,
            ),
        },
  );
  const conversation = await runConversation({
    session: trackedSession,
    ava,
    maxTurns: plan.interaction.max_turns,
    signal,
  });
  const failure = conversation.failure === null
    ? null
    : rolePlayerErrorRecord(conversation.failure);
  return Object.freeze({
    turns: conversation.turns,
    stopReason: conversation.stopReason,
    totalCostUsd: conversation.totalCostUsd,
    sessionId: resolveSessionId(
      session,
      lastTurnSessionId,
      conversation.turns.length > 0,
    ),
    avaAudit: conversation.avaAudit,
    failure,
  });
}

function snapshotAgentTurn(turn: AgentTurn): AgentTurn {
  if (
    !turn ||
    typeof turn.text !== 'string' ||
    turn.text.length > 16 * 1024 * 1024 ||
    !Array.isArray(turn.toolCalls) ||
    turn.toolCalls.length > 100_000 ||
    !isSafeSessionIdentity(turn.sessionId) ||
    (turn.costUsd !== undefined &&
      (!Number.isFinite(turn.costUsd) || turn.costUsd < 0))
  ) {
    throw new TypeError('Agent returned an invalid completed turn.');
  }
  for (const call of turn.toolCalls) {
    if (
      !call ||
      !isSafeToolMetadata(call.name) ||
      (call.id !== undefined && !isSafeToolMetadata(call.id))
    ) {
      throw new TypeError('Agent returned an invalid tool call.');
    }
  }
  return Object.freeze({
    text: turn.text,
    sessionId: turn.sessionId,
    toolCalls: snapshotAgentToolCalls(turn.toolCalls),
    ...(turn.costUsd === undefined ? {} : {costUsd: turn.costUsd}),
  });
}

function resolveSessionId(
  session: AgentSession,
  lastTurnSessionId: string | undefined,
  required: boolean,
): string | null {
  if (!required) {
    if (lastTurnSessionId !== undefined) {
      throw new TypeError(
        'Agent session identity exists without a completed turn.',
      );
    }
    return null;
  }
  const declaredSessionId = session.sessionId();
  if (
    declaredSessionId !== undefined &&
    lastTurnSessionId !== undefined &&
    declaredSessionId !== lastTurnSessionId
  ) {
    throw new TypeError(
      'Agent turn identity does not match its persistent session.',
    );
  }
  const value = declaredSessionId ?? lastTurnSessionId;
  if (!isSafeSessionIdentity(value)) {
    throw new TypeError('Agent completed without a safe session identity.');
  }
  return value;
}

function isSafeSessionIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeToolMetadata(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function rolePlayerErrorRecord(error: {
  readonly status: 'role_player_error';
  readonly errorType: 'parse_error' | 'request_error';
  readonly attempts: number;
  readonly explanation: string;
}): RolePlayerErrorV1 {
  return Object.freeze({
    status: error.status,
    error_type: error.errorType,
    attempts: error.attempts,
    explanation: error.explanation,
  });
}

function buildEvalPreflight(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
): EvalPreflight {
  assertExecutablePlan(plan);
  const agent = selectedAgent(plan, composition);
  const agentEvidenceIdentity = parseAgentEvidenceIdentity(
    agent.evidenceIdentity(plan.agent),
  );
  const setupExecutor = setupExecutorFor(composition);
  setupExecutor.preflight(plan.setup);
  const requirements = normalizeAgentRequirements(
    agent.requirements(plan.agent),
  );
  const setupSpecifications = setupEnvironmentSpecifications(plan, composition);
  const environmentSpecification = mergeEnvironmentSpecifications([
    {scope: 'agent', specification: requirements.environment},
    ...setupSpecifications.map((specification) => ({
      scope: 'setup' as const,
      specification,
    })),
  ]);
  const completionBindings = completionBindingsForPlan(plan, composition);
  return Object.freeze({
    agent,
    agentEvidenceIdentity,
    setupExecutor,
    requirements,
    environmentSpecification,
    completionBindings,
  });
}

function assertExecutablePlan(plan: ResolvedRunPlanV1): void {
  if (plan.schema_version !== 1) {
    throw new ForgeExecutionError('invalid_plan', 'preflight', 'Unsupported run-plan version.');
  }
  if (plan.provenance.forge.version !== FORGE_VERSION) {
    throw new ForgeExecutionError(
      'invalid_plan',
      'preflight',
      `Run plan requires Forge ${plan.provenance.forge.version}; this build is ${FORGE_VERSION}.`,
    );
  }
  if (plan.runtime.image.kind !== 'forge') {
    throw new ForgeExecutionError('invalid_plan', 'preflight', 'Only Forge-owned images are supported.');
  }
  // Defensive JSON/canonicalization check before any credential or runtime use.
  serializeResolvedRunPlan(plan);
}

function selectedAgent(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
): AgentAdapter {
  const agent = composition.agents.get(plan.agent.adapter);
  if (!agent || agent.id !== plan.agent.adapter) {
    throw new ForgeExecutionError(
      'unsupported_capability',
      'preflight',
      `No agent adapter is registered for ${plan.agent.adapter}.`,
    );
  }
  return agent;
}

function setupExecutorFor(composition: ForgeComposition) {
  const extensions = new Map<string, SetupStepHandler>();
  for (const [uses, handler] of composition.setupHandlers) {
    const builtin = forgeSetupHandlers.get(uses);
    if (builtin) {
      if (handler !== builtin) {
        throw new TypeError(`Built-in setup handler ${uses} cannot be replaced.`);
      }
      continue;
    }
    extensions.set(uses, handler);
  }
  return createSetupExecutor({handlers: extensions});
}

function setupEnvironmentSpecifications(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
): EnvironmentSpecification[] {
  return plan.setup.flatMap((step) => {
    const handler = composition.setupHandlers.get(step.uses) ?? forgeSetupHandlers.get(step.uses);
    const specification = handler?.requirements?.(step);
    return specification ? [specification] : [];
  });
}

async function resolveEnvironment(
  input: ExecuteEvalInput,
  specification: ScopedEnvironmentSpecification,
  signal: AbortSignal,
): Promise<ResolvedEnvironment> {
  try {
    return await createEnvironmentResolver(input.composition.credentialResolver).resolve(
      specification,
      {runId: input.runId, purpose: 'forge-eval', signal},
    );
  } catch (error) {
    throw executionError(
      'credential_failed',
      'preflight',
      'Forge could not resolve the credentials required by this run.',
      error,
    );
  }
}

interface ScopedEnvironmentDeclaration {
  readonly scope: CredentialScope;
  readonly specification: EnvironmentSpecification;
}

function mergeEnvironmentSpecifications(
  declarations: readonly ScopedEnvironmentDeclaration[],
): ScopedEnvironmentSpecification {
  const variables: Record<string, string> = {};
  const credentials: Record<string, CredentialEnvironmentBinding> = {};
  for (const {scope, specification} of declarations) {
    for (const [name, value] of Object.entries(specification.variables ?? {})) {
      if (Object.hasOwn(credentials, name)) {
        throw new TypeError(`Environment ${name} has conflicting plain and secret bindings.`);
      }
      if (Object.hasOwn(variables, name) && variables[name] !== value) {
        throw new TypeError(`Environment ${name} has conflicting values.`);
      }
      defineRecordValue(variables, name, value);
    }
    for (const [name, binding] of Object.entries(specification.credentials ?? {})) {
      if (Object.hasOwn(variables, name)) {
        throw new TypeError(`Environment ${name} has conflicting plain and secret bindings.`);
      }
      if (
        !binding ||
        typeof binding.reference !== 'string' ||
        binding.reference.length === 0 ||
        binding.reference.includes('\0')
      ) {
        throw new TypeError(`Environment ${name} has an invalid credential reference.`);
      }
      if ('scopes' in binding) {
        throw new TypeError(
          `Environment ${name} cannot assign its own credential scopes.`,
        );
      }
      const previous = Object.hasOwn(credentials, name)
        ? credentials[name]
        : undefined;
      if (previous && previous.reference !== binding.reference) {
        throw new TypeError(`Environment ${name} has conflicting credential references.`);
      }
      defineRecordValue(
        credentials,
        name,
        Object.freeze({
          reference: binding.reference,
          scopes: orderedCredentialScopes(previous?.scopes ?? [], scope),
        }),
      );
    }
  }
  return Object.freeze({
    variables: Object.freeze(variables),
    credentials: Object.freeze(credentials),
  });
}

function normalizeAgentRequirements(
  requirements: AgentRuntimeRequirements,
): AgentRuntimeRequirements {
  if (!requirements || !Array.isArray(requirements.executables)) {
    throw new TypeError('Agent executable requirements must be an array.');
  }
  if (!Array.isArray(requirements.stateDirectories)) {
    throw new TypeError('Agent state-directory requirements must be an array.');
  }
  const seenExecutables = new Set<string>();
  const executables = requirements.executables.map((executable) => {
    if (
      typeof executable !== 'string' ||
      executable.length === 0 ||
      executable.length > 1_024 ||
      executable.includes('\0')
    ) {
      throw new TypeError('Agent executable requirements must be bounded non-empty strings.');
    }
    if (seenExecutables.has(executable)) {
      throw new TypeError(`Duplicate agent executable requirement: ${executable}`);
    }
    seenExecutables.add(executable);
    return executable;
  });
  return Object.freeze({
    executables: Object.freeze(executables),
    environment: requirements.environment,
    stateDirectories: Object.freeze(
      requirements.stateDirectories.map(({id, containerPath}) =>
        Object.freeze({id, containerPath}),
      ),
    ),
  });
}

function orderedCredentialScopes(
  existing: readonly CredentialScope[],
  added: CredentialScope,
): readonly CredentialScope[] {
  const selected = new Set<CredentialScope>([...existing, added]);
  return Object.freeze(
    (['setup', 'agent'] as const).filter((scope) => selected.has(scope)),
  );
}

function defineRecordValue<T>(
  record: Record<string, T>,
  name: string,
  value: T,
): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function projectAgentPrepareRuntime(runtime: PreparedRuntime): AgentPrepareRuntime {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    workspace: projectMutableWorkspace(runtime.workspace),
    paths: Object.freeze({...runtime.paths}),
    stateDirectories: projectWorkspaceMap(
      runtime.stateDirectories,
      projectMutableWorkspace,
    ),
    commands: Object.freeze({
      uncredentialed: projectCommandRunner(runtime.commands.uncredentialed),
    }),
  });
}

function projectAgentSessionRuntime(runtime: PreparedRuntime): AgentSessionRuntime {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    workspace: projectMutableWorkspace(runtime.workspace),
    paths: Object.freeze({...runtime.paths}),
    stateDirectories: projectWorkspaceMap(
      runtime.stateDirectories,
      projectMutableWorkspace,
    ),
    commands: Object.freeze({
      agent: projectCommandRunner(runtime.commands.agent),
    }),
  });
}

function projectAgentEvidenceRuntime(runtime: SealedRuntime): AgentEvidenceRuntime {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    workspace: projectReadonlyWorkspace(runtime.workspace),
    paths: Object.freeze({...runtime.paths}),
    stateDirectories: projectWorkspaceMap(
      runtime.stateDirectories,
      projectReadonlyWorkspace,
    ),
    metadata: Object.freeze({...runtime.metadata}),
  });
}

function projectCommandRunner(runner: CommandRunner): CommandRunner {
  return Object.freeze({
    run: (argv: readonly string[], options?: CommandOptions) =>
      runner.run(argv, options),
  });
}

function projectReadonlyWorkspace(workspace: ReadonlyWorkspace): ReadonlyWorkspace {
  return Object.freeze({
    inspect: (relativePath: string) => workspace.inspect(relativePath),
    readFile: (relativePath: string, options?: {maxBytes?: number}) =>
      workspace.readFile(relativePath, options),
    listFiles: (options?: WorkspaceListOptions) => workspace.listFiles(options),
  });
}

function projectMutableWorkspace(workspace: MutableWorkspace): MutableWorkspace {
  const readonly = projectReadonlyWorkspace(workspace);
  return Object.freeze({
    inspect: readonly.inspect,
    readFile: readonly.readFile,
    listFiles: readonly.listFiles,
    writeFile: (
      relativePath: string,
      body: Uint8Array,
      options?: WorkspaceWriteOptions,
    ) => workspace.writeFile(relativePath, body, options),
  });
}

function projectWorkspaceMap<InputWorkspace, OutputWorkspace>(
  workspaces: ReadonlyMap<string, InputWorkspace>,
  project: (workspace: InputWorkspace) => OutputWorkspace,
): ReadonlyMap<string, OutputWorkspace> {
  return Object.freeze(
    new ReadonlyMapSnapshot(
      [...workspaces].map(([id, workspace]) => [id, project(workspace)] as const),
    ),
  );
}

class ReadonlyMapSnapshot<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: ReadonlyMap<Key, Value>;

  constructor(entries: Iterable<readonly [Key, Value]>) {
    this.#values = new Map(entries);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }

  has(key: Key): boolean {
    return this.#values.has(key);
  }

  forEach(
    callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callback.call(thisArg, value, key, this);
    }
  }

  entries() {
    return this.#values.entries();
  }

  keys() {
    return this.#values.keys();
  }

  values() {
    return this.#values.values();
  }

  [Symbol.iterator]() {
    return this.#values[Symbol.iterator]();
  }
}

function redactNormalizedTrajectory(
  evidence: NormalizedTrajectory,
  secrets: readonly string[],
): {evidence: NormalizedTrajectory; replacements: number} {
  const redacted = redactSecrets(evidence, secrets);
  return {
    replacements: redacted.replacements,
    evidence: parseNormalizedTrajectory(redacted.value),
  };
}

function rolePlayerErrorEvidence(
  plan: ResolvedRunPlanV1,
  agent: AgentAdapter,
  identity: AgentEvidenceIdentity,
): NormalizedTrajectory {
  return createNormalizedTrajectory({
    trajectory: {
      schema_version: ATIF_SCHEMA_VERSION,
      agent: {
        name: identity.name,
        version: identity.version,
        model_name: plan.agent.model,
      },
      steps: [
        {
          step_id: 1,
          source: 'system',
          message:
            'The role player failed before any coding-agent turn completed.',
        },
      ],
    },
    provenance: {
      source: {
        kind: 'role_player_error',
        format: 'forge-system-event',
      },
      adapter: {id: agent.id, version: agent.version},
    },
    completeness: 'fallback',
    warnings: [
      {
        code: 'fallback_used',
        message:
          'Canonical ATIF contains only a system event because the role player failed before the agent was invoked.',
      },
    ],
  });
}

function redactJudgeWorkspaceEvidence(
  evidence: JudgeWorkspaceEvidenceV1,
  secrets: readonly string[],
): JudgeWorkspaceEvidenceV1 {
  return boundJudgeWorkspaceEvidence(
    redactSecrets(evidence, secrets).value,
  );
}

function buildInteractionArtifact(
  plan: ResolvedRunPlanV1,
  interaction: ExecutedInteraction,
): InteractionArtifactV1 {
  const turns = interaction.turns.map((turn) => ({
    turn: turn.turn,
    user: turn.user,
    assistant: turn.assistant,
    tool_calls: turn.toolCalls.map((call) => ({
      ...(call.id === undefined ? {} : {id: call.id}),
      name: call.name,
      ...(call.input === undefined ? {} : {input: jsonValue(call.input)}),
    })),
  }));
  const rolePlayer = interaction.avaAudit === undefined || plan.role_player === undefined
    ? {}
    : {
        role_player: {
          model: {...plan.role_player},
          prompt_version: AVA_PROMPT_VERSION,
          needs: interaction.avaAudit.needs?.map((need) => ({...need})) ?? null,
          decisions: interaction.avaAudit.decisions.map(avaDecisionRecord),
        },
      };
  return {
    schema_version: 1,
    mode: plan.interaction.mode,
    stop_reason: interaction.stopReason,
    turns,
    ...rolePlayer,
    failure: interaction.failure,
  };
}

function avaDecisionRecord(
  decision: AvaConversationAudit['decisions'][number],
): AvaDecisionV1 {
  return {
    sequence: decision.sequence,
    after_agent_turn: decision.afterAgentTurn,
    message: decision.message,
    stop: decision.stop,
    remaining_need_ids: decision.remainingNeedIds,
    focus_need_id: decision.focusNeedId,
    coding_agent_invoked: decision.codingAgentInvoked,
    source: decision.source,
    ...(decision.error === undefined
      ? {}
      : {error: rolePlayerErrorRecord(decision.error)}),
  };
}

function redactInteractionArtifact(
  artifact: InteractionArtifactV1,
  secrets: readonly string[],
): InteractionArtifactV1 {
  return parseInteractionArtifact(redactSecrets(artifact, secrets).value);
}

function jsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : (JSON.parse(serialized) as JsonValue);
  } catch {
    return null;
  }
}

function rolePlayerWarnings(
  failure: RolePlayerErrorV1 | null,
): RunWarningV1[] {
  return failure === null
    ? []
    : [{code: 'role_player_error', message: failure.explanation}];
}

function assertEvidenceMatchesRun(
  evidence: NormalizedTrajectory,
  agent: AgentAdapter,
  sessionId: string | null,
): void {
  if (
    evidence.provenance.adapter.id !== agent.id ||
    evidence.provenance.adapter.version !== agent.version
  ) {
    throw new TypeError('Evidence provenance does not match the selected agent adapter.');
  }
  const sourceSessionId =
    'sessionId' in evidence.provenance.source
      ? evidence.provenance.source.sessionId
      : undefined;
  if (sessionId !== null && sourceSessionId === undefined) {
    throw new TypeError(
      'Evidence provenance does not identify the selected session.',
    );
  }
  if (sourceSessionId !== undefined && sourceSessionId !== sessionId) {
    throw new TypeError('Evidence provenance does not match the selected session.');
  }
  if (
    evidence.trajectory.session_id != null &&
    evidence.trajectory.session_id !== sessionId
  ) {
    throw new TypeError('ATIF trajectory does not match the selected session.');
  }
}

function buildCoreArtifacts(
  plan: ResolvedRunPlanV1,
  trajectoryJson: string,
  interaction: InteractionArtifactV1,
  workspaceEvidence: WorkspaceEvidenceV1,
  judgeEvidence: JudgeEvidenceV1 | undefined,
): RunArtifact[] {
  return [
    jsonArtifact('plan.json', serializeResolvedRunPlan(plan)),
    jsonArtifact('trajectory.json', trajectoryJson),
    jsonArtifact('interaction.json', serializeCanonicalJson(interaction)),
    ...(hasDeterministicWorkspaceChecks(plan.evaluation.checks)
      ? [
          jsonArtifact(
            'workspace-evidence.json',
            serializeCanonicalJson(workspaceEvidence),
          ),
        ]
      : []),
    ...(judgeEvidence === undefined
      ? []
      : [jsonArtifact('judge-evidence.json', serializeCanonicalJson(judgeEvidence))]),
  ];
}

async function buildSupplementalArtifacts(
  input: ExecuteEvalInput,
  result: RunResultV1,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<RunArtifact[]> {
  const artifacts: RunArtifact[] = [];
  for (const contributor of input.composition.contributors ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(contributor.id)) {
      throw new TypeError('Artifact contributor IDs must be safe identifiers.');
    }
    const contributed = await contributor.contribute({
      runId: input.runId,
      result: result as unknown as Readonly<Record<string, unknown>>,
      signal,
    });
    for (const artifact of contributed) {
      if (!artifact.path.startsWith(`extensions/${contributor.id}/`)) {
        throw new TypeError(`Contributor ${contributor.id} wrote outside its namespace.`);
      }
      assertNoSecrets(artifact.body, secrets, artifact.path);
      artifacts.push(artifact);
    }
  }
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) throw new TypeError(`Duplicate supplemental artifact: ${artifact.path}`);
    paths.add(artifact.path);
  }
  return artifacts;
}

function buildResult(input: {
  input: ExecuteEvalInput;
  agent: AgentAdapter;
  runtime: SealedRuntime;
  interaction: ExecutedInteraction;
  completionCalls: readonly CompletionCallSummaryV1[];
  evidence: NormalizedTrajectory;
  redactionCount: number;
  evaluation: EvaluationResultV1;
  coreDescriptors: ArtifactDescriptorV1[];
  supplementalDescriptors: ArtifactDescriptorV1[];
  warnings: RunWarningV1[];
  startedAt: Date;
  completedAt: Date;
}): RunResultV1 {
  return {
    schema_version: RUN_RESULT_SCHEMA_VERSION,
    run_id: input.input.runId,
    selection: input.input.plan.selection,
    plan_sha256: resolvedRunPlanSha256(input.input.plan),
    forge: {version: FORGE_VERSION},
    runtime: {
      adapter: input.input.composition.runtime.id,
      runtime_id: input.runtime.runtimeId,
      platform: input.input.plan.runtime.platform,
      metadata: input.runtime.metadata,
    },
    agent: {
      adapter: input.agent.id,
      adapter_version: input.agent.version,
      provider: input.input.plan.agent.provider,
      model: input.input.plan.agent.model,
      session_id: input.interaction.sessionId,
      cost_usd: input.interaction.totalCostUsd,
    },
    completion_calls: input.completionCalls.map((call) => ({...call})),
    interaction: {
      mode: input.input.plan.interaction.mode,
      turn_count: input.interaction.turns.length,
    },
    failure: input.interaction.failure,
    evidence: {
      format: 'atif',
      schema_version: ATIF_SCHEMA_VERSION,
      normalization_version: ATIF_NORMALIZATION_VERSION,
      provenance: resultEvidenceProvenance(input.evidence.provenance),
      completeness: input.evidence.completeness,
      warnings: input.evidence.warnings,
      redaction_count: input.redactionCount,
    },
    evaluation: input.evaluation,
    started_at: input.startedAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
    duration_ms: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
    stop_reason: input.interaction.stopReason,
    artifacts: input.coreDescriptors,
    supplemental_artifacts: input.supplementalDescriptors,
    warnings: input.warnings,
  };
}

function resultEvidenceProvenance(
  provenance: AtifNormalizationProvenance,
): AtifEvidenceProvenanceV1 {
  const session =
    'sessionId' in provenance.source && provenance.source.sessionId !== undefined
      ? {session_id: provenance.source.sessionId}
      : {};
  const source = provenance.source.kind === 'native_log'
    ? {
        kind: provenance.source.kind,
        format: provenance.source.format,
        ...session,
      }
    : provenance.source.kind === 'atif'
      ? {
          kind: provenance.source.kind,
          format: provenance.source.format,
          schema_version: provenance.source.schemaVersion,
          ...session,
        }
      : provenance.source.kind === 'driver_fallback'
        ? {
            kind: provenance.source.kind,
            format: provenance.source.format,
            ...session,
          }
        : {
          kind: provenance.source.kind,
          format: provenance.source.format,
        };
  return {
    source,
    adapter: {...provenance.adapter},
  };
}

function jsonArtifact(path: string, body: string): RunArtifact {
  return {path, body: Buffer.from(body, 'utf8'), mediaType: 'application/json'};
}

function describeArtifact(artifact: RunArtifact): ArtifactDescriptorV1 {
  const hash = canonicalBytesSha256(artifact.body);
  return {
    path: artifact.path,
    media_type: artifact.mediaType,
    size_bytes: artifact.body.byteLength,
    sha256: hash,
  };
}

function canonicalBytesSha256(body: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

/**
 * The projected transcript and recorded workspace evidence are exact
 * substrings of the final judge prompt. CompletionRuntime still performs
 * defensive redaction, so fail closed if that final pass would rewrite any
 * prompt bytes after those evidence values were constructed. This also
 * catches secret-shaped strings formed only at JSON or prompt-template
 * boundaries.
 */
function assertJudgePromptWillRemainUnchanged(
  request: Pick<GuidelineCompletionRequest, 'systemPrompt' | 'messages'>,
  secrets: readonly string[],
): void {
  const projected = redactSecrets(
    {systemPrompt: request.systemPrompt, messages: request.messages},
    secrets,
  );
  if (projected.replacements !== 0) {
    throw new TypeError(
      'Judge prompt cannot be sent without changing its audited evidence.',
    );
  }
}

function credentialValues(environment: ResolvedEnvironment): string[] {
  return Object.values(environment.credentials).map(({value}) => value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new ForgeExecutionError('invalid_plan', 'preflight', 'runId is not a safe identifier.');
  }
}

function mapExecutionError(error: unknown, phase: RunPhase): ForgeExecutionError {
  if (error instanceof ForgeExecutionError) return error;
  const code = phase === 'preflight'
    ? 'invalid_plan'
    : phase === 'runtime_prepare' || phase === 'quiesce' || phase === 'runtime_dispose'
      ? 'runtime_failed'
      : phase === 'setup'
        ? 'setup_failed'
        : phase === 'interaction'
          ? 'agent_failed'
          : phase === 'evidence'
            ? 'evidence_failed'
            : phase === 'evaluation'
              ? 'evaluation_failed'
              : 'artifact_failed';
  return executionError(code, phase, `Forge failed during ${phase}.`, error);
}
