import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';

/** Bounds comparison reads, including a file that grows after it is opened. */
export const MAX_REGRADE_READ_BYTES = 16 * 1024 * 1024;

export class RegradeReadError extends Error {
  constructor(
    readonly reason:
      | 'missing'
      | 'unreadable'
      | 'not_regular'
      | 'too_large'
      | 'invalid_record'
      | 'unsupported_format'
      | 'invalid_judge',
  ) {
    super(`Saved regrade artifact is ${reason}.`);
    this.name = 'RegradeReadError';
  }
}

export async function readRegradeArtifact(file: string): Promise<Buffer> {
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
      const buffer = Buffer.alloc(MAX_REGRADE_READ_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) return Buffer.from(buffer.subarray(0, length));
        length += bytesRead;
        if (length > MAX_REGRADE_READ_BYTES)
          throw new RegradeReadError('too_large');
      }
      throw new RegradeReadError('too_large');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RegradeReadError) throw error;
    throw new RegradeReadError('unreadable');
  }
}
