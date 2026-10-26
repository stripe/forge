import assert from 'node:assert/strict';
import fsPromises, * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import {
  appendExperimentRunEvent,
  appendExperimentRunEventBody,
  ExperimentEventLogIoError,
  parseExperimentRunEvent,
  readExperimentRunEventStatus,
  readLastExperimentRunEvent,
  readRecentExperimentRunEvents,
} from './experimentEvents.ts';
import { EXPERIMENT_OBSERVATION_LIMITS } from './experimentObservation.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-events-'));
  roots.push(root);
  return { root, file: path.join(root, 'events.jsonl') };
}
const now = () => new Date('2026-01-02T03:04:05.678Z');

describe('experiment progress log', () => {
  it('writes canonical timestamped records and keeps the progress payload unchanged', async () => {
    const { root, file } = await fixture();
    const event = { state: 'resuming', location: '/example' } as const;
    await appendExperimentRunEvent(root, event, now);
    assert.equal(
      await fs.readFile(file, 'utf8'),
      `{"experiment_run_id":"${path.basename(root)}","location":"/example","observed_at":"2026-01-02T03:04:05.678Z","state":"resumed"}\n`,
    );
    assert.equal(event.state, 'resuming');
    assert.deepEqual(await readLastExperimentRunEvent(root), {
      experiment_run_id: path.basename(root),
      state: 'resumed',
      location: '/example',
      observed_at: now().toISOString(),
    });
    if (process.platform !== 'win32')
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  it('reads old folders and an incomplete final write without changing any bytes', async () => {
    const { root, file } = await fixture();
    assert.equal(await readLastExperimentRunEvent(root), undefined);
    await fs.writeFile(file, '');
    assert.equal(await readLastExperimentRunEvent(root), undefined);
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    const event = await readLastExperimentRunEvent(root);
    await fs.appendFile(file, '{"state":');
    const before = await fs.readFile(file);
    assert.deepEqual(await readLastExperimentRunEvent(root), event);
    assert.deepEqual(await fs.readFile(file), before);
    await appendExperimentRunEvent(
      root,
      { state: 'resuming', location: root },
      now,
    );
    assert.equal((await readLastExperimentRunEvent(root))!.state, 'resumed');
    assert.ok(
      (await fs.readFile(file)).subarray(0, before.length).equals(before),
    );
  });

  it('recovers the last good event from torn, blank, and newline-terminated fragments', async () => {
    const { root, file } = await fixture();
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    const good = await fs.readFile(file);
    for (const suffix of [
      '{"state":',
      '{"state":\n',
      '\n',
      '{"state":\npartial',
    ]) {
      await fs.writeFile(file, Buffer.concat([good, Buffer.from(suffix)]));
      const before = await fs.readFile(file);
      const status = await readExperimentRunEventStatus(root);
      assert.equal(status.state, 'available');
      if (status.state === 'available') {
        assert.equal(status.event.state, 'started');
        assert.equal(status.tail, 'interrupted');
      }
      assert.deepEqual(await fs.readFile(file), before);
    }
    await fs.writeFile(file, '\n');
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'interrupted',
    });
  });

  it('writes the separator and body in one syscall and detects a short write', async () => {
    const { root } = await fixture();
    const write = vi.fn(async (body: Buffer) => ({
      bytesWritten: body.byteLength,
    }));
    const handle = {
      stat: async () => ({ size: 1, isFile: () => true }),
      read: async (body: Buffer) => {
        body[0] = 123;
        return { bytesRead: 1 };
      },
      write,
      close: async () => undefined,
    };
    vi.spyOn(fsPromises, 'open').mockResolvedValue(
      handle as unknown as fs.FileHandle,
    );
    syncBuiltinESMExports();
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    assert.equal(write.mock.calls.length, 1);
    const record = write.mock.calls[0]![0].toString('utf8');
    assert.ok(record.startsWith('\n{'));
    assert.equal(JSON.parse(record.slice(1)).state, 'started');
    write.mockResolvedValueOnce({ bytesWritten: 1 });
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
      ExperimentEventLogIoError,
    );
  });

  it('does not attribute a readable event from another experiment to this folder', async () => {
    const { root, file } = await fixture();
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    const event = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(
      file,
      `${JSON.stringify({ ...event, experiment_run_id: 'other-experiment' })}\n`,
    );
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'identity_mismatch',
    });
    assert.equal(await readLastExperimentRunEvent(root), undefined);
  });

  it('closes a late open without writing after the controller cancels observation', async () => {
    const { root } = await fixture();
    let opened!: (handle: fs.FileHandle) => void;
    const write = vi.fn();
    const close = vi.fn(async () => undefined);
    vi.spyOn(fsPromises, 'open').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    syncBuiltinESMExports();
    const controller = new AbortController();
    const appending = appendExperimentRunEventBody(
      root,
      '{}\n',
      controller.signal,
    );
    const rejected = assert.rejects(appending, { name: 'AbortError' });
    controller.abort();
    opened({ write, close } as unknown as fs.FileHandle);
    await rejected;
    assert.equal(write.mock.calls.length, 0);
    assert.equal(close.mock.calls.length, 1);
  });

  it('degrades missing, empty, invalid, unreadable, and stalled logs to distinct states', async () => {
    const { root, file } = await fixture();
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'missing',
    });
    await fs.writeFile(file, '');
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'empty',
    });
    await fs.writeFile(file, '{"state":"new-format"}\n');
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'invalid_record',
    });
    vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(
      Object.assign(new Error('private path'), { code: 'EACCES' }),
    );
    syncBuiltinESMExports();
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'io_error',
    });
    vi.useFakeTimers();
    vi.spyOn(fsPromises, 'open').mockImplementationOnce(
      () => new Promise(() => {}),
    );
    syncBuiltinESMExports();
    const status = readExperimentRunEventStatus(root);
    await vi.advanceTimersByTimeAsync(EXPERIMENT_OBSERVATION_LIMITS.readMs);
    assert.deepEqual(await status, {
      state: 'unavailable',
      reason: 'io_timeout',
    });
  });

  it('degrades a malformed selection in a saved record to unavailable', async () => {
    const { root, file } = await fixture();
    await fs.writeFile(
      file,
      `${JSON.stringify({
        state: 'running',
        selection: { unexpected: true },
        run_id: 'example',
        experiment_run_id: path.basename(root),
        observed_at: now().toISOString(),
      })}\n`,
    );
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'invalid_record',
    });
    assert.equal(await readLastExperimentRunEvent(root), undefined);
  });

  it('bounds the tail read even when the full log is large', async () => {
    const { root, file } = await fixture();
    await fs.writeFile(file, 'ignored historical record\n'.repeat(10_000));
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    assert.equal(
      (await readLastExperimentRunEvent(root))!.observed_at,
      now().toISOString(),
    );
    await fs.writeFile(file, 'x'.repeat(70_000));
    assert.deepEqual(await readExperimentRunEventStatus(root), {
      state: 'unavailable',
      reason: 'oversized_record',
    });
    assert.equal(await readLastExperimentRunEvent(root), undefined);
    await assert.rejects(
      appendExperimentRunEvent(
        root,
        { state: 'started', location: 'x'.repeat(70_000) },
        now,
      ),
      /byte limit/,
    );
  });

  it('rejects unknown fields, invalid times, and malformed complete records', async () => {
    const event = {
      experiment_run_id: 'example',
      state: 'started',
      location: '/example',
      observed_at: now().toISOString(),
    };
    assert.throws(() => parseExperimentRunEvent({ ...event, extra: true }));
    assert.throws(() =>
      parseExperimentRunEvent({ ...event, observed_at: 'yesterday' }),
    );
    assert.throws(() =>
      parseExperimentRunEvent({ ...event, observed_at: undefined }),
    );
    const { root, file } = await fixture();
    await fs.writeFile(file, '{}\n');
    assert.equal(await readLastExperimentRunEvent(root), undefined);
  });

  it('propagates Node argument errors instead of classifying them as disk failures', async () => {
    const { root } = await fixture();
    const bug = Object.assign(new TypeError('Invalid argument'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
    vi.spyOn(fsPromises, 'open').mockRejectedValue(bug);
    syncBuiltinESMExports();
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
      (error) => error === bug,
    );
    await assert.rejects(
      readExperimentRunEventStatus(root),
      (error) => error === bug,
    );
  });

  it('classifies permanent filesystem failures without exposing host error detail', async () => {
    const { root } = await fixture();
    vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(
      Object.assign(new Error('private path'), { code: 'EACCES' }),
    );
    syncBuiltinESMExports();
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
      {
        message: 'Experiment event log is unavailable.',
        retryable: false,
      },
    );
  });

  it('rejects symlinks and directories without modifying their targets', async () => {
    const { root, file } = await fixture();
    const target = path.join(root, 'target');
    await fs.writeFile(target, 'untouched');
    await fs.symlink(target, file);
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
    );
    assert.equal(await readLastExperimentRunEvent(root), undefined);
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
    await fs.unlink(file);
    await fs.mkdir(file);
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
    );
    assert.equal(await readLastExperimentRunEvent(root), undefined);
  });
});

