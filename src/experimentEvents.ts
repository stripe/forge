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
import { parseRunSelection } from './model/parse.ts';
import { serializeCanonicalJson } from './serialization.ts';

const MAX_EVENT_BYTES = 64 * 1024;
const envelope = {
  observed_at: z.string().datetime(),
  experiment_run_id: experimentRunIdSchema,
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
      diagnostic: experimentRunDiagnosticSchema.optional(),
      ...envelope,
    })
    .strict(),
]);

export type ExperimentRunEvent = z.infer<typeof eventSchema>;

export function parseExperimentRunEvent(value: unknown): ExperimentRunEvent {
  return eventSchema.parse(value);
}

/** Called under the experiment lock with the same safe payload sent to progress. */
export async function appendExperimentRunEvent(
  root: string,
  event: ExperimentRunProgressEvent,
  now: () => Date = () => new Date(),
): Promise<void> {
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
  const handle = await fs.open(
    path.join(root, 'events.jsonl'),
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Invalid experiment event log.');
    // Separate a partial write left by process death from the next event.
    const last = Buffer.alloc(1);
    if (stat.size > 0) {
      await handle.read(last, 0, 1, stat.size - 1);
      if (last[0] !== 10) await handle.writeFile('\n');
    }
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
}

/** Read a bounded tail without locking or changing a running experiment. */
export async function readLastExperimentRunEvent(
  root: string,
): Promise<ExperimentRunEvent | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      path.join(root, 'events.jsonl'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Invalid experiment event log.');
    const length = Math.min(stat.size, MAX_EVENT_BYTES * 2);
    const tail = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      tail,
      0,
      length,
      stat.size - length,
    );
    const bytes = tail.subarray(0, bytesRead);
    const end = bytes.lastIndexOf(10);
    if (end < 0) {
      if (stat.size > MAX_EVENT_BYTES)
        throw new Error('Experiment progress event exceeds its byte limit.');
      return undefined;
    }
    const start = bytes.lastIndexOf(10, end - 1) + 1;
    if (
      (start === 0 && stat.size > length) ||
      end - start + 1 > MAX_EVENT_BYTES
    )
      throw new Error('Experiment progress event exceeds its byte limit.');
    return parseExperimentRunEvent(
      JSON.parse(bytes.subarray(start, end).toString('utf8')),
    );
  } finally {
    await handle.close();
  }
}
