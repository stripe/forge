import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
  type ExperimentRunEventReadStatus,
  isFilesystemError,
  readExperimentRunEventStatus,
} from './experimentEvents.ts';
import {
  EXPERIMENT_LOCK_OWNER_NAME,
  type ExperimentRunAttempt,
  type ExperimentRunCheckpoint,
  experimentRunLockOwnerSchema,
  MAX_EXPERIMENT_LOCK_OWNER_BYTES,
  MAX_EXPERIMENT_RUN_BYTES,
  parseExperimentRunCheckpoint,
} from './experimentModel.ts';
import {
  EXPERIMENT_OBSERVATION_LIMITS,
  observeWithin,
} from './experimentObservation.ts';
import type { AgentSelectionV1 } from './model/types.ts';
import { serializeCanonicalJson } from './serialization.ts';

type FailedAttempt = Extract<ExperimentRunAttempt, { state: 'errored' }>;
type AgentModel = Pick<AgentSelectionV1, 'adapter' | 'provider' | 'model'>;

export type ExperimentRunLiveness =
  | {
      readonly state: 'alive' | 'stale' | 'no_lock';
      readonly pid: number | null;
    }
  | {
      readonly state: 'unknown';
      readonly pid: null;
      readonly reason:
        | 'invalid_lock'
        | 'io_error'
        | 'io_timeout'
        | 'probe_error'
        | 'observation_error';
    };

type EventLogObservation =
  | { readonly state: 'available'; readonly tail: 'complete' | 'interrupted' }
  | Extract<ExperimentRunEventReadStatus, { state: 'unavailable' }>;

class StatusFileError extends Error {
  constructor() {
    super('Invalid experiment status file.');
  }
}

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
  readonly event_log: EventLogObservation;
  readonly liveness: ExperimentRunLiveness;
}

/** Counts describe latest attempts; failure groups include the full retry history. */
export function summarizeExperimentRun(
  checkpoint: ExperimentRunCheckpoint,
  eventLog: ExperimentRunEventReadStatus,
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
    last_event_at:
      eventLog.state === 'available' ? eventLog.event.observed_at : null,
    event_log:
      eventLog.state === 'available'
        ? { state: 'available', tail: eventLog.tail }
        : { ...eventLog },
    liveness: { ...liveness },
  };
}

/** Independent observations, without a lock or any filesystem mutation. */
export async function readExperimentRunStatus(
  root: string,
): Promise<ExperimentRunStatus> {
  const loaded = await observeWithin(async (signal) => {
    try {
      return parseExperimentRunCheckpoint(
        JSON.parse(
          await readStatusFile(
            path.join(root, 'experiment.json'),
            MAX_EXPERIMENT_RUN_BYTES,
            signal,
          ),
        ),
      );
    } catch {
      throw new Error('Cannot read a compatible Forge experiment.json.');
    }
  }, EXPERIMENT_OBSERVATION_LIMITS.readMs);
  if (loaded.state === 'unavailable')
    throw new Error('Experiment checkpoint read timed out.');
  const checkpoint = loaded.value;
  if (checkpoint.experiment_run_id !== path.basename(path.resolve(root)))
    throw new Error('Experiment run ID does not match its directory.');
  const eventLog = await readExperimentRunEventStatus(root);
  const owner = await observeWithin(
    (readSignal) => readLiveness(root, readSignal),
    EXPERIMENT_OBSERVATION_LIMITS.readMs,
  );
  return summarizeExperimentRun(
    checkpoint,
    eventLog,
    owner.state === 'available'
      ? owner.value
      : { state: 'unknown', pid: null, reason: 'io_timeout' },
  );
}

async function readStatusFile(
  file: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal.throwIfAborted();
    const stat = await handle.stat();
    signal.throwIfAborted();
    if (!stat.isFile() || stat.size > maxBytes) throw new StatusFileError();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new StatusFileError();
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readLiveness(
  root: string,
  signal: AbortSignal,
): Promise<ExperimentRunLiveness> {
  const lock = path.join(root, '.experiment.lock');
  try {
    const stat = await fs.lstat(lock);
    signal.throwIfAborted();
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new StatusFileError();
    const directory = await fs.opendir(lock, { bufferSize: 2 });
    let name: string;
    try {
      signal.throwIfAborted();
      const first = await directory.read();
      signal.throwIfAborted();
      if (first === null) return { state: 'stale', pid: null };
      const second = await directory.read();
      signal.throwIfAborted();
      if (second !== null || !EXPERIMENT_LOCK_OWNER_NAME.test(first.name))
        throw new StatusFileError();
      name = first.name;
    } finally {
      await directory.close();
    }
    const { pid } = experimentRunLockOwnerSchema.parse(
      JSON.parse(
        await readStatusFile(
          path.join(lock, name),
          MAX_EXPERIMENT_LOCK_OWNER_BYTES,
          signal,
        ),
      ),
    );
    signal.throwIfAborted();
    try {
      process.kill(pid, 0);
      return { state: 'alive', pid };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return { state: 'alive', pid };
      if (code === 'ESRCH') return { state: 'stale', pid };
      return { state: 'unknown', pid: null, reason: 'probe_error' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { state: 'no_lock', pid: null };
    const reason = signal.aborted
      ? 'io_timeout'
      : error instanceof StatusFileError ||
          error instanceof z.ZodError ||
          error instanceof SyntaxError
        ? 'invalid_lock'
        : isFilesystemError(error)
          ? 'io_error'
          : 'observation_error';
    return { state: 'unknown', pid: null, reason };
  }
}

export function renderExperimentRunStatus(status: ExperimentRunStatus): string {
  const owner = status.liveness;
  const lines = [
    `Experiment run: ${status.experiment_run_id}`,
    `Liveness: ${owner.state === 'alive' ? 'alive on this host' : owner.state === 'no_lock' ? 'no lock' : owner.state}${owner.state === 'unknown' ? ` (${owner.reason})` : owner.pid === null ? '' : ` (PID ${owner.pid})`}`,
    `Last event: ${status.last_event_at ?? 'unavailable'}${status.event_log.state === 'unavailable' ? ` (${status.event_log.reason})` : status.event_log.tail === 'interrupted' ? ' (interrupted tail)' : ''}`,
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
