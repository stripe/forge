import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { readLastExperimentRunEvent } from './experimentEvents.ts';
import {
  type ExperimentRunAttempt,
  type ExperimentRunCheckpoint,
  MAX_EXPERIMENT_RUN_BYTES,
  parseExperimentRunCheckpoint,
} from './experimentModel.ts';
import type { AgentSelectionV1 } from './model/types.ts';
import { serializeCanonicalJson } from './serialization.ts';

type FailedAttempt = Extract<ExperimentRunAttempt, { state: 'errored' }>;
type AgentModel = Pick<AgentSelectionV1, 'adapter' | 'provider' | 'model'>;

export type ExperimentRunLiveness = {
  readonly state: 'alive' | 'stale' | 'no_lock';
  readonly pid: number | null;
};

export interface ExperimentRunStatus {
  readonly experiment_run_id: string;
  readonly counts: {
    pending: number;
    running: number;
    completed: number;
    errored: number;
  };
  readonly failures: readonly {
    readonly error_code: FailedAttempt['error_code'];
    readonly diagnostic?: FailedAttempt['diagnostic'];
    readonly count: number;
  }[];
  readonly in_flight: readonly {
    readonly agent: AgentModel;
    readonly run_ids: readonly string[];
  }[];
  readonly last_event_at: string | null;
  readonly liveness: ExperimentRunLiveness;
}

/** Counts describe latest attempts; failure groups include the full retry history. */
export function summarizeExperimentRun(
  checkpoint: ExperimentRunCheckpoint,
  lastEventAt: string | null,
  liveness: ExperimentRunLiveness,
): ExperimentRunStatus {
  const counts = { pending: 0, running: 0, completed: 0, errored: 0 };
  const failures = new Map<
    string,
    {
      error_code: FailedAttempt['error_code'];
      diagnostic?: FailedAttempt['diagnostic'];
      count: number;
    }
  >();
  const inFlight = new Map<string, { agent: AgentModel; run_ids: string[] }>();
  for (const entry of checkpoint.entries) {
    const latest = entry.attempts.at(-1);
    counts[latest?.state ?? 'pending'] += 1;
    if (latest?.state === 'running') {
      const { adapter, provider, model } = entry.selection.agent;
      const agent = { adapter, provider, model };
      const key = serializeCanonicalJson(agent);
      const group = inFlight.get(key) ?? { agent, run_ids: [] };
      group.run_ids.push(latest.run_id);
      inFlight.set(key, group);
    }
    for (const attempt of entry.attempts) {
      if (attempt.state !== 'errored') continue;
      const { error_code, diagnostic } = attempt;
      const failure = {
        error_code,
        ...(diagnostic === undefined ? {} : { diagnostic: { ...diagnostic } }),
      };
      const key = serializeCanonicalJson(failure);
      const group = failures.get(key) ?? { ...failure, count: 0 };
      group.count += 1;
      failures.set(key, group);
    }
  }
  return {
    experiment_run_id: checkpoint.experiment_run_id,
    counts,
    failures: [...failures.values()],
    in_flight: [...inFlight.values()],
    last_event_at: lastEventAt,
    liveness: { ...liveness },
  };
}

/** Independent observations, without a lock or any filesystem mutation. */
export async function readExperimentRunStatus(
  root: string,
): Promise<ExperimentRunStatus> {
  const checkpoint = parseExperimentRunCheckpoint(
    JSON.parse(
      await readStatusFile(
        path.join(root, 'experiment.json'),
        MAX_EXPERIMENT_RUN_BYTES,
      ),
    ),
  );
  if (checkpoint.experiment_run_id !== path.basename(path.resolve(root)))
    throw new Error('Experiment run ID does not match its directory.');
  const event = await readLastExperimentRunEvent(root);
  if (event && event.experiment_run_id !== checkpoint.experiment_run_id)
    throw new Error('Experiment event belongs to another run.');
  return summarizeExperimentRun(
    checkpoint,
    event?.observed_at ?? null,
    await readLiveness(root),
  );
}

async function readStatusFile(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Invalid experiment status file.');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes)
      throw new Error('Experiment status file exceeds its byte limit.');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readLiveness(root: string): Promise<ExperimentRunLiveness> {
  const lock = path.join(root, '.experiment.lock');
  try {
    const stat = await fs.lstat(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid experiment run lock.');
    const entries = await fs.readdir(lock);
    if (entries.length === 0) return { state: 'stale', pid: null };
    const name = entries[0]!;
    if (entries.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(name))
      throw new Error('Invalid experiment run lock owner.');
    const { pid } = z
      .object({ pid: z.number().int().positive().max(2_147_483_647) })
      .strict()
      .parse(JSON.parse(await readStatusFile(path.join(lock, name), 128)));
    try {
      process.kill(pid, 0);
      return { state: 'alive', pid };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return { state: 'alive', pid };
      if (code === 'ESRCH') return { state: 'stale', pid };
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { state: 'no_lock', pid: null };
    throw error;
  }
}

export function renderExperimentRunStatus(status: ExperimentRunStatus): string {
  const owner = status.liveness;
  const lines = [
    `Experiment run: ${status.experiment_run_id}`,
    `Liveness: ${owner.state === 'alive' ? 'alive on this host' : owner.state === 'no_lock' ? 'no lock' : 'stale'}${owner.pid === null ? '' : ` (PID ${owner.pid})`}`,
    `Last event: ${status.last_event_at ?? 'unavailable'}`,
    `Selections: ${Object.entries(status.counts)
      .map(([state, count]) => `${state}=${count}`)
      .join(', ')}`,
    'In flight by agent model (checkpoint):',
    ...status.in_flight.map(
      ({ agent, run_ids }) =>
        `  ${JSON.stringify(agent)}: ${run_ids.length} ${JSON.stringify(run_ids)}`,
    ),
    ...(status.in_flight.length === 0 ? ['  none'] : []),
    'Failures (all attempts):',
    ...status.failures.map(
      ({ count, ...failure }) => `  ${count} ${JSON.stringify(failure)}`,
    ),
    ...(status.failures.length === 0 ? ['  none'] : []),
  ];
  return `${lines.join('\n')}\n`;
}
