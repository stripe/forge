import * as path from 'node:path';
import {
  ATIF_SCHEMA_VERSION,
  type AtifNormalizationProvenance,
  createNormalizedTrajectory,
  type NormalizedTrajectory,
  parseNormalizedTrajectory,
  serializeAtifTrajectory,
} from '../atif/index.ts';
import type {
  AgentAdapter,
  AgentEvidenceIdentity,
  AgentEvidenceRuntime,
  AgentNativeArtifact,
  AgentNativeEvidenceResult,
  AgentPrepareRuntime,
  AgentRuntimeRequirements,
  AgentSession,
  AgentSessionRuntime,
  AgentTurn,
} from '../contracts/agent.ts';
import type {
  RunArtifact,
  RunArtifactTransaction,
} from '../contracts/artifacts.ts';
import type { CommandOptions, CommandRunner } from '../contracts/command.ts';
import type { ForgeComposition } from '../contracts/composition.ts';
import {
  type CredentialEnvironmentBinding,
  type CredentialReference,
  type CredentialScope,
  credentialReference,
  type EnvironmentSpecification,
  normalizeEnvironmentSpecification,
  normalizeScopedEnvironmentSpecification,
  type ResolvedEnvironment,
  type ScopedEnvironmentSpecification,
} from '../contracts/credentials.ts';
import {
  type AgentAdapterMetadata,
  agentAdapterMetadataSchema,
} from '../contracts/metadata.ts';
import type { RunPhase } from '../contracts/observability.ts';
import type {
  MutableWorkspace,
  PreparedRuntime,
  ReadonlyWorkspace,
  RuntimeRequirements,
  RuntimeStateDirectoryRequirement,
  SealedRuntime,
  WorkspaceListOptions,
  WorkspaceWriteOptions,
} from '../contracts/runtime.ts';
import {
  type RuntimeCredentialDeclaration,
  resolveCredentialDeclarations,
  validateCredentialDeclarations,
} from '../credentialDeclarations.ts';
import {
  type CriterionCompletionRequest,
  collectJudgeWorkspaceEvidence,
  evaluateRunEvidence,
  type JudgeWorkspaceEvidenceV1,
  judgeCriteria,
  renderJudgeWorkspaceEvidence,
} from '../evaluation/index.ts';
import { createJudgeTranscriptProjection } from '../evaluation/judgeTranscript.ts';
import { boundJudgeWorkspaceEvidence } from '../evaluation/judgeWorkspace.ts';
import {
  parseAgentEvidenceIdentity,
  selectAgentEvidence,
} from '../evidence/selection.ts';
import { snapshotAgentToolCalls } from '../interaction/conversation.ts';
import {
  type AvaConversationAudit,
  AvaRolePlayer,
  type ConversationTurn,
  runConversation,
} from '../interaction/index.ts';
import { hasDeterministicWorkspaceChecks } from '../model/checks.ts';
import { sha256Digest } from '../model/hashes.ts';
import {
  isSafeSimpleIdentifier,
  type JsonValue,
  type ResolvedRunPlanV1,
} from '../model/index.ts';
import { parseResolvedRunPlanWithSetupActions } from '../model/parse.ts';
import { serializeResolvedRunPlan } from '../planning/index.ts';
import {
  type ArtifactDescriptorV1,
  type AtifEvidenceProvenanceV1,
  type AvaDecisionV1,
  type CompletedRunV1,
  type CompletionCallSummaryV1,
  type EvaluationResultV1,
  type InteractionArtifactV1,
  type JudgeEvidenceV1,
  MAX_SETUP_ARTIFACT_BYTES,
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseRunResult,
  parseSetupArtifact,
  type RolePlayerErrorV1,
  type RunResultV1,
  type RunStopReasonV1,
  type RunWarningV1,
  type SetupArtifactV1,
  type WorkspaceEvidenceV1,
} from '../results/index.ts';
import {
  assertNoSecrets,
  assertNoSecretsInJsonValue,
  redactSecrets,
} from '../security/redaction.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  createSetupExecutorForRegistry,
  preparedSetupCredentialDeclarations,
} from '../setup/executor.ts';
import type {
  AppliedSetup,
  PreparedSetup,
  SetupExecutor,
} from '../setup/index.ts';
import {
  defaultSetupActionRegistry,
  type SetupActionRegistry,
} from '../setup/registry.ts';
import {
  assertCompatibleForgeVersion,
  FORGE_BUILD_IDENTITY,
  FORGE_VERSION,
} from '../version.ts';
import {
  type CompletionBinding,
  completionBindingsForPlan,
  type PreparedCompletionRuntime,
  prepareCompletionRuntime,
} from './completionRuntime.ts';
import {
  executionError,
  ForgeExecutionError,
  throwIfAborted,
} from './errors.ts';
import { createRunEventEmitter } from './events.ts';

const MAX_NATIVE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SAFE_NATIVE_FORMAT = /^[a-z0-9][a-z0-9._+-]{0,127}$/i;
const SAFE_NATIVE_MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const SAFE_NATIVE_EXTENSION = /^[a-z0-9]{1,16}$/;

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
  /** Injects first-party test actions without exposing a host action registry. */
  readonly setupExecutor?: SetupExecutor;
}

