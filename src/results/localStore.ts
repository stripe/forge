import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type AtifTrajectoryV1_8, parseAtifTrajectory } from '../atif/index.ts';
import type {
  CommittedRun,
  RunArtifact,
  RunArtifactStore,
  RunArtifactTransaction,
} from '../contracts/artifacts.ts';
import { parseAgentPluginInstallationReceipt } from '../contracts/pluginReceipt.ts';
import { criterionEvidenceWarnings } from '../evaluation/criterionEvidence.ts';
import {
  type JudgeEvidenceBudgetSelection,
  selectJudgeEvidence,
  sizeJudgePrompt,
} from '../evaluation/judgeEvidenceBudget.ts';
import { createJudgeTranscriptProjection } from '../evaluation/judgeTranscript.ts';
import { criterionResultMatchesDefinition } from '../evaluation/score.ts';
import { trajectoryCoversCompletedTurns } from '../evidence/selection.ts';
import {
  hasDeterministicChecks,
  hasDeterministicWorkspaceChecks,
} from '../model/checks.ts';
import { sha256Digest } from '../model/hashes.ts';
import {
  DEFAULT_REQUIREMENT_LEVEL,
  type PluginSetupStepV1,
  parseResolvedRunPlan,
  type ResolvedRunPlanV1,
} from '../model/index.ts';
import { isSafeDatasetRelativePath } from '../model/paths.ts';
import { pluginDefinitionForAgent } from '../model/plugins.ts';
import { serializeResolvedRunPlan } from '../planning/index.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { assertCompatibleForgeVersion } from '../version.ts';
import {
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseRunResult,
  parseSetupArtifact,
  parseWorkspaceEvidence,
} from './parse.ts';
import {
  type ArtifactDescriptorV1,
  type CompletedRun,
  type InteractionArtifactV1,
  MAX_RESULT_BYTES,
  MAX_SETUP_ARTIFACT_BYTES,
  type RunResult,
} from './types.ts';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERIFIED_ARTIFACT_PATHS = new Set([
  'interaction.json',
  'judge-evidence.json',
  'plan.json',
  'setup.json',
  'trajectory.json',
  'workspace-evidence.json',
]);

export interface CreateArtifactStoreOptions {
  readonly root: string;
}