it('reads a bounded complete event window without consuming the unfinished tail', async () => {
  const { root, file } = await fixture();
  const body = `${JSON.stringify({
    state: 'started',
    location: 'x'.repeat(1000),
    observed_at: now().toISOString(),
    experiment_run_id: path.basename(root),
  })}\n`;
  await fs.writeFile(file, body.repeat(9000));
  await fs.appendFile(file, '{"state":');
  const before = (await fs.stat(file)).size;
  const recent = await readRecentExperimentRunEvents(root);
  assert.equal(recent.state, 'unavailable');
  assert.equal(
    recent.state === 'unavailable' ? recent.reason : undefined,
    'interrupted',
  );
  assert.equal(recent.truncated, true);
  assert.ok(recent.events.length > 0 && recent.events.length < 9000);
  assert.ok(recent.events.every((event) => event.state === 'started'));
  assert.equal((await fs.stat(file)).size, before);
});

it('keeps a recovered log usable while marking malformed historical records', async () => {
  const { root, file } = await fixture();
  await fs.writeFile(file, '{"state":');
  await appendExperimentRunEvent(
    root,
    { state: 'resuming', location: root },
    now,
  );
  const recent = await readRecentExperimentRunEvents(root);
  assert.equal(recent.state, 'unavailable');
  assert.equal(
    recent.state === 'unavailable' ? recent.reason : undefined,
    'invalid_record',
  );
  assert.equal(recent.invalid_records, 1);
  assert.equal(recent.events[0]!.state, 'resumed');
  assert.equal(recent.truncated, false);
});