export interface PreflightEvalInput {
  readonly plan: ResolvedRunPlanV1;
  readonly composition: ForgeComposition;
}

/** A normalized selected consumer, retaining its original credential identity. */
export interface EvalCredentialUse {
  readonly reference: CredentialReference;
  readonly purpose: string;
  /** Present for runtime consumers; host completion credentials have no slot. */
  readonly environmentName?: string;
}

interface EvalPreflight {
  readonly agent: AgentAdapter;
  readonly agentMetadata: AgentAdapterMetadata | undefined;
  readonly agentEvidenceIdentity: AgentEvidenceIdentity;
  readonly setup: PreparedSetup;
  readonly requirements: RuntimeRequirements;
  readonly environmentSpecification: ScopedEnvironmentSpecification;
  readonly credentialDeclarations: readonly RuntimeCredentialDeclaration[];
  readonly completionBindings: readonly CompletionBinding[];
}

/**
 * Validate a resolved plan against one composition without resolving
 * credentials, allocating a runtime, or performing any other authority-bearing
 * operation. CLI validation and execution share this exact boundary.
 */
export function preflightEval(request: PreflightEvalInput): void {
  preflightEvalWithSetupActions(request, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function preflightEvalWithSetupActions(
  request: PreflightEvalInput,
  setupActions: SetupActionRegistry,
): void {
  try {
    const plan = parseResolvedRunPlanWithSetupActions(
      request.plan,
      setupActions,
    );
    buildEvalPreflight(
      plan,
      request.composition,
      createSetupExecutorForRegistry(setupActions, true),
    );
  } catch (error) {
    throw executionError(
      'invalid_plan',
      'preflight',
      'Forge could not execute this plan with the supplied composition.',
      error,
    );
  }
}

/** @internal Engine-bound pure discovery before a host finalizes source bindings. */
export function inspectEvalCredentialsWithSetupActions(
  request: PreflightEvalInput,
  setupActions: SetupActionRegistry,
): readonly EvalCredentialUse[] {
  try {
    const plan = parseResolvedRunPlanWithSetupActions(
      request.plan,
      setupActions,
    );
    const preflight = buildEvalPreflight(
      plan,
      request.composition,
      createSetupExecutorForRegistry(setupActions, true),
      false,
    );
    return Object.freeze([
      ...preflight.credentialDeclarations.map(
        ({ environmentName, reference }) =>
          Object.freeze({
            environmentName,
            reference,
            purpose: `forge-eval:${environmentName}`,
          }),
      ),
      ...preflight.completionBindings.flatMap((binding) =>
        Object.entries(binding.requirements.credentials ?? {}).map(
          ([name, { reference }]) =>
            Object.freeze({
              reference,
              purpose: `forge-eval:completion:${binding.purpose}:${name}`,
            }),
        ),
      ),
    ]);
  } catch (error) {
    throw executionError(
      'invalid_plan',
      'preflight',
      'Forge could not inspect this plan with the supplied composition.',
      error,
    );
  }
}

/** Execute one already-resolved run and return only after atomic commit. */
export async function executeEval(
  request: ExecuteEvalInput,
): Promise<CompletedRunV1> {
  return executeEvalWithSetupActions(request, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export async function executeEvalWithSetupActions(
  request: ExecuteEvalInput,
  setupActions: SetupActionRegistry,
): Promise<CompletedRunV1> {
  return executeEvalWithTestHooks(request, {}, setupActions);
}

/** @internal Unexported package test seam; production always uses fixed waits. */
export async function executeEvalWithTestHooks(
  request: ExecuteEvalInput,
  hooks: ExecuteEvalTestHooks,
  setupActions: SetupActionRegistry = defaultSetupActionRegistry,
): Promise<CompletedRunV1> {
  let input: ExecuteEvalInput;
  try {
    input = {
      ...request,
      plan: parseResolvedRunPlanWithSetupActions(request.plan, setupActions),
    };
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
    input.composition.observer ? [input.composition.observer] : [],
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
      return buildEvalPreflight(
        input.plan,
        input.composition,
        hooks.setupExecutor ??
          createSetupExecutorForRegistry(setupActions, true),
      );
    });

    const environment = await resolveEnvironment(
      input,
      preflight.environmentSpecification,
      preflight.credentialDeclarations,
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

    const setupArtifact = await events.phase('setup', async () => {
      phase = 'setup';
      throwIfAborted(signal, phase);
      const applied = await preflight.setup.apply({
        runId: input.runId,
        paths: prepared!.paths,
        workspace: prepared!.workspace,
        stateDirectories: prepared!.stateDirectories,
        commands: Object.freeze({
          uncredentialed: prepared!.commands.uncredentialed,
          setup: (credentialEnvironmentNames: readonly string[]) =>
            prepared!.commands.setup(credentialEnvironmentNames),
        }),
        inputs: input.composition.inputProvider,
        signal,
      });
      const artifact = buildSetupArtifact(input.plan, applied);
      assertNoSecretsInJsonValue(artifact, secrets, 'setup.json');
      assertNoSecrets(serializeCanonicalJson(artifact), secrets, 'setup.json');
      throwIfAborted(signal, phase);
      await prepared!.finalizeSetup();
      return artifact;
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
        return {
          evidence: rolePlayerErrorEvidence(
            input.plan,
            preflight.agent,
            preflight.agentEvidenceIdentity,
          ),
          nativeArtifact: undefined,
        };
      }
      if (interaction.sessionId === null) {
        throw new TypeError(
          'A completed agent turn requires a session identity.',
        );
      }
      const evidenceContext = {
        runId: input.runId,
        plan: input.plan,
        selection: input.plan.agent,
        runtime: projectAgentEvidenceRuntime(sealed!),
        sessionId: interaction.sessionId,
        signal,
      };
      const captured =
        await preflight.agent.collectNativeArtifact?.(evidenceContext);
      const collected = await preflight.agent.collectEvidence(evidenceContext);
      const nativeArtifact = buildNativeArtifact(
        captured,
        collected,
        preflight.agent,
        interaction.sessionId,
      );
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
      return { evidence, nativeArtifact };
    });
    const redacted = redactNormalizedTrajectory(
      selectedEvidence.evidence,
      secrets,
    );
    const trajectoryJson = serializeAtifTrajectory(
      redacted.evidence.trajectory,
    );

    const evaluated = await events.phase('evaluation', async () => {
      phase = 'evaluation';
      throwIfAborted(signal, phase);
      const criteria = input.plan.evaluation.judging_criteria;
      let criterionResults:
        | Awaited<ReturnType<typeof judgeCriteria>>
        | undefined;
      let judgeEvidence: JudgeEvidenceV1 | undefined;
      if (criteria.length > 0) {
        const collected = await collectJudgeWorkspaceEvidence(
          sealed!.workspace,
          { signal },
        );
        const safeWorkspace = redactJudgeWorkspaceEvidence(
          collected.evidence,
          secrets,
        );
        const safeWorkspaceText = renderJudgeWorkspaceEvidence(safeWorkspace);
        const judgeTranscript = createJudgeTranscriptProjection(
          redacted.evidence.trajectory,
        );
        criterionResults = await judgeCriteria(
          {
            transcript: judgeTranscript,
            criteria,
            ...(input.plan.evaluation.example_answer === undefined
              ? {}
              : { exampleAnswer: input.plan.evaluation.example_answer }),
            ...(safeWorkspaceText.length === 0
              ? {}
              : { workspaceText: safeWorkspaceText }),
            signal,
          },
          async (request) => {
            return (await completions.invoke('judge', request, request.signal))
              .content;
          },
          {
            redactionSecrets: secrets,
            validateRequest: (request) =>
              assertJudgePromptWillRemainUnchanged(request, secrets),
            ...(hooks.waitBeforeCompletionRetry === undefined
              ? {}
              : {
                  waitBeforeRetry: (attempt, retrySignal) =>
                    hooks.waitBeforeCompletionRetry!(
                      'judge',
                      attempt,
                      retrySignal ?? signal,
                    ),
                }),
          },
        );
        judgeEvidence = parseJudgeEvidence(
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
      }
      const result = await evaluateRunEvidence({
        plan: input.plan,
        trajectory: redacted.evidence.trajectory,
        workspace: sealed!.workspace,
        ...(criterionResults === undefined ? {} : { criterionResults }),
        signal,
      });
      return { ...result, judgeEvidence };
    });

    const interactionArtifact = redactInteractionArtifact(
      buildInteractionArtifact(input.plan, interaction),
      secrets,
    );

    const coreArtifacts = buildCoreArtifacts(
      input.plan,
      setupArtifact,
      trajectoryJson,
      interactionArtifact,
      evaluated.workspaceEvidence,
      evaluated.judgeEvidence,
    );
    for (const artifact of coreArtifacts) {
      assertNoSecrets(artifact.body, secrets, artifact.path);
    }
    const coreDescriptors = coreArtifacts.map(describeArtifact);
    const nativeArtifacts =
      selectedEvidence.nativeArtifact === undefined
        ? []
        : [selectedEvidence.nativeArtifact];
    const nativeDescriptors = nativeArtifacts.map(describeArtifact);
    let contributedArtifacts: RunArtifact[] = [];
    if ((input.composition.contributors?.length ?? 0) > 0) {
      const contributorResult = buildResult({
        input,
        agent: preflight.agent,
        agentMetadata: preflight.agentMetadata,
        runtime: sealed,
        interaction,
        completionCalls: completions.calls,
        evidence: redacted.evidence,
        redactionCount: redacted.replacements,
        evaluation: evaluated.evaluation,
        coreDescriptors,
        supplementalDescriptors: nativeDescriptors,
        warnings: rolePlayerWarnings(interaction.failure),
        startedAt,
        completedAt: now(),
      });
      contributedArtifacts = await buildSupplementalArtifacts(
        input,
        contributorResult,
        secrets,
        signal,
      );
    }
    const supplementalArtifacts = [...nativeArtifacts, ...contributedArtifacts];
    const supplementalDescriptors = [
      ...nativeDescriptors,
      ...contributedArtifacts.map(describeArtifact),
    ];

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
          message:
            'Runtime cleanup failed after canonical artifacts were staged.',
        };
        warnings.push(cleanupWarning);
      } finally {
        runtimeDisposed = true;
      }
    });

    const result = buildResult({
      input,
      agent: preflight.agent,
      agentMetadata: preflight.agentMetadata,
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
      throw new ForgeExecutionError(
        'aborted',
        phase,
        'The Forge run was aborted.',
        {
          cause: signal.reason,
        },
      );
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
      options: { signal: AbortSignal },
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
      { signal },
    );
    const toolCalls = response.toolCalls.map((call) => ({ ...call }));
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
    throw new TypeError(
      'A multi-turn plan requires a role-player model and task.',
    );
  }
  const ava = new AvaRolePlayer(
    {
      task: plan.interaction.task,
      ...(plan.interaction.context === undefined
        ? {}
        : { context: plan.interaction.context }),
      ...(plan.interaction.initial_prompt === undefined
        ? {}
        : { initialPrompt: plan.interaction.initial_prompt }),
      signal,
    },
    (request) => completions.invoke('role_player', request, signal),
    waitBeforeCompletionRetry === undefined
      ? {}
      : {
          waitBeforeRetry: (attempt, retrySignal) =>
            waitBeforeCompletionRetry('role_player', attempt, retrySignal),
        },
  );
  const conversation = await runConversation({
    session: trackedSession,
    ava,
    maxTurns: plan.interaction.max_turns,
    signal,
  });
  const failure =
    conversation.failure === null
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
    ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
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
  setupExecutor: SetupExecutor,
  validateCredentials = true,
): EvalPreflight {
  assertExecutablePlan(plan);
  const agent = selectedAgent(plan, composition);
  const agentMetadata = agentAdapterMetadataSchema
    .optional()
    .parse(agent.metadata);
  const agentEvidenceIdentity = parseAgentEvidenceIdentity(
    agent.evidenceIdentity(plan.agent),
  );
  const setup = setupExecutor.preflight(plan.setup, {
    selection: plan.agent,
    runtime: plan.runtime,
    ...(agent.pluginInstaller === undefined
      ? {}
      : { pluginInstaller: agent.pluginInstaller }),
  });
  const agentRequirements = normalizeAgentRequirements(
    agent.requirements(plan.agent),
  );
  const requirements = mergeRuntimeRequirements(
    {
      executables: agentRequirements.executables,
      stateDirectories: agentRequirements.stateDirectories,
    },
    {
      executables: setup.requirements.executables ?? [],
      stateDirectories: setup.requirements.stateDirectories ?? [],
    },
  );
  const setupDeclarations = preparedSetupCredentialDeclarations(setup);
  const environment = mergeEnvironmentSpecifications([
    {
      scope: 'agent',
      source: 'agent',
      specification: agentRequirements.environment,
    },
    {
      scope: 'setup',
      source: 'setup',
      specification: {
        ...(setup.requirements.variables === undefined
          ? {}
          : { variables: setup.requirements.variables }),
      },
    },
    ...(['setup', 'agent'] as const).flatMap((scope) =>
      setupDeclarations
        .filter((declaration) => declaration.scope === scope)
        .map((declaration) => ({
          ...declaration,
          specification: {
            credentials: {
              [declaration.environmentName]: {
                reference: declaration.reference,
              },
            },
          },
        })),
    ),
  ]);
  const completionBindings = completionBindingsForPlan(plan, composition);
  if (validateCredentials) {
    validateCredentialDeclarations(
      environment.declarations,
      composition.credentialResolver,
      'preflight',
    );
  }
  const environmentSpecification = environment.specification;
  preflightRuntime(plan, composition, requirements, environmentSpecification);
  return Object.freeze({
    agent,
    agentMetadata,
    agentEvidenceIdentity,
    setup,
    requirements,
    environmentSpecification,
    credentialDeclarations: environment.declarations,
    completionBindings,
  });
}

