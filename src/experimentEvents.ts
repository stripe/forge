import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { ExperimentRunProgressEvent } from './experiment.ts';
import {
  experimentRunDiagnosticSchema,
  experimentRunErrorCodeSchema,
  experimentRunIdSchema,
} from './experimentModel.ts';
import {
  EXPERIMENT_OBSERVATION_LIMITS,
  observeWithin,
} from './experimentObservation.ts';
import { BenchmarkModelError } from './model/errors.ts';
import { parseRunSelection } from './model/parse.ts';
import { serializeCanonicalJson } from './serialization.ts';

const MAX_EVENT_BYTES = EXPERIMENT_OBSERVATION_LIMITS.eventBytes;
export const experimentLogGapSchema = z
  .object({
    state: z.literal('unavailable'),
    reason: z.enum([
      'io_error',
      'io_timeout',
      'buffer_full',
      'recording_error',
    ]),
    affected_events: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ExperimentLogGap = z.infer<typeof experimentLogGapSchema>;

export class ExperimentEventLogIoError extends Error {
  constructor(readonly retryable = true) {
    super('Experiment event log is unavailable.');
  }
}

const permanentFilesystemErrors = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ELOOP',
  'EISDIR',
  'ENOTDIR',
]);

function classifyFilesystemError(error: unknown): ExperimentEventLogIoError {
  const code = (error as NodeJS.ErrnoException).code;
  return new ExperimentEventLogIoError(
    !permanentFilesystemErrors.has(code ?? ''),
  );
}

export function isFilesystemError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z0-9]+$/.test(error.code)
  );
}
const envelope = {
  observed_at: z.string().datetime(),
  experiment_run_id: experimentRunIdSchema,
  recording_gap: experimentLogGapSchema.optional(),
};
const selection = z.unknown().transform(parseRunSelection);
const eventSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('started'),
      location: z.string().min(1),
      ...envelope,
    })
    .strict(),
  z
    .object({
      state: z.literal('resumed'),
      location: z.string().min(1),
      ...envelope,
    })
    .strict(),
  ...(['running', 'completed', 'skipped'] as const).map((state) =>
    z
      .object({
        state: z.literal(state),
        selection,
        run_id: experimentRunIdSchema,
        ...envelope,
      })
      .strict(),
  ),
  z
    .object({
      state: z.literal('errored'),
      selection,
      run_id: experimentRunIdSchema,
      error_code: experimentRunErrorCodeSchema,
      error_phase: experimentRunDiagnosticSchema.shape.phase.optional(),
      diagnostic: experimentRunDiagnosticSchema.optional(),
      ...envelope,
    })
    .strict(),
]);

export type ExperimentRunEvent = z.infer<typeof eventSchema>;

export function parseExperimentRunEvent(value: unknown): ExperimentRunEvent {
  return eventSchema.parse(value);
}

/** Validate programmer-owned progress before scheduling any optional I/O. */
export function serializeExperimentRunEvent(
  root: string,
  event: ExperimentRunProgressEvent,
  now: () => Date = () => new Date(),
): string {
  const body = serializeCanonicalJson(
    parseExperimentRunEvent({
      ...event,
      experiment_run_id: path.basename(root),
      state: event.state === 'resuming' ? 'resumed' : event.state,
      observed_at: now().toISOString(),
    }),
  );
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES)
    throw new Error('Experiment progress event exceeds its byte limit.');
  return body;
}

export async function appendExperimentRunEvent(
  root: string,
  event: ExperimentRunProgressEvent,
  now: () => Date = () => new Date(),
): Promise<void> {
  await appendExperimentRunEventBody(
    root,
    serializeExperimentRunEvent(root, event, now),
  );
}