/** Local two-phase store whose final rename is the completion boundary. */
export function createArtifactStore(
  options: CreateArtifactStoreOptions,
): RunArtifactStore {
  if (!options.root || options.root.includes('\0')) {
    throw new TypeError('Artifact store root must be a non-empty path.');
  }
  const requestedRoot = path.resolve(options.root);
  if (requestedRoot === path.parse(requestedRoot).root) {
    throw new TypeError('Artifact store root must not be a filesystem root.');
  }

  return {
    async begin(runId): Promise<RunArtifactTransaction> {
      assertRunId(runId);
      const root = await ensureStoreRoot(requestedRoot);
      const stagingRoot = path.join(root, '.staging');
      const runsRoot = path.join(root, 'runs');
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(runsRoot, { recursive: true, mode: 0o755 });
      const finalRunDir = path.join(runsRoot, runId);
      if (await pathExists(finalRunDir)) throw new RunIdConflictError(runId);
      const stagingRunDir = await fs.mkdtemp(
        path.join(stagingRoot, `${runId}-`),
      );
      const written = new Map<string, ArtifactDescriptorV1>();
      let closed = false;

      const rollback = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await fs.rm(stagingRunDir, { recursive: true, force: true });
      };

      return {
        async write(artifact: RunArtifact): Promise<void> {
          assertOpen(closed);
          assertArtifactPath(artifact.path);
          if (artifact.path === 'result.json') {
            throw new ArtifactStoreError(
              'result.json is reserved for atomic commit.',
            );
          }
          if (written.has(artifact.path)) {
            throw new ArtifactStoreError(
              `Duplicate artifact path: ${artifact.path}`,
            );
          }
          if (!(artifact.body instanceof Uint8Array) || !artifact.mediaType) {
            throw new ArtifactStoreError(
              'Artifacts require bytes and a media type.',
            );
          }
          if (
            artifact.sensitivity !== undefined &&
            artifact.sensitivity !== 'restricted'
          ) {
            throw new ArtifactStoreError('Artifact sensitivity is invalid.');
          }
          const restricted = artifact.sensitivity === 'restricted';
          const destination = path.join(
            stagingRunDir,
            ...artifact.path.split('/'),
          );
          await fs.mkdir(path.dirname(destination), {
            recursive: true,
            mode: restricted ? 0o700 : 0o755,
          });
          const handle = await fs.open(
            destination,
            'wx',
            restricted ? 0o600 : 0o644,
          );
          try {
            await handle.writeFile(artifact.body);
            await handle.sync();
          } finally {
            await handle.close();
          }
          written.set(artifact.path, {
            path: artifact.path,
            media_type: artifact.mediaType,
            size_bytes: artifact.body.byteLength,
            sha256: sha256Digest(artifact.body),
            ...(artifact.sensitivity === undefined
              ? {}
              : { sensitivity: artifact.sensitivity }),
          });
        },
        async commit(
          value: Readonly<Record<string, unknown>>,
        ): Promise<CommittedRun> {
          assertOpen(closed);
          let result: RunResult;
          try {
            result = parseRunResult(value);
            assertResultArtifacts(result, written);
            if (result.run_id !== runId) throw new RunIdConflictError(runId);
            const resultBody = Buffer.from(
              serializeCanonicalJson(result),
              'utf8',
            );
            if (resultBody.byteLength > MAX_RESULT_BYTES) {
              throw new ArtifactStoreError(
                'result.json exceeds its byte limit.',
              );
            }
            const resultPath = path.join(stagingRunDir, 'result.json');
            const handle = await fs.open(resultPath, 'wx', 0o644);
            try {
              await handle.writeFile(resultBody);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await syncDirectory(stagingRunDir);
            if (await pathExists(finalRunDir))
              throw new RunIdConflictError(runId);
            await fs.rename(stagingRunDir, finalRunDir);
            closed = true;
            await syncDirectory(stagingRoot);
            await syncDirectory(runsRoot);
          } catch (error) {
            if (!closed) {
              closed = true;
              await fs.rm(stagingRunDir, { recursive: true, force: true });
            }
            throw error;
          }
          return {
            runId,
            location: finalRunDir,
            result: result as unknown as Readonly<Record<string, unknown>>,
          };
        },
        rollback,
      };
    },
  };
}

/** Read and hash every claimed file before treating a run as complete. */
export async function verifyCompletedRun(
  location: string,
): Promise<CompletedRun> {
  return verifyCompletedRunWithPlanParser(location, parseResolvedRunPlan);
}