function assertExecutablePlan(plan: ResolvedRunPlanV1): void {
  try {
    assertCompatibleForgeVersion(plan.provenance.forge.version);
  } catch (error) {
    throw new ForgeExecutionError(
      'invalid_plan',
      'preflight',
      error instanceof Error
        ? error.message
        : 'Unsupported Forge producer version.',
      { cause: error },
    );
  }
  // Defensive JSON/canonicalization check before any credential or runtime use.
  serializeResolvedRunPlan(plan);
}

function preflightRuntime(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
  requirements: RuntimeRequirements,
  environment: ScopedEnvironmentSpecification,
): void {
  const runtime = composition.runtime;
  const selected = plan.runtime;
  const external = 'config' in selected;
  const matches = external
    ? runtime.id === selected.adapter
    : runtime.id === 'forge/docker';
  if (!matches || typeof runtime.preflight !== 'function') {
    throw new ForgeExecutionError(
      'unsupported_capability',
      'preflight',
      external
        ? 'The supplied runtime must match the planned adapter and validate its configuration.'
        : 'The supplied runtime must match the built-in Docker identity and provide pure preflight.',
    );
  }
  const result: unknown = runtime.preflight(
    Object.freeze({ plan, requirements, environment }),
  );
  if (result !== undefined) {
    // A mistakenly async validator must fail before authority is resolved,
    // without leaving its rejected promise unhandled in the host process.
    if (result instanceof Promise) void result.catch(() => undefined);
    throw new TypeError(
      'Runtime preflight must synchronously validate without returning a value.',
    );
  }
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

async function resolveEnvironment(
  input: ExecuteEvalInput,
  specification: ScopedEnvironmentSpecification,
  declarations: readonly RuntimeCredentialDeclaration[],
  signal: AbortSignal,
): Promise<ResolvedEnvironment> {
  try {
    return await resolveCredentialDeclarations(
      specification,
      declarations,
      input.composition.credentialResolver,
      {
        runId: input.runId,
        purpose: 'forge-eval',
        signal,
      },
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
  readonly source: string;
  readonly setupStepIndex?: number;
  readonly specification: EnvironmentSpecification;
}

function mergeEnvironmentSpecifications(
  declarations: readonly ScopedEnvironmentDeclaration[],
): Readonly<{
  specification: ScopedEnvironmentSpecification;
  declarations: readonly RuntimeCredentialDeclaration[];
}> {
  const variables: Record<string, string> = {};
  const credentials: Record<string, CredentialEnvironmentBinding> = {};
  const credentialDeclarations: RuntimeCredentialDeclaration[] = [];
  for (const { scope, specification, source, setupStepIndex } of declarations) {
    const normalized = normalizeEnvironmentSpecification(specification);
    for (const [name, value] of Object.entries(normalized.variables)) {
      if (Object.hasOwn(credentials, name)) {
        throw new TypeError(
          `Environment ${name} has conflicting plain and secret bindings.`,
        );
      }
      if (Object.hasOwn(variables, name) && variables[name] !== value) {
        throw new TypeError(`Environment ${name} has conflicting values.`);
      }
      defineRecordValue(variables, name, value);
    }
    for (const [name, binding] of Object.entries(normalized.credentials)) {
      if (Object.hasOwn(variables, name)) {
        throw new TypeError(
          `Environment ${name} has conflicting plain and secret bindings.`,
        );
      }
      if (!binding || typeof binding.reference !== 'string') {
        throw new TypeError(
          `Environment ${name} has an invalid credential reference.`,
        );
      }
      if ('scopes' in binding) {
        throw new TypeError(
          `Environment ${name} cannot assign its own credential scopes.`,
        );
      }
      const previous = Object.hasOwn(credentials, name)
        ? credentials[name]
        : undefined;
      credentialDeclarations.push(
        Object.freeze({
          environmentName: name,
          reference: binding.reference,
          scope,
          source,
          ...(setupStepIndex === undefined ? {} : { setupStepIndex }),
        }),
      );
      defineRecordValue(
        credentials,
        name,
        Object.freeze({
          reference:
            previous?.reference ?? credentialReference(binding.reference),
          scopes: orderedCredentialScopes(previous?.scopes ?? [], scope),
        }),
      );
    }
  }
  return Object.freeze({
    specification: normalizeScopedEnvironmentSpecification({
      variables,
      credentials,
    }),
    declarations: Object.freeze(credentialDeclarations),
  });
}

function normalizeAgentRequirements(
  requirements: AgentRuntimeRequirements,
): AgentRuntimeRequirements {
  if (
    !isPlainRecord(requirements) ||
    !hasExactKeys(requirements, [
      'executables',
      'environment',
      'stateDirectories',
    ]) ||
    !Array.isArray(requirements.executables)
  ) {
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
      throw new TypeError(
        'Agent executable requirements must be bounded non-empty strings.',
      );
    }
    if (seenExecutables.has(executable)) {
      throw new TypeError(
        `Duplicate agent executable requirement: ${executable}`,
      );
    }
    seenExecutables.add(executable);
    return executable;
  });
  return Object.freeze({
    executables: Object.freeze(executables.sort(compareCodeUnits)),
    environment: normalizeEnvironmentSpecification(requirements.environment),
    stateDirectories: normalizeRuntimeStateDirectories(
      requirements.stateDirectories,
      'Agent',
    ),
  });
}

function mergeRuntimeRequirements(
  ...requirements: readonly RuntimeRequirements[]
): RuntimeRequirements {
  const executables = new Set<string>();
  const stateDirectories = new Map<string, RuntimeStateDirectoryRequirement>();
  const statePaths = new Map<string, string>();
  for (const requirement of requirements) {
    for (const executable of requirement.executables)
      executables.add(executable);
    for (const state of normalizeRuntimeStateDirectories(
      requirement.stateDirectories,
      'Runtime',
    )) {
      const previous = stateDirectories.get(state.id);
      if (
        previous !== undefined &&
        (previous.containerPath !== state.containerPath ||
          (previous.sealAfterSetup ?? false) !==
            (state.sealAfterSetup ?? false))
      ) {
        throw new TypeError(
          `Runtime state directory ${state.id} has conflicting requirements.`,
        );
      }
      for (const [existingPath, existingId] of statePaths) {
        if (
          existingId !== state.id &&
          pathsOverlap(existingPath, state.containerPath)
        ) {
          throw new TypeError(
            'Runtime state directory requirements may not overlap.',
          );
        }
      }
      if (previous === undefined) {
        stateDirectories.set(state.id, state);
        statePaths.set(state.containerPath, state.id);
      }
    }
  }
  return Object.freeze({
    executables: Object.freeze([...executables].sort(compareCodeUnits)),
    stateDirectories: Object.freeze(
      [...stateDirectories.values()].sort((left, right) =>
        compareCodeUnits(left.id, right.id),
      ),
    ),
  });
}

function normalizeRuntimeStateDirectories(
  input: readonly RuntimeStateDirectoryRequirement[],
  owner: string,
): readonly RuntimeStateDirectoryRequirement[] {
  if (!Array.isArray(input)) {
    throw new TypeError(
      `${owner} state-directory requirements must be an array.`,
    );
  }
  const ids = new Set<string>();
  const paths: string[] = [];
  const normalized = input.map((requirement) => {
    if (
      !isPlainRecord(requirement) ||
      !hasOnlyKeys(requirement, ['id', 'containerPath', 'sealAfterSetup']) ||
      !Object.hasOwn(requirement, 'id') ||
      !Object.hasOwn(requirement, 'containerPath') ||
      typeof requirement.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(requirement.id) ||
      typeof requirement.containerPath !== 'string' ||
      !requirement.containerPath.startsWith('/') ||
      requirement.containerPath.includes('\0') ||
      path.posix.normalize(requirement.containerPath) !==
        requirement.containerPath ||
      (Object.hasOwn(requirement, 'sealAfterSetup') &&
        typeof requirement.sealAfterSetup !== 'boolean') ||
      ids.has(requirement.id) ||
      paths.some((existing) =>
        pathsOverlap(existing, requirement.containerPath as string),
      )
    ) {
      throw new TypeError(
        `${owner} returned an invalid state-directory requirement.`,
      );
    }
    const id = requirement.id as string;
    const containerPath = requirement.containerPath as string;
    const sealAfterSetup = requirement.sealAfterSetup as boolean | undefined;
    ids.add(id);
    paths.push(containerPath);
    return Object.freeze({
      id,
      containerPath,
      ...(sealAfterSetup === undefined ? {} : { sealAfterSetup }),
    });
  });
  return Object.freeze(normalized);
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && allowed.has(key))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const allowed = new Set(expected);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.has(key),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function projectAgentPrepareRuntime(
  runtime: PreparedRuntime,
): AgentPrepareRuntime {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    workspace: projectMutableWorkspace(runtime.workspace),
    paths: Object.freeze({ ...runtime.paths }),
    stateDirectories: projectWorkspaceMap(
      runtime.stateDirectories,
      projectMutableWorkspace,
    ),
    commands: Object.freeze({
      uncredentialed: projectCommandRunner(runtime.commands.uncredentialed),
    }),
  });
}

