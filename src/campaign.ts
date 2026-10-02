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
import type {CompletedRunV1} from './results/types.js';
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

/** Resume the original selection even when the new invocation has no filters. */
export async function readCampaignSelections(root: string): Promise<RunSelection[]> {
  const campaign = await readCampaign(path.join(root, 'campaign.json'));
  if (campaign === undefined) {
    throw new Error('No experiment execution with this ID exists in the output directory.');
  }
  if (campaign.experiment_run_id !== path.basename(root)) {
    throw new Error('Experiment execution ID does not match its checkpoint.');
  }
  return campaign.entries.map(({selection}) => selection);
}

/** CLI-owned checkpoint, separate from immutable per-run artifacts. */
export interface CampaignOptions {
  readonly root: string;
  readonly plans: readonly ResolvedRunPlanV1[];
  readonly composition: ForgeComposition;
  readonly engine: ForgeEngine;
  readonly resume: boolean;
  readonly signal: AbortSignal;
  readonly execute: (input: ExecuteEvalInput) => Promise<CompletedRunV1>;
  readonly runIdFactory: () => string;
  readonly progress: (event: Readonly<Record<string, unknown>>) => void;
}

/** Execute each pending selection once, retaining all earlier attempt IDs. */
export async function runCampaign(options: CampaignOptions): Promise<{
  campaign: string;
  total: number;
  executed: number;
  skipped: number;
  completed: number;
  errored: number;
}> {
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
        const recovered = await inspectAttempt(options, root, entry.plan_sha256, last.run_id);
        if (
          recovered.state !== 'errored' ||
          recovered.error_code !== 'invalid_artifacts' ||
          last.state !== 'errored'
        ) {
          entry.attempts[entry.attempts.length - 1] = recovered;
        }
        if (recovered.state === 'completed') {
          skipped += 1;
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
    for (const index of pending) {
      options.signal.throwIfAborted();
      const entry = campaign.entries[index]!;
      const runId = runIdSchema.parse(options.runIdFactory());
      if (runIds.has(runId) || await exists(path.join(root, 'runs', runId))) {
        throw new Error('Campaign run ID already exists.');
      }
      runIds.add(runId);
      entry.attempts.push({run_id: runId, state: 'running'});
      await writeCampaign(checkpoint, campaign);
      options.progress({selection: entry.selection, run_id: runId, state: 'running'});
      let attempt: Attempt;
      executed += 1;
      try {
        const result = await options.execute({
          runId,
          plan: options.plans[index]!,
          composition: options.composition,
          signal: options.signal,
        });
        if (path.resolve(result.location) !== path.join(root, 'runs', runId)) {
          throw new Error('Campaigns require the local artifact store at the selected output directory.');
        }
        attempt = await inspectAttempt(options, root, entry.plan_sha256, runId);
      } catch (error) {
        // Error messages and causes may carry host data or credentials. Persist
        // only stable codes, never arbitrary strings from an adapter.
        attempt = {
          run_id: runId,
          state: 'errored',
          error_code: error instanceof ForgeExecutionError ? error.code : 'execution_error',
        };
      }
      entry.attempts[entry.attempts.length - 1] = attempt;
      await writeCampaign(checkpoint, campaign);
      options.progress({selection: entry.selection, ...attempt});
      if (attempt.state === 'completed') completed += 1;
      else errored += 1;
      options.signal.throwIfAborted();
    }
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
  options: CampaignOptions,
  root: string,
  planDigest: string,
  runId: string,
): Promise<Attempt> {
  try {
    const completed = await options.engine.verifyCompletedRun(path.join(root, 'runs', runId));
    const descriptor = completed.result.artifacts.find((artifact) => artifact.path === 'plan.json');
    if (descriptor?.sha256 !== planDigest) throw new Error('Run belongs to a different plan.');
    return completed.result.failure === null
      ? {run_id: runId, state: 'completed'}
      : {run_id: runId, state: 'errored', error_code: 'role_player_error'};
  } catch {
    return {run_id: runId, state: 'errored', error_code: 'invalid_artifacts'};
  }
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
  await fs.writeFile(temporary, serializeCanonicalJson({pid: process.pid}), {flag: 'wx', mode: 0o600});
  try {
    while (true) {
      try {
        // Linking publishes an already-complete lock file atomically.
        await fs.link(temporary, lock);
        break;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        try {
          const stat = await fs.lstat(lock);
          if (!stat.isFile()) throw new Error('Invalid campaign lock.');
          const owner = z.object({pid: z.number().int().positive()}).strict()
            .parse(JSON.parse(await fs.readFile(lock, 'utf8')));
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            if (!hasCode(probeError, 'ESRCH')) throw probeError;
            const current = await fs.lstat(lock);
            if (stat.ino === current.ino && stat.dev === current.dev) await fs.unlink(lock);
            continue;
          }
          throw new Error('Another campaign process is using this output directory.');
        } catch (lockError) {
          if (hasCode(lockError, 'ENOENT')) continue;
          throw lockError;
        }
      }
    }
    const owned = await fs.lstat(lock);
    return async () => {
      const current = await fs.lstat(lock);
      if (owned.ino === current.ino && owned.dev === current.dev) await fs.unlink(lock);
    };
  } finally {
    await fs.rm(temporary, {force: true});
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
