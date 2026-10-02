import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';

import type {ForgeComposition} from './contracts/composition.js';
import type {ForgeEngine} from './engine.js';
import {ForgeExecutionError} from './execution/errors.js';
import type {ExecuteEvalInput} from './execution/execute.js';
import {isSha256Digest} from './model/hashes.js';
import {parseRunSelection} from './model/parse.js';
import type {ResolvedRunPlanV1, RunSelection} from './model/types.js';
import {resolvedRunPlanSha256} from './planning/planner.js';
import type {CompletedRunV1, EvalStatus} from './results/types.js';
import {serializeCanonicalJson} from './serialization.js';

const MAX_CAMPAIGN_BYTES = 16 * 1024 * 1024;
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const errorCodeSchema = z.enum([
  'execution_error', 'invalid_artifacts', 'role_player_error',
  'aborted', 'agent_failed', 'artifact_failed', 'credential_failed',
  'evaluation_failed', 'evidence_failed', 'invalid_plan', 'runtime_failed',
  'setup_failed', 'unsupported_capability',
]);
const attemptSchema = z.discriminatedUnion('state', [
  z.object({run_id: runIdSchema, state: z.literal('running')}).strict(),
  z.object({run_id: runIdSchema, state: z.literal('completed')}).strict(),
  z.object({
    run_id: runIdSchema,
    state: z.literal('errored'),
    error_code: errorCodeSchema,
  }).strict(),
]);
const campaignSchema = z.object({
  schema_version: z.literal(1),
  experiment_run_id: runIdSchema,
  entries: z.array(z.object({
    selection: z.unknown().transform(parseRunSelection),
    plan_sha256: z.string().refine(isSha256Digest),
    attempts: z.array(attemptSchema).max(10_000),
  }).strict()).min(1).max(100_000),
}).strict();

type Campaign = z.infer<typeof campaignSchema>;
type Attempt = z.infer<typeof attemptSchema>;
type SettledAttempt = Exclude<Attempt, {state: 'running'}>;

/** Bounded metadata from a verified local commit, independent of publication. */
export interface CampaignArtifact {
  readonly location: string;
  readonly evaluation: {readonly status: EvalStatus; readonly score: number};
  readonly failure: 'role_player_error' | null;
}

/** The effective latest attempt for one selection, in saved selection order. */
export interface CampaignOutcome {
  readonly selection: RunSelection;
  readonly plan_sha256: string;
  readonly run_id: string | null;
  readonly state: 'pending' | 'completed' | 'errored';
  readonly error_code: Extract<Attempt, {state: 'errored'}>['error_code'] | null;
  readonly artifact: CampaignArtifact | null;
}

export interface CampaignInspection {
  readonly experiment_run_id: string;
  readonly location: string;
  readonly campaign: string;
  readonly outcomes: readonly CampaignOutcome[];
}

export type CampaignProgressEvent =
  | {readonly state: 'started' | 'resuming'; readonly location: string}
  | {
      readonly state: 'running' | 'completed' | 'skipped';
      readonly selection: RunSelection;
      readonly run_id: string;
    }
  | {
      readonly state: 'errored';
      readonly selection: RunSelection;
      readonly run_id: string;
      readonly error_code: Extract<Attempt, {state: 'errored'}>['error_code'];
    };

export interface CampaignSummary {
  readonly campaign: string;
  readonly total: number;
  readonly executed: number;
  readonly skipped: number;
  readonly completed: number;
  readonly errored: number;
}

/** Resume the original selection even when the new invocation has no filters. */
export async function readCampaignSelections(root: string): Promise<RunSelection[]> {
  root = path.resolve(root);
  const campaign = await requireCampaign(root);
  return campaign.entries.map(({selection}) => selection);
}

/** Verify latest committed attempts without loading inputs or changing state. */
export async function inspectCampaign(options: {
  readonly root: string;
  readonly engine: ForgeEngine;
  readonly signal?: AbortSignal;
}): Promise<CampaignInspection> {
  const root = path.resolve(options.root);
  options.signal?.throwIfAborted();
  const campaign = await requireCampaign(root);
  const outcomes: CampaignOutcome[] = [];
  for (const entry of campaign.entries) {
    options.signal?.throwIfAborted();
    const last = entry.attempts.at(-1);
    if (last === undefined) {
      outcomes.push({selection: entry.selection, plan_sha256: entry.plan_sha256,
        run_id: null, state: 'pending', error_code: null, artifact: null});
      continue;
    }
    const inspected = await inspectAttempt(options.engine, root, entry.plan_sha256, last.run_id, entry.selection);
    const attempt = inspected.artifact === null && last.state === 'errored' ? last : inspected.attempt;
    outcomes.push(campaignOutcome(entry, attempt, inspected.artifact));
  }
  options.signal?.throwIfAborted();
  return {experiment_run_id: campaign.experiment_run_id, location: root,
    campaign: path.join(root, 'campaign.json'), outcomes};
}