function projectAgentSessionRuntime(
  runtime: PreparedRuntime,
): AgentSessionRuntime {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    workspace: projectMutableWorkspace(runtime.workspace),
    paths: Object.freeze({ ...runtime.paths }),
    stateDirectories: projectWorkspaceMap(
      runtime.stateDirectories,
      projectMutableWorkspace,
    ),
    commands: Object.freeze({
      agent: projectCommandRunner(runtime.commands.agent),
    }),
  });
}

function projectAgentEvidenceRuntime(
  runtime: SealedRuntime,
): AgentEvidenceRuntime {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    workspace: projectReadonlyWorkspace(runtime.workspace),
    paths: Object.freeze({ ...runtime.paths }),
    stateDirectories: projectWorkspaceMap(
      runtime.stateDirectories,
      projectReadonlyWorkspace,
    ),
    metadata: Object.freeze({ ...runtime.metadata }),
  });
}

function projectCommandRunner(runner: CommandRunner): CommandRunner {
  return Object.freeze({
    run: (argv: readonly string[], options?: CommandOptions) =>
      runner.run(argv, options),
  });
}

function projectReadonlyWorkspace(
  workspace: ReadonlyWorkspace,
): ReadonlyWorkspace {
  return Object.freeze({
    inspect: (relativePath: string) => workspace.inspect(relativePath),
    readFile: (relativePath: string, options?: { maxBytes?: number }) =>
      workspace.readFile(relativePath, options),
    listFiles: (options?: WorkspaceListOptions) => workspace.listFiles(options),
  });
}