/** @internal Engine-bound variant for plans using its immutable action registry. */
export async function verifyCompletedRunWithPlanParser(
  location: string,
  parsePlan: (value: unknown) => ResolvedRunPlanV1,
): Promise<CompletedRun> {
  const runDir = path.resolve(location);
  const stat = await fs.lstat(runDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactStoreError('Completed run must be a real directory.');
  }
  const resultBytes = await readBoundedFile(
    path.join(runDir, 'result.json'),
    MAX_RESULT_BYTES,
  );
  let unknownResult: unknown;
  try {
    unknownResult = JSON.parse(resultBytes.toString('utf8'));
  } catch (error) {
    throw new ArtifactStoreError('Completed result.json is invalid JSON.', {
      cause: error,
    });
  }
  const result = parseRunResult(unknownResult);
  if (path.basename(runDir) !== result.run_id) {
    throw new ArtifactStoreError(
      'Completed run directory does not match run_id.',
    );
  }

  const expectedPaths = new Set(['result.json']);
  const artifactBodies = new Map<string, Buffer>();
  for (const descriptor of [
    ...result.artifacts,
    ...result.supplemental_artifacts,
  ]) {
    assertArtifactPath(descriptor.path);
    if (expectedPaths.has(descriptor.path)) {
      throw new ArtifactStoreError(
        `Duplicate claimed artifact: ${descriptor.path}`,
      );
    }
    expectedPaths.add(descriptor.path);
    const body = await readBoundedFile(
      path.join(runDir, ...descriptor.path.split('/')),
      descriptor.path === 'setup.json'
        ? Math.min(descriptor.size_bytes, MAX_SETUP_ARTIFACT_BYTES)
        : descriptor.size_bytes,
    );
    if (
      body.byteLength !== descriptor.size_bytes ||
      sha256Digest(body) !== descriptor.sha256
    ) {
      throw new ArtifactStoreError(
        `Artifact does not match its descriptor: ${descriptor.path}`,
      );
    }
    if (VERIFIED_ARTIFACT_PATHS.has(descriptor.path)) {
      artifactBodies.set(descriptor.path, body);
    }
  }
  const actualPaths = await listRegularFiles(runDir);
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((entry) => !expectedPaths.has(entry))
  ) {
    throw new ArtifactStoreError('Completed run contains an unclaimed file.');
  }
  const plan = verifyPlanArtifact(result, artifactBodies, parsePlan);
  verifySetupArtifact(result, plan, artifactBodies);
  const interaction = verifyInteractionArtifact(result, artifactBodies);
  const trajectory = verifyTrajectoryArtifact(
    result,
    interaction,
    artifactBodies,
  );
  verifyJudgeEvidence(result, plan, artifactBodies, trajectory);
  const workspaceBody = artifactBodies.get('workspace-evidence.json');
  if (workspaceBody !== undefined) {
    parseJsonArtifact('workspace-evidence.json', workspaceBody, (value) =>
      parseWorkspaceEvidence(value, { forgeVersion: result.forge.version }),
    );
  }
  verifyCanonicalArtifactInventory(result, plan);
  return { runId: result.run_id, location: runDir, result };
}

export class ArtifactStoreError extends Error {
  readonly code = 'artifact_store_error' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactStoreError';
  }
}

export class RunIdConflictError extends ArtifactStoreError {
  readonly conflictCode = 'run_id_conflict' as const;
  constructor(readonly runId: string) {
    super(`A completed or in-progress run already uses ID ${runId}.`);
    this.name = 'RunIdConflictError';
  }
}

function assertResultArtifacts(
  result: RunResult,
  written: ReadonlyMap<string, ArtifactDescriptorV1>,
): void {
  const claimed = [...result.artifacts, ...result.supplemental_artifacts];
  if (claimed.length !== written.size) {
    throw new ArtifactStoreError(
      'Result does not claim every staged artifact.',
    );
  }
  const claimedPaths = new Set<string>();
  for (const descriptor of claimed) {
    if (claimedPaths.has(descriptor.path)) {
      throw new ArtifactStoreError(
        `Duplicate claimed artifact: ${descriptor.path}`,
      );
    }
    claimedPaths.add(descriptor.path);
    const actual = written.get(descriptor.path);
    if (
      !actual ||
      actual.media_type !== descriptor.media_type ||
      actual.size_bytes !== descriptor.size_bytes ||
      actual.sha256 !== descriptor.sha256 ||
      actual.sensitivity !== descriptor.sensitivity
    ) {
      throw new ArtifactStoreError(
        `Result descriptor mismatch: ${descriptor.path}`,
      );
    }
  }
}