async function requireCampaign(root: string): Promise<Campaign> {
  const campaign = await readCampaign(path.join(root, 'campaign.json'));
  if (campaign === undefined) {
    throw new Error('No experiment execution with this ID exists in the output directory.');
  }
  if (campaign.experiment_run_id !== path.basename(root)) {
    throw new Error('Experiment execution ID does not match its checkpoint.');
  }
  return campaign;
}

/** Local campaign checkpoint and scheduling, separate from eval semantics. */
export interface CampaignOptions {
  readonly root: string;
  readonly plans: readonly ResolvedRunPlanV1[];
  /** Pure preflight composition; execute may supply per-run capabilities. */
  readonly composition: ForgeComposition;
  readonly engine: ForgeEngine;
  readonly resume: boolean;
  /** Maximum simultaneous eval executions; defaults to one. Not plan semantics. */
  readonly jobs?: number;
  readonly signal: AbortSignal;
  /**
   * Execute with the supplied engine and local artifact root. May compose
   * per-run host resources; must honor signal and finish cleanup before settling.
   */
  readonly execute: (input: ExecuteEvalInput) => Promise<CompletedRunV1>;
  readonly runIdFactory: () => string;
  readonly progress: (event: CampaignProgressEvent) => void;
  /** Synchronous result collection, including verified selections skipped on resume. */
  readonly onOutcome?: (outcome: CampaignOutcome, selectionIndex: number) => void;
}