function projectMutableWorkspace(
  workspace: MutableWorkspace,
): MutableWorkspace {
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
      [...workspaces].map(
        ([id, workspace]) => [id, project(workspace)] as const,
      ),
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
): { evidence: NormalizedTrajectory; replacements: number } {
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
      adapter: { id: agent.id, version: agent.version },
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
  return boundJudgeWorkspaceEvidence(redactSecrets(evidence, secrets).value);
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
      ...(call.id === undefined ? {} : { id: call.id }),
      name: call.name,
      ...(call.input === undefined ? {} : { input: jsonValue(call.input) }),
    })),
  }));
  const rolePlayer =
    interaction.avaAudit === undefined || plan.role_player === undefined
      ? {}
      : {
          role_player: {
            model: { ...plan.role_player },
            needs:
              interaction.avaAudit.needs?.map((need) => ({ ...need })) ?? null,
            decisions: interaction.avaAudit.decisions.map(avaDecisionRecord),
          },
        };
  return {
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
      : { error: rolePlayerErrorRecord(decision.error) }),
  };
}

function redactInteractionArtifact(
  artifact: InteractionArtifactV1,
  secrets: readonly string[],
): InteractionArtifactV1 {
  return parseInteractionArtifact(redactSecrets(artifact, secrets).value, {
    forgeVersion: FORGE_VERSION,
  });
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

function rolePlayerWarnings(failure: RolePlayerErrorV1 | null): RunWarningV1[] {
  return failure === null
    ? []
    : [{ code: 'role_player_error', message: failure.explanation }];
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
    throw new TypeError(
      'Evidence provenance does not match the selected agent adapter.',
    );
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
    throw new TypeError(
      'Evidence provenance does not match the selected session.',
    );
  }
  if (
    evidence.trajectory.session_id != null &&
    evidence.trajectory.session_id !== sessionId
  ) {
    throw new TypeError('ATIF trajectory does not match the selected session.');
  }
}

