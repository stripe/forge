import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { beforeEach, describe, it, vi } from 'vitest';
import {
  MAX_REGRADE_READ_BYTES,
  RegradeReadError,
  readRegradeArtifact,
} from './read.ts';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  open: vi.fn(),
}));

function savedFile(size: number, body: string) {
  let position = 0;
  const bytes = Buffer.from(body);
  const handle = {
    stat: vi.fn(async () => ({ size, isFile: () => true })),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const count = bytes.copy(buffer, offset, position, position + length);
      position += count;
      return { bytesRead: count, buffer };
    }),
    close: vi.fn(async () => {}),
  };
  vi.mocked(fs.open).mockResolvedValue(handle as unknown as fs.FileHandle);
  return handle;
}

beforeEach(() => vi.mocked(fs.open).mockReset());

describe('bounded saved-artifact reading', () => {
  it('sizes a small read from the file size with one byte for growth', async () => {
    const handle = savedFile(3, 'abc');
    assert.equal((await readRegradeArtifact('saved.json')).toString(), 'abc');
    assert.equal(handle.read.mock.calls[0]![0].byteLength, 4);
    assert.equal(handle.read.mock.calls[0]![2], 4);
    assert.equal(handle.close.mock.calls.length, 1);
  });

  it('rejects a file beyond the per-file cap before reading', async () => {
    const handle = savedFile(MAX_REGRADE_READ_BYTES + 1, '');
    const budget = { remainingBytes: 2 * MAX_REGRADE_READ_BYTES };
    const allocations = vi.spyOn(Buffer, 'alloc');
    await assert.rejects(
      readRegradeArtifact('large.json', budget),
      (error) =>
        error instanceof RegradeReadError && error.reason === 'too_large',
    );
    assert.equal(handle.read.mock.calls.length, 0);
    assert.equal(budget.remainingBytes, 2 * MAX_REGRADE_READ_BYTES);
    assert.equal(allocations.mock.calls.length, 0);
    assert.equal(handle.close.mock.calls.length, 1);
  });

  it('reserves shared capacity including the probe before reading the next file', async () => {
    const budget = { remainingBytes: 9 };
    savedFile(3, 'abc');
    assert.equal(
      (await readRegradeArtifact('first.json', budget)).toString(),
      'abc',
    );
    assert.equal(budget.remainingBytes, 5);
    const next = savedFile(5, 'abcde');
    const allocations = vi.spyOn(Buffer, 'alloc');
    await assert.rejects(
      readRegradeArtifact('next.json', budget),
      (error) =>
        error instanceof RegradeReadError && error.reason === 'budget_exceeded',
    );
    assert.equal(next.read.mock.calls.length, 0);
    assert.equal(allocations.mock.calls.length, 0);
    assert.equal(budget.remainingBytes, 5);
    assert.equal(next.close.mock.calls.length, 1);
  });

  it('bounds growth to one probe and keeps failed-read capacity charged', async () => {
    const handle = savedFile(2, 'abcd');
    const budget = { remainingBytes: 3 };
    await assert.rejects(
      readRegradeArtifact('growing.json', budget),
      (error) =>
        error instanceof RegradeReadError && error.reason === 'changed',
    );
    assert.equal(handle.read.mock.calls.length, 1);
    assert.equal(handle.read.mock.calls[0]![0].byteLength, 3);
    assert.equal(handle.read.mock.calls[0]![2], 3);
    assert.equal(budget.remainingBytes, 0);
    assert.equal(handle.close.mock.calls.length, 1);
  });
});