/** Execute each pending selection once, retaining all earlier attempt IDs. */
export async function runCampaign(options: CampaignOptions): Promise<CampaignSummary> {
  const jobs = options.jobs ?? 1;
  if (!Number.isSafeInteger(jobs) || jobs < 1) {
    throw new Error('Campaign jobs must be a positive safe integer.');
  }
  const root = path.resolve(options.root);
  if (root === path.parse(root).root) {
    throw new Error('Campaign output must not be a filesystem root.');
  }
  const identities = options.plans.map((plan) => ({
    selection: plan.selection,
    plan_sha256: resolvedRunPlanSha256(plan),
  }));
  // Validate the whole campaign before checkpoint writes or any execution.
  campaignSchema.parse({
    schema_version: 1,
    experiment_run_id: path.basename(root),
    entries: identities.map((identity) => ({...identity, attempts: []})),
  });
  for (const plan of options.plans) {
    options.engine.preflightEval({plan, composition: options.composition});
  }
  options.signal.throwIfAborted();
  if (options.resume) {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid experiment execution directory.');
  } else {
    await fs.mkdir(path.dirname(root), {recursive: true});
    await fs.mkdir(root);
  }
  const release = await acquireCampaignLock(root);
  const checkpoint = path.join(root, 'campaign.json');
  try {
    let campaign = await readCampaign(checkpoint);
    if (campaign === undefined) {
      if (options.resume) throw new Error('No campaign.json to resume in the output directory.');
      campaign = campaignSchema.parse({
        schema_version: 1,
        experiment_run_id: path.basename(root),
        entries: identities.map((identity) => ({...identity, attempts: []})),
      });
    } else {
      if (!options.resume) {
        throw new Error('This experiment execution already exists; resume it with its ID.');
      }
      if (campaign.experiment_run_id !== path.basename(root)) {
        throw new Error('Experiment execution ID does not match its checkpoint.');
      }
      const storedIdentities = campaign.entries.map(({selection, plan_sha256}) => ({
        selection, plan_sha256,
      }));
      if (serializeCanonicalJson(storedIdentities) !== serializeCanonicalJson(identities)) {
        throw new Error('Cannot resume: the selected resolved plans differ from the saved campaign.');
      }
    }
    const runIds = new Set<string>();
    for (const entry of campaign.entries) {
      for (const attempt of entry.attempts) {
        if (runIds.has(attempt.run_id)) throw new Error('Campaign contains duplicate run IDs.');
        runIds.add(attempt.run_id);
      }
    }

    // Inspect every prior result before running anything. This also recovers a
    // run committed just before the process died while updating its checkpoint.
    const pending: number[] = [];
    let skipped = 0;
    for (const [index, entry] of campaign.entries.entries()) {
      options.signal.throwIfAborted();
      const last = entry.attempts.at(-1);
      if (last !== undefined) {
        const inspected = await inspectAttempt(options.engine, root, entry.plan_sha256, last.run_id, entry.selection);
        const recovered = inspected.attempt;
        if (
          recovered.state !== 'errored' ||
          recovered.error_code !== 'invalid_artifacts' ||
          last.state !== 'errored'
        ) {
          entry.attempts[entry.attempts.length - 1] = recovered;
        }
        if (recovered.state === 'completed') {
          skipped += 1;
          options.onOutcome?.(campaignOutcome(entry, recovered, inspected.artifact), index);
          options.progress({selection: entry.selection, run_id: last.run_id, state: 'skipped'});
          continue;
        }
      }
      pending.push(index);
    }
    await writeCampaign(checkpoint, campaign);
    options.progress({state: options.resume ? 'resuming' : 'started', location: root});
    let completed = skipped;
    let errored = 0;
    let executed = 0;
    let nextPending = 0;
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let failed = false;
    let failure: unknown;
    function fail(error: unknown) {
      if (failed) return;
      failed = true;
      failure = error;
      controller.abort(error);
    }
    // Both mutation and persistence belong to one coordinator. Workers never
    // write snapshots independently or reserve the same pending selection.
    let updates = Promise.resolve();
    function update<T>(action: () => Promise<T>): Promise<T> {
      const operation = updates.then(async () => {
        try {
          return await action();
        } catch (error) {
          fail(error);
          throw error;
        }
      });
      updates = operation.then(() => undefined, () => undefined);
      return operation;
    }
    async function worker() {
      try {
        while (!signal.aborted) {
          const task = await update(async () => {
            if (signal.aborted) return undefined;
            const index = pending[nextPending++];
            if (index === undefined) return undefined;
            const entry = campaign!.entries[index]!;
            const runId = runIdSchema.parse(options.runIdFactory());
            if (runIds.has(runId) || await exists(path.join(root, 'runs', runId))) {
              throw new Error('Campaign run ID already exists.');
            }
            runIds.add(runId);
            entry.attempts.push({run_id: runId, state: 'running'});
            await writeCampaign(checkpoint, campaign!);
            options.progress({selection: entry.selection, run_id: runId, state: 'running'});
            return {index, runId, entry};
          });
          if (task === undefined) return;
          const {index, runId, entry} = task;
          let attempt: SettledAttempt;
          let artifact: CampaignArtifact | null = null;
          try {
            signal.throwIfAborted();
            executed += 1;
            const result = await options.execute({
              runId,
              plan: options.plans[index]!,
              composition: options.composition,
              signal,
            });
            const [actualLocation, expectedLocation] = await Promise.all([
              fs.realpath(result.location),
              fs.realpath(path.join(root, 'runs', runId)),
            ]);
            if (actualLocation !== expectedLocation) {
              throw new Error('Campaigns require the local artifact store at the selected output directory.');
            }
            const inspected = await inspectAttempt(options.engine, root, entry.plan_sha256, runId, entry.selection);
            attempt = inspected.attempt;
            artifact = inspected.artifact;
          } catch (error) {
            // Error messages and causes may carry host data or credentials.
            // Persist stable codes, never arbitrary strings from an adapter.
            attempt = {
              run_id: runId,
              state: 'errored',
              error_code: signal.aborted ? 'aborted'
                : error instanceof ForgeExecutionError ? error.code : 'execution_error',
            };
            // A callback can fail after its local commit (for example during
            // host cleanup). Keep the execution error while exposing verified
            // artifacts for independent publication.
            if (options.onOutcome !== undefined) {
              artifact = (await inspectAttempt(options.engine, root, entry.plan_sha256, runId, entry.selection)).artifact;
            }
          }
          await update(async () => {
            entry.attempts[entry.attempts.length - 1] = attempt;
            await writeCampaign(checkpoint, campaign!);
            options.progress({selection: entry.selection, ...attempt});
            if (attempt.state === 'completed') completed += 1;
            else errored += 1;
            options.onOutcome?.(campaignOutcome(entry, attempt, artifact), index);
          });
        }
      } catch (error) {
        fail(error);
      }
    }
    // Retain the campaign lock until every active callback has cleaned up,
    // including when cancellation or a coordinator failure stops new work.
    await Promise.all(Array.from({length: Math.min(jobs, pending.length)}, () => worker()));
    if (failed) throw failure;
    options.signal.throwIfAborted();
    return {
      campaign: checkpoint,
      total: campaign.entries.length,
      executed,
      skipped,
      completed,
      errored,
    };
  } finally {
    await release();
  }
}

async function inspectAttempt(
  engine: ForgeEngine,
  root: string,
  planDigest: string,
  runId: string,
  selection: RunSelection,
): Promise<{attempt: SettledAttempt; artifact: CampaignArtifact | null}> {
  try {
    const location = path.join(root, 'runs', runId);
    const completed = await engine.verifyCompletedRun(location);
    const descriptor = completed.result.artifacts.find((artifact) => artifact.path === 'plan.json');
    if (descriptor?.sha256 !== planDigest) throw new Error('Run belongs to a different plan.');
    if (serializeCanonicalJson(completed.result.selection) !== serializeCanonicalJson(selection)) {
      throw new Error('Run belongs to a different selection.');
    }
    const attempt: SettledAttempt = completed.result.failure === null
      ? {run_id: runId, state: 'completed'}
      : {run_id: runId, state: 'errored', error_code: 'role_player_error'};
    return {attempt, artifact: {location,
      evaluation: {status: completed.result.evaluation.status, score: completed.result.evaluation.score},
      failure: completed.result.failure === null ? null : 'role_player_error'}};
  } catch {
    return {attempt: {run_id: runId, state: 'errored', error_code: 'invalid_artifacts'}, artifact: null};
  }
}