/** One writer per controller; cancellation prevents issuing subsequent writes. */
export async function appendExperimentRunEventBody(
  root: string,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  let handle: fs.FileHandle | undefined;
  let primaryFailed = false;
  try {
    signal?.throwIfAborted();
    handle = await fs.open(
      path.join(root, 'events.jsonl'),
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    signal?.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ExperimentEventLogIoError(false);
    const last = Buffer.alloc(1);
    if (stat.size > 0) await handle.read(last, 0, 1, stat.size - 1);
    signal?.throwIfAborted();
    const record = Buffer.from(
      (stat.size > 0 && last[0] !== 10 ? '\n' : '') + body,
    );
    const { bytesWritten } = await handle.write(record);
    if (bytesWritten !== record.byteLength)
      throw new ExperimentEventLogIoError();
  } catch (error) {
    primaryFailed = true;
    if (isFilesystemError(error)) throw classifyFilesystemError(error);
    throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch((error: unknown) => {
        if (primaryFailed) return;
        if (isFilesystemError(error)) throw classifyFilesystemError(error);
        throw error;
      });
    }
  }
}

export type ExperimentRunEventReadStatus =
  | {
      readonly state: 'available';
      readonly event: ExperimentRunEvent;
      readonly tail: 'complete' | 'interrupted';
    }
  | {
      readonly state: 'unavailable';
      readonly reason:
        | 'missing'
        | 'empty'
        | 'interrupted'
        | 'invalid_record'
        | 'oversized_record'
        | 'io_error'
        | 'io_timeout'
        | 'unsafe_file'
        | 'identity_mismatch';
    };

/** Compatibility reader: unavailable telemetry is not an experiment failure. */
export async function readLastExperimentRunEvent(
  root: string,
): Promise<ExperimentRunEvent | undefined> {
  const status = await readExperimentRunEventStatus(root);
  return status.state === 'available' ? status.event : undefined;
}

/** Read-only command support with explicit, bounded unavailability reasons. */
export async function readExperimentRunEventStatus(
  root: string,
): Promise<ExperimentRunEventReadStatus> {
  root = path.resolve(root);
  const result = await observeWithin(
    (signal) => readEventTail(root, signal),
    EXPERIMENT_OBSERVATION_LIMITS.readMs,
  );
  if (result.state === 'unavailable')
    return { state: 'unavailable', reason: 'io_timeout' };
  if (
    result.value.state === 'available' &&
    result.value.event.experiment_run_id !== path.basename(root)
  )
    return { state: 'unavailable', reason: 'identity_mismatch' };
  return result.value;
}

async function readEventTail(
  root: string,
  signal: AbortSignal,
): Promise<ExperimentRunEventReadStatus> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      path.join(root, 'events.jsonl'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    signal.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'unavailable', reason: 'unsafe_file' };
    if (stat.size === 0) return { state: 'unavailable', reason: 'empty' };
    const length = Math.min(stat.size, MAX_EVENT_BYTES * 2);
    const tail = Buffer.alloc(length);
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      tail,
      0,
      length,
      stat.size - length,
    );
    return parseEventTail(tail.subarray(0, bytesRead), stat.size > length);
  } catch (error) {
    if (isFilesystemError(error))
      return {
        state: 'unavailable',
        reason:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'missing'
            : 'io_error',
      };
    if (signal.aborted) return { state: 'unavailable', reason: 'io_timeout' };
    throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch((error: unknown) => {
        if (!isFilesystemError(error)) throw error;
      });
    }
  }
}

function parseEventTail(
  bytes: Buffer,
  clipped: boolean,
): ExperimentRunEventReadStatus {
  let end = bytes.lastIndexOf(10);
  let interrupted = end !== bytes.byteLength - 1;
  if (end < 0 && bytes.byteLength > MAX_EVENT_BYTES)
    return { state: 'unavailable', reason: 'oversized_record' };
  while (end >= 0) {
    const start = end === 0 ? 0 : bytes.lastIndexOf(10, end - 1) + 1;
    if ((start === 0 && clipped) || end - start + 1 > MAX_EVENT_BYTES)
      return { state: 'unavailable', reason: 'oversized_record' };
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(start, end).toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      interrupted = true;
      end = start - 1;
      continue;
    }
    try {
      return {
        state: 'available',
        event: parseExperimentRunEvent(value),
        tail: interrupted ? 'interrupted' : 'complete',
      };
    } catch (error) {
      if (
        !(error instanceof z.ZodError) &&
        !(
          error instanceof BenchmarkModelError &&
          error.code === 'invalid_experiment_config'
        )
      )
        throw error;
      return { state: 'unavailable', reason: 'invalid_record' };
    }
  }
  return { state: 'unavailable', reason: 'interrupted' };
}