function buildNativeArtifact(
  captured: AgentNativeArtifact | undefined,
  collected: AgentNativeEvidenceResult,
  agent: AgentAdapter,
  sessionId: string,
): RunArtifact | undefined {
  if (captured === undefined) return undefined;
  if (
    captured === null ||
    typeof captured !== 'object' ||
    !(captured.body instanceof Uint8Array) ||
    captured.body.byteLength > MAX_NATIVE_ARTIFACT_BYTES ||
    captured.sessionId !== sessionId ||
    !SAFE_NATIVE_FORMAT.test(captured.format) ||
    !SAFE_NATIVE_MEDIA_TYPE.test(captured.mediaType) ||
    !SAFE_NATIVE_EXTENSION.test(captured.extension) ||
    !isSafeSimpleIdentifier(agent.id)
  ) {
    throw new TypeError('Agent returned an invalid native artifact.');
  }
  if (
    collected.kind === 'available' &&
    (collected.source.sessionId !== captured.sessionId ||
      collected.source.format !== captured.format)
  ) {
    throw new TypeError(
      'Agent native artifact does not match its normalized evidence source.',
    );
  }
  return {
    path: `native/${agent.id}/session.${captured.extension}`,
    body: Uint8Array.from(captured.body),
    mediaType: captured.mediaType,
    sensitivity: 'restricted',
  };
}