function campaignOutcome(
  entry: Campaign['entries'][number],
  attempt: SettledAttempt,
  artifact: CampaignArtifact | null,
): CampaignOutcome {
  return {selection: entry.selection, plan_sha256: entry.plan_sha256,
    run_id: attempt.run_id, state: attempt.state,
    error_code: attempt.state === 'errored' ? attempt.error_code : null, artifact};
}

async function readCampaign(checkpoint: string): Promise<Campaign | undefined> {
  try {
    const stat = await fs.lstat(checkpoint);
    if (!stat.isFile() || stat.size > MAX_CAMPAIGN_BYTES) throw new Error('Invalid campaign checkpoint.');
    return campaignSchema.parse(JSON.parse(await fs.readFile(checkpoint, 'utf8')));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new Error('Cannot read a valid schema-version-1 campaign.json.', {cause: error});
  }
}

async function writeCampaign(checkpoint: string, campaign: Campaign): Promise<void> {
  const body = serializeCanonicalJson(campaignSchema.parse(campaign));
  if (Buffer.byteLength(body) > MAX_CAMPAIGN_BYTES) throw new Error('Campaign checkpoint exceeds its byte limit.');
  const temporary = `${checkpoint}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, checkpoint);
    const directory = await fs.open(path.dirname(checkpoint), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, {force: true});
  }
}

/** One writer per local output directory, with recovery after process death. */
async function acquireCampaignLock(root: string): Promise<() => Promise<void>> {
  const lock = path.join(root, '.campaign.lock');
  const temporary = `${lock}.${randomUUID()}`;
  const ownerName = `owner-${randomUUID()}.json`;
  await fs.mkdir(temporary, {mode: 0o700});
  try {
    await fs.writeFile(path.join(temporary, ownerName), serializeCanonicalJson({pid: process.pid}), {
      flag: 'wx', mode: 0o600,
    });
    while (true) {
      try {
        // Publish a nonempty directory atomically. A competing rename or rmdir
        // cannot replace it while its unique owner marker remains present.
        await fs.rename(temporary, lock);
        break;
      } catch (error) {
        if (hasCode(error, 'EPERM')) {
          // Windows reports EPERM for a directory collision. Only treat it as
          // contention when the destination is an existing real directory.
          const destination = await fs.lstat(lock).catch(() => undefined);
          if (!destination?.isDirectory() || destination.isSymbolicLink()) throw error;
        } else if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) {
          throw error;
        }
        try {
          await reclaimCampaignLock(lock);
        } catch (lockError) {
          if (hasCode(lockError, 'ENOENT')) continue;
          throw lockError;
        }
      }
    }
    return async () => {
      await fs.unlink(path.join(lock, ownerName));
      await removeEmptyLockDirectory(lock);
    };
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

async function reclaimCampaignLock(lock: string): Promise<void> {
  const stat = await fs.lstat(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid campaign lock.');
  const entries = await fs.readdir(lock);
  if (entries.length === 0) {
    // Recovery or release may have removed the marker before a process exit.
    await removeEmptyLockDirectory(lock);
    return;
  }
  const ownerName = entries[0]!;
  if (entries.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(ownerName)) {
    throw new Error('Invalid campaign lock owner.');
  }
  const ownerFile = path.join(lock, ownerName);
  const ownerStat = await fs.lstat(ownerFile);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 128) {
    throw new Error('Invalid campaign lock owner.');
  }
  const owner = z.object({pid: z.number().int().positive()}).strict()
    .parse(JSON.parse(await fs.readFile(ownerFile, 'utf8')));
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!hasCode(error, 'ESRCH')) throw error;
    // A delayed reclaimer can only remove the marker it inspected, never a
    // replacement owner's marker. Never recursively remove the published lock.
    await fs.unlink(ownerFile);
    await removeEmptyLockDirectory(lock);
    return;
  }
  throw new Error('Another campaign process is using this output directory.');
}

async function removeEmptyLockDirectory(lock: string): Promise<void> {
  try {
    await fs.rmdir(lock);
  } catch (error) {
    // A contender may already have published its nonempty lock or removed the
    // empty directory. Neither outcome permits deleting a current owner.
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error;
  }
}

async function exists(location: string): Promise<boolean> {
  try {
    await fs.lstat(location);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
