import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  CommittedRun,
  RunArtifact,
  RunArtifactStore,
  RunArtifactTransaction,
} from '../contracts/artifacts.js';
import {parseAtifTrajectory} from '../atif/index.js';
import {trajectoryCoversCompletedTurns} from '../evidence/selection.js';
import {sha256Digest} from '../model/hashes.js';
import {isSafeDatasetRelativePath} from '../model/paths.js';
import {canonicalJsonSha256, serializeCanonicalJson} from '../serialization.js';
import {
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseRunResult,
} from './parse.js';
import type {
  ArtifactDescriptorV1,
  CompletedRun,
  InteractionArtifactV1,
  RunResult,
} from './types.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RESULT_BYTES = 1024 * 1024;
const VERIFIED_ARTIFACT_PATHS = new Set([
  'interaction.json',
  'judge-evidence.json',
  'trajectory.json',
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
      await fs.mkdir(stagingRoot, {recursive: true, mode: 0o700});
      await fs.mkdir(runsRoot, {recursive: true, mode: 0o755});
      const finalRunDir = path.join(runsRoot, runId);
      if (await pathExists(finalRunDir)) throw new RunIdConflictError(runId);
      const stagingRunDir = await fs.mkdtemp(path.join(stagingRoot, `${runId}-`));
      const written = new Map<string, ArtifactDescriptorV1>();
      let closed = false;

      const rollback = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await fs.rm(stagingRunDir, {recursive: true, force: true});
      };

      return {
        async write(artifact: RunArtifact): Promise<void> {
          assertOpen(closed);
          assertArtifactPath(artifact.path);
          if (artifact.path === 'result.json') {
            throw new ArtifactStoreError('result.json is reserved for atomic commit.');
          }
          if (written.has(artifact.path)) {
            throw new ArtifactStoreError(`Duplicate artifact path: ${artifact.path}`);
          }
          if (!(artifact.body instanceof Uint8Array) || !artifact.mediaType) {
            throw new ArtifactStoreError('Artifacts require bytes and a media type.');
          }
          const destination = path.join(
            stagingRunDir,
            ...artifact.path.split('/'),
          );
          await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o755});
          const handle = await fs.open(destination, 'wx', 0o644);
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
          });
        },
        async commit(value: Readonly<Record<string, unknown>>): Promise<CommittedRun> {
          assertOpen(closed);
          let result: RunResult;
          try {
            result = parseRunResult(value);
            assertResultArtifacts(result, written);
            if (result.run_id !== runId) throw new RunIdConflictError(runId);
            const resultBody = Buffer.from(serializeCanonicalJson(result), 'utf8');
            if (resultBody.byteLength > MAX_RESULT_BYTES) {
              throw new ArtifactStoreError('result.json exceeds its byte limit.');
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
            if (await pathExists(finalRunDir)) throw new RunIdConflictError(runId);
            await fs.rename(stagingRunDir, finalRunDir);
            closed = true;
            await syncDirectory(stagingRoot);
            await syncDirectory(runsRoot);
          } catch (error) {
            if (!closed) {
              closed = true;
              await fs.rm(stagingRunDir, {recursive: true, force: true});
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
export async function verifyCompletedRun(location: string): Promise<CompletedRun> {
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
    throw new ArtifactStoreError('Completed result.json is invalid JSON.', {cause: error});
  }
  const result = parseRunResult(unknownResult);
  if (path.basename(runDir) !== result.run_id) {
    throw new ArtifactStoreError('Completed run directory does not match run_id.');
  }

  const expectedPaths = new Set(['result.json']);
  const artifactBodies = new Map<string, Buffer>();
  for (const descriptor of [...result.artifacts, ...result.supplemental_artifacts]) {
    assertArtifactPath(descriptor.path);
    if (expectedPaths.has(descriptor.path)) {
      throw new ArtifactStoreError(`Duplicate claimed artifact: ${descriptor.path}`);
    }
    expectedPaths.add(descriptor.path);
    const body = await readBoundedFile(
      path.join(runDir, ...descriptor.path.split('/')),
      descriptor.size_bytes,
    );
    if (
      body.byteLength !== descriptor.size_bytes ||
      sha256Digest(body) !== descriptor.sha256
    ) {
      throw new ArtifactStoreError(`Artifact does not match its descriptor: ${descriptor.path}`);
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
  if (canonicalJsonSha256(result.artifacts) !== result.artifact_set_sha256) {
    throw new ArtifactStoreError('Canonical artifact-set digest is invalid.');
  }
  const interaction = verifyInteractionArtifact(result, artifactBodies);
  const trajectoryBody = verifyTrajectoryArtifact(
    result,
    interaction,
    artifactBodies,
  );
  verifyJudgeEvidence(result, artifactBodies, trajectoryBody);
  return {runId: result.run_id, location: runDir, result};
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
    throw new ArtifactStoreError('Result does not claim every staged artifact.');
  }
  const claimedPaths = new Set<string>();
  for (const descriptor of claimed) {
    if (claimedPaths.has(descriptor.path)) {
      throw new ArtifactStoreError(`Duplicate claimed artifact: ${descriptor.path}`);
    }
    claimedPaths.add(descriptor.path);
    const actual = written.get(descriptor.path);
    if (
      !actual ||
      actual.media_type !== descriptor.media_type ||
      actual.size_bytes !== descriptor.size_bytes ||
      actual.sha256 !== descriptor.sha256
    ) {
      throw new ArtifactStoreError(`Result descriptor mismatch: ${descriptor.path}`);
    }
  }
  if (canonicalJsonSha256(result.artifacts) !== result.artifact_set_sha256) {
    throw new ArtifactStoreError('Result artifact-set digest is invalid.');
  }
}

function verifyInteractionArtifact(
  result: RunResult,
  artifactBodies: ReadonlyMap<string, Buffer>,
): InteractionArtifactV1 {
  const body = requireCoreArtifact(result, artifactBodies, 'interaction.json');
  const interaction = parseJsonArtifact(
    'interaction.json',
    body,
    parseInteractionArtifact,
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
): Buffer {
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
    return body;
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
    )
  ) {
    throw new ArtifactStoreError(
      'trajectory.json does not cover every completed interaction turn.',
    );
  }
  return body;
}

function verifyJudgeEvidence(
  result: RunResult,
  artifactBodies: ReadonlyMap<string, Buffer>,
  trajectory: Uint8Array,
): void {
  const path = 'judge-evidence.json';
  const body = artifactBodies.get(path);
  const judgingRan = result.evaluation.guidelines_total > 0;
  if ((body !== undefined) !== judgingRan) {
    throw new ArtifactStoreError(
      judgingRan
        ? 'Completed result with judged guidelines is missing judge-evidence.json.'
        : 'Completed result without judged guidelines contains judge-evidence.json.',
    );
  }
  if (body === undefined) return;
  if (!result.artifacts.some((descriptor) => descriptor.path === path)) {
    throw new ArtifactStoreError(
      'Canonical artifact judge-evidence.json must be claimed in result artifacts.',
    );
  }
  const judgeEvidence = parseJsonArtifact(path, body, parseJudgeEvidence);
  if (judgeEvidence.trajectory_sha256 !== sha256Digest(trajectory)) {
    throw new ArtifactStoreError(
      'judge-evidence.json trajectory_sha256 does not match trajectory.json.',
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
  if (!result.artifacts.some((descriptor) => descriptor.path === artifactPath)) {
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
    throw new ArtifactStoreError(
      `Completed ${artifactPath} is invalid JSON.`,
      {cause: error},
    );
  }
  try {
    return parse(value);
  } catch (error) {
    throw new ArtifactStoreError(
      `Completed ${artifactPath} does not match its schema.`,
      {cause: error},
    );
  }
}

async function ensureStoreRoot(requestedRoot: string): Promise<string> {
  await fs.mkdir(requestedRoot, {recursive: true, mode: 0o755});
  const stat = await fs.lstat(requestedRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactStoreError('Artifact store root must be a real directory.');
  }
  return fs.realpath(requestedRoot);
}

async function readBoundedFile(file: string, maximum: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) {
    throw new ArtifactStoreError('Artifact is unsafe or exceeds its declared size.');
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
    const entries = await fs.readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new ArtifactStoreError('Completed run contains a symbolic link.');
      }
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) files.add(relative);
      else throw new ArtifactStoreError('Completed run contains a special file.');
    }
  };
  await visit(root, '');
  return files;
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new TypeError('runId is not a safe identifier.');
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