function buildCoreArtifacts(
  plan: ResolvedRunPlanV1,
  setup: SetupArtifactV1,
  trajectoryJson: string,
  interaction: InteractionArtifactV1,
  workspaceEvidence: WorkspaceEvidenceV1,
  judgeEvidence: JudgeEvidenceV1 | undefined,
): RunArtifact[] {
  const setupJson = serializeCanonicalJson(setup);
  return [
    jsonArtifact('plan.json', serializeResolvedRunPlan(plan)),
    jsonArtifact('setup.json', setupJson),
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
      : [
          jsonArtifact(
            'judge-evidence.json',
            serializeCanonicalJson(judgeEvidence),
          ),
        ]),
  ];
}

function buildSetupArtifact(
  plan: ResolvedRunPlanV1,
  applied: AppliedSetup,
): SetupArtifactV1 {
  if (
    applied.steps.length !== plan.setup.length ||
    applied.steps.some(
      (step, index) =>
        step.index !== index || step.uses !== plan.setup[index]?.uses,
    )
  ) {
    throw new TypeError('Applied setup does not match the resolved run plan.');
  }
  const artifact = parseSetupArtifact(
    {
      steps: applied.steps.map((step) => ({
        index: step.index,
        uses: step.uses,
        ...(step.resolution === undefined
          ? {}
          : { resolution: step.resolution }),
      })),
    },
    { forgeVersion: FORGE_VERSION },
  );
  if (
    Buffer.byteLength(serializeCanonicalJson(artifact), 'utf8') >
    MAX_SETUP_ARTIFACT_BYTES
  ) {
    throw new TypeError('Canonical setup artifact exceeds its byte limit.');
  }
  return artifact;
}