function verifyPlanArtifact(
  result: RunResult,
  artifactBodies: ReadonlyMap<string, Buffer>,
  parsePlan: (value: unknown) => ResolvedRunPlanV1,
): ResolvedRunPlanV1 {
  const path = 'plan.json';
  const body = requireCoreArtifact(result, artifactBodies, path);
  const plan = parseJsonArtifact(path, body, parsePlan);
  assertCompatibleForgeVersion(plan.provenance.forge.version);
  if (body.toString('utf8') !== serializeResolvedRunPlan(plan)) {
    throw new ArtifactStoreError('Completed plan.json is not canonical.');
  }
  if (
    serializeCanonicalJson(plan.selection) !==
      serializeCanonicalJson(result.selection) ||
    serializeCanonicalJson(plan.provenance.forge.action_bundles ?? []) !==
      serializeCanonicalJson(result.forge.action_bundles ?? [])
  ) {
    throw new ArtifactStoreError(
      'plan.json does not match the completed result summary.',
    );
  }
  const plannedRuntime = plan.runtime;
  const externalRuntime = 'config' in plannedRuntime;
  const runtimeMatches = externalRuntime
    ? result.runtime.adapter === plannedRuntime.adapter
    : result.runtime.adapter === 'forge/docker';
  if (!runtimeMatches || result.runtime.platform !== plannedRuntime.platform) {
    throw new ArtifactStoreError(
      'plan.json runtime does not match the completed result.',
    );
  }
  const plannedCriteria = plan.evaluation.judging_criteria;
  const recordedCriteria = result.evaluation.judging_criteria;
  if (
    plannedCriteria.length !== recordedCriteria.length ||
    recordedCriteria.some(
      (entry, index) =>
        !criterionResultMatchesDefinition(entry, plannedCriteria[index]!),
    ) ||
    hasDeterministicChecks(plan.evaluation.checks) !==
      result.evaluation.checks.length > 0 ||
    !toolCallCheckResultsMatchPlan(plan, result)
  ) {
    throw new ArtifactStoreError(
      'plan.json evaluation configuration does not match the completed result.',
    );
  }
  return plan;
}

/** Tool call results come last, one per planned check, in plan order. */
function toolCallCheckResultsMatchPlan(
  plan: ResolvedRunPlanV1,
  result: RunResult,
): boolean {
  const planned = plan.evaluation.checks?.tool_call_checks ?? [];
  const recorded = result.evaluation.checks;
  if (recorded.length < planned.length) return false;
  const tail = recorded.slice(recorded.length - planned.length);
  return planned.every((check, index) => {
    const entry = tail[index]!;
    return (
      entry.name === `tool_called: ${check.tool}` &&
      entry.label === check.label &&
      entry.requirement_level ===
        (check.requirement_level ?? DEFAULT_REQUIREMENT_LEVEL)
    );
  });
}

function verifyCanonicalArtifactInventory(
  result: RunResult,
  plan: ResolvedRunPlanV1,
): void {
  const expectedPaths = [
    'plan.json',
    'setup.json',
    'trajectory.json',
    'interaction.json',
    ...(hasDeterministicWorkspaceChecks(plan.evaluation.checks)
      ? ['workspace-evidence.json']
      : []),
    ...(plan.evaluation.judging_criteria.length > 0
      ? ['judge-evidence.json']
      : []),
  ];
  const actualPaths = result.artifacts.map(({ path }) => path);
  for (const expectedPath of expectedPaths) {
    if (!actualPaths.includes(expectedPath)) {
      throw new ArtifactStoreError(
        `Completed result is missing canonical artifact ${expectedPath}.`,
      );
    }
  }
  for (const actualPath of actualPaths) {
    if (!expectedPaths.includes(actualPath)) {
      throw new ArtifactStoreError(
        `Completed result contains noncanonical core artifact ${actualPath}.`,
      );
    }
  }
  if (
    result.artifacts.some(({ media_type }) => media_type !== 'application/json')
  ) {
    throw new ArtifactStoreError(
      'Canonical run artifacts must use the application/json media type.',
    );
  }
  if (result.artifacts.some(({ sensitivity }) => sensitivity !== undefined)) {
    throw new ArtifactStoreError(
      'Canonical run artifacts cannot contain restricted source bytes.',
    );
  }
  let nativeArtifacts = 0;
  for (const descriptor of result.supplemental_artifacts) {
    const artifactPath = descriptor.path;
    if (/^extensions\/[a-z0-9][a-z0-9._-]{0,127}\//.test(artifactPath)) {
      continue;
    }
    const nativePrefix = `native/${result.agent.adapter}/session.`;
    const extension = artifactPath.startsWith(nativePrefix)
      ? artifactPath.slice(nativePrefix.length)
      : '';
    if (
      !/^[a-z0-9]{1,16}$/.test(extension) ||
      descriptor.sensitivity !== 'restricted' ||
      result.agent.session_id === null
    ) {
      throw new ArtifactStoreError(
        `Supplemental artifact has an unsupported path or classification: ${artifactPath}`,
      );
    }
    nativeArtifacts += 1;
    if (nativeArtifacts > 1) {
      throw new ArtifactStoreError(
        'Completed result contains more than one root native artifact.',
      );
    }
  }
}

