import {createHash} from 'node:crypto';

import {
  ATIF_NORMALIZATION_VERSION,
  ATIF_SCHEMA_VERSION,
  parseNormalizedTrajectory,
  serializeAtifTrajectory,
  type AtifNormalizationProvenance,
  type NormalizedTrajectory,
} from '../atif/index.js';
import type {
  AgentAdapter,
  AgentEvidenceRuntime,
  AgentEvidenceFallbackTurn,
  AgentPrepareRuntime,
  AgentRuntimeRequirements,
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
import {evaluateRunEvidence} from '../evaluation/index.js';
import {parseResolvedRunPlan, type ResolvedRunPlanV1} from '../model/index.js';
import {
  resolvedRunPlanSha256,
  serializeResolvedRunPlan,
} from '../planning/index.js';
import {
  RUN_RESULT_SCHEMA_VERSION,
  parseRunResult,
  type AtifEvidenceProvenanceV1,
  type ArtifactDescriptorV1,
  type CompletedRunV1,
  type EvaluationResultV1,
  type RunResultV1,
  type RunWarningV1,
} from '../results/index.js';
import {assertNoSecrets, redactSecrets} from '../security/redaction.js';
import {canonicalJsonSha256, serializeCanonicalJson} from '../serialization.js';
import {
  createSetupExecutor,
  forgeSetupHandlers,
  type SetupStepHandler,
} from '../setup/index.js';
import {executionError, ForgeExecutionError, throwIfAborted} from './errors.js';
import {createRunEventEmitter} from './events.js';
import type {RunPhase} from '../contracts/observability.js';

export const FORGE_VERSION = '0.1.0' as const;

export interface ExecuteEvalInput {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV1;
  readonly composition: ForgeComposition;
  readonly signal?: AbortSignal;
  /** Test seam; production uses the wall clock. */
  readonly now?: () => Date;
}

/** Execute one already-resolved run and return only after atomic commit. */
export async function executeEval(request: ExecuteEvalInput): Promise<CompletedRunV1> {
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
      assertExecutableV0Plan(input.plan);
      const agent = selectedAgent(input.plan, input.composition);
      const setupExecutor = setupExecutorFor(input.composition);
      setupExecutor.preflight(input.plan.setup);
      const requirements = normalizeAgentRequirements(
        agent.requirements(input.plan.agent),
      );
      const setupSpecifications = setupEnvironmentSpecifications(
        input.plan,
        input.composition,
      );
      const environmentSpecification = mergeEnvironmentSpecifications([
        {scope: 'agent', specification: requirements.environment},
        ...setupSpecifications.map((specification) => ({
          scope: 'setup' as const,
          specification,
        })),
      ]);
      return {agent, setupExecutor, requirements, environmentSpecification};
    });

    const environment = await resolveEnvironment(
      input,
      preflight.environmentSpecification,
      signal,
    );
    const secrets = credentialValues(environment);

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

    const {session, turn} = await events.phase('interaction', async () => {
      phase = 'interaction';
      throwIfAborted(signal, phase);
      const currentSession = await preflight.agent.openSession({
        runId: input.runId,
        plan: input.plan,
        selection: input.plan.agent,
        runtime: projectAgentSessionRuntime(prepared!),
        inputs: input.composition.inputProvider,
        signal,
      });
      const currentTurn = await currentSession.send(
        input.plan.interaction.effective_prompt,
        {signal},
      );
      return {session: currentSession, turn: currentTurn};
    });
    const sessionId = session.sessionId() ?? turn.sessionId;
    if (!sessionId) {
      throw new ForgeExecutionError(
        'agent_failed',
        'interaction',
        'Agent completed without a session identity.',
      );
    }

    sealed = await events.phase('quiesce', async () => {
      phase = 'quiesce';
      return prepared!.quiesce();
    });

    const fallbackTurns: readonly AgentEvidenceFallbackTurn[] = [
      {
        user: input.plan.interaction.effective_prompt,
        assistant: turn.text,
        toolCalls: turn.toolCalls,
      },
    ];
    const nativeEvidence = await events.phase('evidence', async () => {
      phase = 'evidence';
      throwIfAborted(signal, phase);
      const evidence = parseNormalizedTrajectory(
        await preflight.agent.collectEvidence({
          runId: input.runId,
          plan: input.plan,
          selection: input.plan.agent,
          runtime: projectAgentEvidenceRuntime(sealed!),
          sessionId,
          fallbackTurns,
          signal,
        }),
      );
      assertEvidenceMatchesRun(evidence, preflight.agent, sessionId);
      return evidence;
    });
    const redacted = redactNormalizedTrajectory(nativeEvidence, secrets);

    const evaluated = await events.phase('evaluation', async () => {
      phase = 'evaluation';
      throwIfAborted(signal, phase);
      return evaluateRunEvidence({
        plan: input.plan,
        trajectory: redacted.evidence.trajectory,
        workspace: sealed!.workspace,
        signal,
      });
    });

    const coreArtifacts = buildCoreArtifacts(
      input.plan,
      redacted.evidence,
      evaluated.workspaceEvidence,
      evaluated.evaluation,
    );
    for (const artifact of coreArtifacts) {
      assertNoSecrets(artifact.body, secrets, artifact.path);
    }
    const coreDescriptors = coreArtifacts.map(describeArtifact);
    let result = buildResult({
      input,
      agent: preflight.agent,
      runtime: sealed,
      turn,
      sessionId,
      evidence: redacted.evidence,
      redactionCount: redacted.replacements,
      evaluation: evaluated.evaluation,
      coreDescriptors,
      supplementalDescriptors: [],
      warnings: [],
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

    const warnings: RunWarningV1[] = [];
    await events.phase('runtime_dispose', async () => {
      phase = 'runtime_dispose';
      try {
        await prepared!.dispose();
      } catch {
        warnings.push({
          code: 'runtime_cleanup_failed',
          message: 'Runtime cleanup failed after canonical artifacts were staged.',
        });
        await events.warning('runtime_dispose', warnings[0]!.message);
      } finally {
        runtimeDisposed = true;
      }
    });

    result = buildResult({
      input,
      agent: preflight.agent,
      runtime: sealed,
      turn,
      sessionId,
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

function assertExecutableV0Plan(plan: ResolvedRunPlanV1): void {
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
  if (plan.interaction.mode !== 'one_shot') {
    throw new ForgeExecutionError(
      'unsupported_capability',
      'preflight',
      'Forge v0.1 executes only one_shot cases.',
    );
  }
  if (plan.evaluation.success_guidelines.length > 0) {
    throw new ForgeExecutionError(
      'unsupported_capability',
      'preflight',
      'Forge v0.1 does not yet execute guideline judging.',
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

function assertEvidenceMatchesRun(
  evidence: NormalizedTrajectory,
  agent: AgentAdapter,
  sessionId: string,
): void {
  if (
    evidence.provenance.adapter.id !== agent.id ||
    evidence.provenance.adapter.version !== agent.version
  ) {
    throw new TypeError('Evidence provenance does not match the selected agent adapter.');
  }
  if (
    evidence.provenance.source.sessionId !== undefined &&
    evidence.provenance.source.sessionId !== sessionId
  ) {
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
  evidence: NormalizedTrajectory,
  workspaceEvidence: unknown,
  evaluation: EvaluationResultV1,
): RunArtifact[] {
  return [
    jsonArtifact('plan.json', serializeResolvedRunPlan(plan)),
    jsonArtifact('trajectory.json', serializeAtifTrajectory(evidence.trajectory)),
    jsonArtifact('workspace-evidence.json', serializeCanonicalJson(workspaceEvidence)),
    jsonArtifact('evaluation.json', serializeCanonicalJson(evaluation)),
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
  turn: AgentTurn;
  sessionId: string;
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
      session_id: input.sessionId,
      cost_usd: input.turn.costUsd ?? null,
    },
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
    stop_reason: 'completed',
    artifact_set_sha256: canonicalJsonSha256(input.coreDescriptors),
    artifacts: input.coreDescriptors,
    supplemental_artifacts: input.supplementalDescriptors,
    warnings: input.warnings,
  };
}

function resultEvidenceProvenance(
  provenance: AtifNormalizationProvenance,
): AtifEvidenceProvenanceV1 {
  const session = provenance.source.sessionId === undefined
    ? {}
    : {session_id: provenance.source.sessionId};
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
      : {
          kind: provenance.source.kind,
          format: provenance.source.format,
          ...session,
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

function credentialValues(environment: ResolvedEnvironment): string[] {
  return Object.values(environment.credentials).map(({value}) => value);
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