async function buildSupplementalArtifacts(
  input: ExecuteEvalInput,
  result: RunResultV1,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<RunArtifact[]> {
  const artifacts: RunArtifact[] = [];
  const resultJson = serializeCanonicalJson(result);
  for (const contributor of input.composition.contributors ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(contributor.id)) {
      throw new TypeError('Artifact contributor IDs must be safe identifiers.');
    }
    const contributed = await contributor.contribute({
      runId: input.runId,
      result: JSON.parse(resultJson) as Readonly<Record<string, unknown>>,
      signal,
    });
    for (const artifact of contributed) {
      const { path: artifactPath, body, mediaType, sensitivity } = artifact;
      if (!(body instanceof Uint8Array)) {
        throw new TypeError('Contributed artifacts require bytes.');
      }
      const snapshot: RunArtifact = {
        path: artifactPath,
        body: Uint8Array.from(body),
        mediaType,
        ...(sensitivity === undefined ? {} : { sensitivity }),
      };
      if (!snapshot.path.startsWith(`extensions/${contributor.id}/`)) {
        throw new TypeError(
          `Contributor ${contributor.id} wrote outside its namespace.`,
        );
      }
      assertNoSecrets(snapshot.body, secrets, snapshot.path);
      artifacts.push(snapshot);
    }
  }
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (paths.has(artifact.path))
      throw new TypeError(`Duplicate supplemental artifact: ${artifact.path}`);
    paths.add(artifact.path);
  }
  return artifacts;
}

function buildResult(input: {
  input: ExecuteEvalInput;
  agent: AgentAdapter;
  agentMetadata: AgentAdapterMetadata | undefined;
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
    run_id: input.input.runId,
    selection: input.input.plan.selection,
    forge: {
      ...FORGE_BUILD_IDENTITY,
      ...(input.input.plan.provenance.forge.action_bundles === undefined
        ? {}
        : {
            action_bundles:
              input.input.plan.provenance.forge.action_bundles.map(
                (bundle) => ({ ...bundle }),
              ),
          }),
    },
    runtime: {
      adapter: input.input.composition.runtime.id,
      runtime_id: input.runtime.runtimeId,
      platform: input.input.plan.runtime.platform,
      metadata: input.runtime.metadata,
    },
    agent: {
      adapter: input.agent.id,
      adapter_version: input.agent.version,
      ...(input.agentMetadata === undefined
        ? {}
        : { metadata: input.agentMetadata }),
      provider: input.input.plan.agent.provider,
      model: input.input.plan.agent.model,
      session_id: input.interaction.sessionId,
      cost_usd: input.interaction.totalCostUsd,
    },
    completion_calls: input.completionCalls.map((call) => ({ ...call })),
    interaction: {
      mode: input.input.plan.interaction.mode,
      turn_count: input.interaction.turns.length,
    },
    failure: input.interaction.failure,
    evidence: {
      format: 'atif',
      schema_version: ATIF_SCHEMA_VERSION,
      provenance: resultEvidenceProvenance(input.evidence.provenance),
      completeness: input.evidence.completeness,
      warnings: input.evidence.warnings,
      redaction_count: input.redactionCount,
    },
    evaluation: input.evaluation,
    started_at: input.startedAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
    duration_ms: Math.max(
      0,
      input.completedAt.getTime() - input.startedAt.getTime(),
    ),
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
    'sessionId' in provenance.source &&
    provenance.source.sessionId !== undefined
      ? { session_id: provenance.source.sessionId }
      : {};
  const source =
    provenance.source.kind === 'native_log'
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
    adapter: { ...provenance.adapter },
  };
}

function jsonArtifact(path: string, body: string): RunArtifact {
  return {
    path,
    body: Buffer.from(body, 'utf8'),
    mediaType: 'application/json',
  };
}

function describeArtifact(artifact: RunArtifact): ArtifactDescriptorV1 {
  return {
    path: artifact.path,
    media_type: artifact.mediaType,
    size_bytes: artifact.body.byteLength,
    sha256: sha256Digest(artifact.body),
    ...(artifact.sensitivity === undefined
      ? {}
      : { sensitivity: artifact.sensitivity }),
  };
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
  request: Pick<CriterionCompletionRequest, 'systemPrompt' | 'messages'>,
  secrets: readonly string[],
): void {
  const projected = redactSecrets(
    { systemPrompt: request.systemPrompt, messages: request.messages },
    secrets,
  );
  if (projected.replacements !== 0) {
    throw new TypeError(
      'Judge prompt cannot be sent without changing its audited evidence.',
    );
  }
}

function credentialValues(environment: ResolvedEnvironment): string[] {
  return Object.values(environment.credentials).map(({ value }) => value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new ForgeExecutionError(
      'invalid_plan',
      'preflight',
      'runId is not a safe identifier.',
    );
  }
}

function mapExecutionError(
  error: unknown,
  phase: RunPhase,
): ForgeExecutionError {
  if (error instanceof ForgeExecutionError) return error;
  const code =
    phase === 'preflight'
      ? 'invalid_plan'
      : phase === 'runtime_prepare' ||
          phase === 'quiesce' ||
          phase === 'runtime_dispose'
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