function verifySetupArtifact(
  result: RunResult,
  plan: ResolvedRunPlanV1,
  artifactBodies: ReadonlyMap<string, Buffer>,
): void {
  const artifactPath = 'setup.json';
  const body = requireCoreArtifact(result, artifactBodies, artifactPath);
  const setup = parseJsonArtifact(artifactPath, body, (value) =>
    parseSetupArtifact(value, { forgeVersion: result.forge.version }),
  );
  if (body.toString('utf8') !== serializeCanonicalJson(setup)) {
    throw new ArtifactStoreError('Completed setup.json is not canonical.');
  }
  if (
    setup.steps.length !== plan.setup.length ||
    setup.steps.some(
      (step, index) =>
        step.index !== index || step.uses !== plan.setup[index]?.uses,
    )
  ) {
    throw new ArtifactStoreError(
      'setup.json does not match the completed run plan.',
    );
  }

  for (const [index, step] of setup.steps.entries()) {
    if (step.uses === 'forge/plugin') {
      if (step.resolution === undefined) {
        throw new ArtifactStoreError(
          'setup.json omitted a plugin installation resolution.',
        );
      }
      let receipt: ReturnType<typeof parseAgentPluginInstallationReceipt>;
      try {
        receipt = parseAgentPluginInstallationReceipt(step.resolution);
      } catch (error) {
        throw new ArtifactStoreError(
          'setup.json contains an invalid plugin installation resolution.',
          { cause: error },
        );
      }
      const planned = plan.setup[index] as PluginSetupStepV1;
      const distribution = pluginDefinitionForAgent(
        planned.with.plugin,
        plan.agent.adapter,
      )?.distribution;
      const requestedName =
        distribution === undefined
          ? undefined
          : distribution.plugin.slice(0, distribution.plugin.indexOf('@'));
      const nativeName =
        typeof receipt.native_plugin_id === 'string'
          ? receipt.native_plugin_id.slice(
              0,
              receipt.native_plugin_id.indexOf('@'),
            )
          : undefined;
      if (
        distribution === undefined ||
        receipt.adapter !== plan.agent.adapter ||
        receipt.plugin !== distribution.plugin ||
        receipt.marketplace !== distribution.marketplace ||
        (plan.agent.adapter === 'opencode'
          ? receipt.installation !== 'opencode-bundle'
          : receipt.installation !== undefined || nativeName !== requestedName)
      ) {
        throw new ArtifactStoreError(
          'Plugin installation resolution does not match the completed run plan.',
        );
      }
    } else if (
      (step.uses === 'forge/write' ||
        step.uses === 'forge/command' ||
        step.uses === 'forge/credentials') &&
      step.resolution !== undefined
    ) {
      throw new ArtifactStoreError(
        `Static setup action ${step.uses} cannot record a resolution.`,
      );
    }
  }
}

