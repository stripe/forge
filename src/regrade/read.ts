import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';

/** Bounds comparison reads, including a file that grows after it is opened. */
export const MAX_REGRADE_READ_BYTES = 16 * 1024 * 1024;

/** Allocation capacity shared across reads, including their growth probes. */
export interface RegradeReadBudget {
  remainingBytes: number;
}

export class RegradeReadError extends Error {
  constructor(
    readonly reason:
      | 'missing'
      | 'unreadable'
      | 'not_regular'
      | 'too_large'
      | 'budget_exceeded'
      | 'changed'
      | 'invalid_record'
      | 'unsupported_format'
      | 'invalid_judge',
  ) {
    super(`Saved regrade artifact is ${reason}.`);
    this.name = 'RegradeReadError';
  }
}

export async function readRegradeArtifact(
  file: string,
  budget?: RegradeReadBudget,
): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new RegradeReadError(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'missing'
        : 'unreadable',
    );
  }
  try {
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RegradeReadError('not_regular');
      if (stat.size > MAX_REGRADE_READ_BYTES)
        throw new RegradeReadError('too_large');
      const capacity = stat.size + 1;
      if (budget !== undefined) {
        if (capacity > budget.remainingBytes)
          throw new RegradeReadError('budget_exceeded');
        budget.remainingBytes -= capacity;
      }
      const buffer = Buffer.alloc(capacity);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) return buffer.subarray(0, length);
        length += bytesRead;
      }
      throw new RegradeReadError('changed');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RegradeReadError) throw error;
    throw new RegradeReadError('unreadable');
  }
}