function verifyInteractionArtifact(
  result: RunResult,
  artifactBodies: ReadonlyMap<string, Buffer>,
): InteractionArtifactV1 {
  const body = requireCoreArtifact(result, artifactBodies, 'interaction.json');
  const interaction = parseJsonArtifact('interaction.json', body, (value) =>
    parseInteractionArtifact(value, { forgeVersion: result.forge.version }),
  );
  if (
    interaction.mode !== result.interaction.mode ||
    interaction.turns.length !== result.interaction.turn_count ||
    interaction.stop_reason !== result.stop_reason ||
    serializeCanonicalJson(interaction.failure) !==
      serializeCanonicalJson(result.failure)
  ) {
    throw new ArtifactStoreError(
      'interaction.json does not match the completed result summary.',
    );
  }
  return interaction;
}

function verifyTrajectoryArtifact(
  result: RunResult,
  interaction: InteractionArtifactV1,
  artifactBodies: ReadonlyMap<string, Buffer>,
): AtifTrajectoryV1_8 {
  const path = 'trajectory.json';
  const body = requireCoreArtifact(result, artifactBodies, path);
  const trajectory = parseJsonArtifact(path, body, parseAtifTrajectory);

  if (interaction.turns.length === 0) {
    const validRolePlayerFailure =
      result.stop_reason === 'role_player_error' &&
      result.failure !== null &&
      result.agent.session_id === null &&
      result.evidence.provenance.source.kind === 'role_player_error' &&
      trajectory.session_id == null &&
      trajectory.steps.length === 1 &&
      trajectory.steps[0]?.source === 'system';
    if (!validRolePlayerFailure) {
      throw new ArtifactStoreError(
        'Zero-turn interaction requires the system-only role-player-error trajectory.',
      );
    }
    return trajectory;
  }

  const sessionId = result.agent.session_id;
  const source = result.evidence.provenance.source;
  const sourceSessionId =
    'session_id' in source ? source.session_id : undefined;
  if (
    sessionId === null ||
    sourceSessionId !== sessionId ||
    trajectory.session_id !== sessionId
  ) {
    throw new ArtifactStoreError(
      'trajectory.json session identity does not match the completed run.',
    );
  }

  if (
    !trajectoryCoversCompletedTurns(
      trajectory,
      interaction.turns.map((turn) => ({
        user: turn.user,
        assistant: turn.assistant,
        toolCalls: turn.tool_calls,
      })),
      source,
    )
  ) {
    throw new ArtifactStoreError(
      'trajectory.json does not cover every completed interaction turn.',
    );
  }
  return trajectory;
}

function verifyJudgeEvidence(
  result: RunResult,
  plan: ResolvedRunPlanV1,
  artifactBodies: ReadonlyMap<string, Buffer>,
  trajectory: AtifTrajectoryV1_8,
): void {
  const path = 'judge-evidence.json';
  const body = artifactBodies.get(path);
  const judgingRan = plan.evaluation.judging_criteria.length > 0;
  if ((body !== undefined) !== judgingRan) {
    throw new ArtifactStoreError(
      judgingRan
        ? 'Completed result with judged criteria is missing judge-evidence.json.'
        : 'Completed result without judged criteria contains judge-evidence.json.',
    );
  }
  if (body === undefined) return;
  if (!result.artifacts.some((descriptor) => descriptor.path === path)) {
    throw new ArtifactStoreError(
      'Canonical artifact judge-evidence.json must be claimed in result artifacts.',
    );
  }
  const judgeEvidence = parseJsonArtifact(path, body, (value) =>
    parseJudgeEvidence(value, { forgeVersion: result.forge.version }),
  );
  const warnings = criterionEvidenceWarnings({
    trajectory: result.evidence,
    workspace: judgeEvidence.workspace,
  });
  if (
    result.evaluation.evidence_warnings !== undefined &&
    serializeCanonicalJson(result.evaluation.evidence_warnings) !==
      serializeCanonicalJson(warnings)
  ) {
    throw new ArtifactStoreError(
      'Evaluation evidence warnings do not match the saved evidence.',
    );
  }
  if (judgeEvidence.transcript.omitted !== undefined) {
    let budget: JudgeEvidenceBudgetSelection;
    try {
      budget = selectJudgeEvidence({
        promptOverheadBytes: sizeJudgePrompt(plan, judgeEvidence.workspace)
          .promptOverheadBytes,
        driverTranscriptBytes: Buffer.byteLength(
          createJudgeTranscriptProjection(trajectory).transcriptJson,
          'utf8',
        ),
      });
    } catch (error) {
      throw new ArtifactStoreError(
        'judge-evidence.json prompt budget could not be verified.',
        { cause: error },
      );
    }
    if (
      result.evidence.provenance.source.kind !== 'driver_fallback' ||
      result.evidence.completeness !== 'fallback' ||
      budget.evidence !== 'omitted'
    ) {
      throw new ArtifactStoreError(
        'judge-evidence.json transcript omission is not justified by over-budget driver evidence.',
      );
    }
    return;
  }
  if (
    serializeCanonicalJson(judgeEvidence.transcript.steps) !==
    createJudgeTranscriptProjection(trajectory).transcriptJson
  ) {
    throw new ArtifactStoreError(
      'judge-evidence.json transcript steps do not match the projection of trajectory.json.',
    );
  }
}

function requireCoreArtifact(
  result: RunResult,
  artifactBodies: ReadonlyMap<string, Buffer>,
  artifactPath: string,
): Buffer {
  const body = artifactBodies.get(artifactPath);
  if (body === undefined) {
    throw new ArtifactStoreError(
      `Completed result is missing canonical artifact ${artifactPath}.`,
    );
  }
  if (
    !result.artifacts.some((descriptor) => descriptor.path === artifactPath)
  ) {
    throw new ArtifactStoreError(
      `Canonical artifact ${artifactPath} must be claimed in result artifacts.`,
    );
  }
  return body;
}

function parseJsonArtifact<T>(
  artifactPath: string,
  body: Buffer,
  parse: (input: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new ArtifactStoreError(`Completed ${artifactPath} is invalid JSON.`, {
      cause: error,
    });
  }
  try {
    return parse(value);
  } catch (error) {
    throw new ArtifactStoreError(
      `Completed ${artifactPath} does not match its schema.`,
      { cause: error },
    );
  }
}

async function ensureStoreRoot(requestedRoot: string): Promise<string> {
  await fs.mkdir(requestedRoot, { recursive: true, mode: 0o755 });
  const stat = await fs.lstat(requestedRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactStoreError(
      'Artifact store root must be a real directory.',
    );
  }
  return fs.realpath(requestedRoot);
}

async function readBoundedFile(file: string, maximum: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) {
    throw new ArtifactStoreError(
      'Artifact is unsafe or exceeds its declared size.',
    );
  }
  const body = await fs.readFile(file);
  if (body.byteLength > maximum) {
    throw new ArtifactStoreError('Artifact exceeds its declared size.');
  }
  return body;
}

async function listRegularFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new ArtifactStoreError('Completed run contains a symbolic link.');
      }
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) files.add(relative);
      else
        throw new ArtifactStoreError('Completed run contains a special file.');
    }
  };
  await visit(root, '');
  return files;
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId))
    throw new TypeError('runId is not a safe identifier.');
}

function assertArtifactPath(value: string): void {
  if (!isSafeDatasetRelativePath(value)) {
    throw new ArtifactStoreError(`Invalid artifact path: ${String(value)}`);
  }
}

function assertOpen(closed: boolean): void {
  if (closed) throw new ArtifactStoreError('Artifact transaction is closed.');
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
