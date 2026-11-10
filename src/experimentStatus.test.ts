import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { appendExperimentRunEvent } from './experimentEvents.ts';
import {
  type ExperimentRunAttempt,
  type ExperimentRunCheckpoint,
  MAX_EXPERIMENT_RUN_BYTES,
  parseExperimentRunCheckpoint,
} from './experimentModel.ts';
import { EXPERIMENT_OBSERVATION_LIMITS } from './experimentObservation.ts';
import {
  readExperimentRunStatus,
  summarizeExperimentRun,
} from './experimentStatus.ts';
import { createTestResolvedRunPlan } from './testing/index.ts';
import { FORGE_BUILD_IDENTITY } from './version.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  syncBuiltinESMExports();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fsPromises.rm(root, { recursive: true, force: true })),
  );
});

function checkpoint(
  histories: ExperimentRunAttempt[][],
): ExperimentRunCheckpoint {
  return parseExperimentRunCheckpoint({
    forge: FORGE_BUILD_IDENTITY,
    experiment_run_id: 'example',
    entries: histories.map((attempts, repetition) => ({
      selection: { ...createTestResolvedRunPlan().selection, repetition },
      plan_sha256: `sha256:${'a'.repeat(64)}`,
      attempts,
    })),
  });
}

async function fixture() {
  const parent = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'forge-status-'),
  );
  roots.push(parent);
  const root = path.join(parent, 'example');
  await fsPromises.mkdir(root);
  const file = path.join(root, 'experiment.json');
  await fsPromises.writeFile(file, JSON.stringify(checkpoint([[]])));
  return { root, file, lock: path.join(root, '.experiment.lock') };
}

const ownerName = 'owner-00000000-0000-0000-0000-000000000000.json';
async function lockOwner(lock: string, pid: number) {
  await fsPromises.mkdir(lock);
  await fsPromises.writeFile(
    path.join(lock, ownerName),
    JSON.stringify({ pid }),
  );
}

const noLock = { state: 'no_lock', pid: null } as const;
const diagnostic = {
  phase: 'interaction',
  reason: 'failure',
  message: 'Agent exited.',
} as const;
const failure = {
  run_id: 'failed',
  state: 'errored',
  error_code: 'agent_failed',
  diagnostic,
} as const;

describe('experiment status summary', () => {
  it('counts latest states, groups all failures by code and diagnostic, and keeps models distinct', () => {
    const saved = checkpoint([
      [],
      [failure, { state: 'running', run_id: 'retry' }],
      [{ state: 'running', run_id: 'other' }],
      [failure, { state: 'completed', run_id: 'done' }],
      [{ ...failure, run_id: 'legacy', diagnostic: undefined }],
      [
        {
          ...failure,
          run_id: 'timeout',
          diagnostic: { ...diagnostic, reason: 'timeout' },
        },
      ],
      [
        {
          ...failure,
          run_id: 'phase',
          diagnostic: { ...diagnostic, phase: 'setup' },
        },
      ],
      [
        {
          ...failure,
          run_id: 'message',
          diagnostic: { ...diagnostic, message: 'Different failure.' },
        },
      ],
      [{ ...failure, run_id: 'code', error_code: 'execution_error' }],
      [{ state: 'running', run_id: 'same-model' }],
      [{ state: 'running', run_id: 'other-provider' }],
      [{ state: 'running', run_id: 'other-adapter' }],
    ]);
    saved.entries[2]!.selection.agent.model = 'second-model';
    saved.entries[10]!.selection.agent.provider = 'second-provider';
    saved.entries[11]!.selection.agent.adapter = 'second-adapter';
    const before = structuredClone(saved);
    const summary = summarizeExperimentRun(
      saved,
      { state: 'unavailable', reason: 'missing' },
      noLock,
    );
    assert.deepEqual(summary.counts, {
      pending: 1,
      running: 5,
      completed: 1,
      errored: 5,
    });
    assert.deepEqual(summary.failures, [
      { error_code: 'agent_failed', diagnostic, count: 2 },
      { error_code: 'agent_failed', count: 1 },
      {
        error_code: 'agent_failed',
        diagnostic: { ...diagnostic, reason: 'timeout' },
        count: 1,
      },
      {
        error_code: 'agent_failed',
        diagnostic: { ...diagnostic, phase: 'setup' },
        count: 1,
      },
      {
        error_code: 'agent_failed',
        diagnostic: { ...diagnostic, message: 'Different failure.' },
        count: 1,
      },
      { error_code: 'execution_error', diagnostic, count: 1 },
    ]);
    const agent = saved.entries[0]!.selection.agent;
    const { adapter, provider, model } = agent;
    assert.deepEqual(summary.in_flight, [
      { agent: { adapter, provider, model }, run_ids: ['retry', 'same-model'] },
      {
        agent: { adapter, provider, model: 'second-model' },
        run_ids: ['other'],
      },
      {
        agent: { adapter, provider: 'second-provider', model },
        run_ids: ['other-provider'],
      },
      {
        agent: { adapter: 'second-adapter', provider, model },
        run_ids: ['other-adapter'],
      },
    ]);
    assert.deepEqual(saved, before);
    assert.equal(summary.last_event_at, null);
    assert.deepEqual(summary.event_log, {
      state: 'unavailable',
      reason: 'missing',
    });
    assert.deepEqual(summary.liveness, noLock);
  });

  it('reads old checkpoints without diagnostics or an event log', async () => {
    const { root, file } = await fixture();
    await fsPromises.writeFile(
      file,
      JSON.stringify(
        checkpoint([
          [{ state: 'errored', run_id: 'old', error_code: 'execution_error' }],
        ]),
      ),
    );
    const summary = await readExperimentRunStatus(root);
    assert.deepEqual(summary.failures, [
      { error_code: 'execution_error', count: 1 },
    ]);
    assert.equal(summary.last_event_at, null);
    assert.deepEqual(summary.event_log, {
      state: 'unavailable',
      reason: 'missing',
    });
    assert.deepEqual(summary.liveness, noLock);
  });

  it('reports a live owner and the last complete event without changing any files', async () => {
    const { root, lock } = await fixture();
    await lockOwner(lock, process.pid);
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      () => new Date('2026-01-02T03:04:05.678Z'),
    );
    await fsPromises.appendFile(
      path.join(root, 'events.jsonl'),
      '{"unfinished":',
    );
    const snapshot = async () => {
      const names = await fsPromises.readdir(root, { recursive: true });
      const files = await Promise.all(
        names.map(async (name) => {
          const file = path.join(root, name);
          return [
            name,
            (await fsPromises.lstat(file)).isFile()
              ? await fsPromises.readFile(file)
              : null,
          ];
        }),
      );
      return files;
    };
    const before = await snapshot();
    const summary = await readExperimentRunStatus(root);
    assert.deepEqual(summary.liveness, { state: 'alive', pid: process.pid });
    assert.equal(summary.last_event_at, '2026-01-02T03:04:05.678Z');
    assert.deepEqual(summary.event_log, {
      state: 'available',
      tail: 'interrupted',
    });
    assert.deepEqual(await snapshot(), before);
  });

  it('observes dead and inaccessible PIDs without reclaiming the lock', async () => {
    const { root, lock } = await fixture();
    await lockOwner(lock, 12345);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'stale',
      pid: 12345,
    });
    assert.deepEqual(probe.mock.calls, [[12345, 0]]);
    probe.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'alive',
      pid: 12345,
    });
    assert.deepEqual(await fsPromises.readdir(lock), [ownerName]);
  });

  it('tolerates an empty lock and an owner removed during release', async () => {
    const { root, lock } = await fixture();
    await fsPromises.mkdir(lock);
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'stale',
      pid: null,
    });
    await fsPromises.writeFile(
      path.join(lock, ownerName),
      JSON.stringify({ pid: process.pid }),
    );
    const open = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === path.join(lock, ownerName))
        await fsPromises.unlink(args[0]);
      return open(...args);
    });
    syncBuiltinESMExports();
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, noLock);
  });

  it('reads a complete checkpoint when the writer replaces it during the read', async () => {
    const { root, file } = await fixture();
    const replacement = `${file}.tmp`;
    await fsPromises.writeFile(
      replacement,
      JSON.stringify(checkpoint([[{ state: 'running', run_id: 'new' }]])),
    );
    const open = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === file) await fsPromises.rename(replacement, file);
      return handle;
    });
    syncBuiltinESMExports();
    assert.equal((await readExperimentRunStatus(root)).counts.pending, 1);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    assert.equal((await readExperimentRunStatus(root)).counts.running, 1);
  });

  it('rejects invalid checkpoints and mismatched run identities', async () => {
    const { root, file } = await fixture();
    const saved = checkpoint([[]]);
    await fsPromises.writeFile(
      file,
      JSON.stringify({ ...saved, experiment_run_id: 'another' }),
    );
    await assert.rejects(readExperimentRunStatus(root), /ID does not match/);
    await fsPromises.writeFile(
      file,
      JSON.stringify({ ...saved, unknown: true }),
    );
    await assert.rejects(readExperimentRunStatus(root));
    await fsPromises.writeFile(file, JSON.stringify(saved));
    await fsPromises.writeFile(
      path.join(root, 'events.jsonl'),
      `${JSON.stringify({
        state: 'started',
        location: root,
        experiment_run_id: 'another',
        observed_at: '2026-01-02T03:04:05.678Z',
      })}\n`,
    );
    const status = await readExperimentRunStatus(root);
    assert.deepEqual(status.event_log, {
      state: 'unavailable',
      reason: 'identity_mismatch',
    });
    assert.equal(status.last_event_at, null);
    assert.equal(status.counts.pending, 1);
  });

  it('rejects unsafe checkpoints but reports malformed lock owners as unknown', async () => {
    const { root, file, lock } = await fixture();
    const target = path.join(root, 'target');
    await fsPromises.rename(file, target);
    await fsPromises.symlink(target, file);
    await assert.rejects(readExperimentRunStatus(root));
    await fsPromises.unlink(file);
    await fsPromises.writeFile(file, '');
    await fsPromises.truncate(file, MAX_EXPERIMENT_RUN_BYTES + 1);
    await assert.rejects(
      readExperimentRunStatus(root),
      /Cannot read a compatible Forge experiment.json/,
    );
    await fsPromises.rename(target, file);
    await lockOwner(lock, -1);
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'unknown',
      pid: null,
      reason: 'invalid_lock',
    });
    await fsPromises.unlink(path.join(lock, ownerName));
    await fsPromises.symlink(file, path.join(lock, ownerName));
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'unknown',
      pid: null,
      reason: 'io_error',
    });
    await fsPromises.unlink(path.join(lock, ownerName));
    await fsPromises.writeFile(path.join(lock, 'unexpected.json'), '{}');
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'unknown',
      pid: null,
      reason: 'invalid_lock',
    });
  });
  it.each([
    ['{"unfinished":', 'interrupted'],
    ['not json\n', 'interrupted'],
    [
      `${JSON.stringify({
        state: 'future_state',
        observed_at: '2026-01-02T03:04:05.678Z',
        experiment_run_id: 'example',
      })}\n`,
      'invalid_record',
    ],
  ] as const)(
    'keeps counts when the event log is unavailable (%s)',
    async (body, reason) => {
      const { root } = await fixture();
      await fsPromises.writeFile(path.join(root, 'events.jsonl'), body);
      const status = await readExperimentRunStatus(root);
      assert.deepEqual(status.event_log, { state: 'unavailable', reason });
      assert.equal(status.last_event_at, null);
      assert.equal(status.counts.pending, 1);
      assert.deepEqual(status.liveness, noLock);
      assert.equal(
        await fsPromises.readFile(path.join(root, 'events.jsonl'), 'utf8'),
        body,
      );
    },
  );

  it('keeps counts and liveness when the event log cannot be opened', async () => {
    const { root, lock } = await fixture();
    await lockOwner(lock, process.pid);
    const open = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === path.join(root, 'events.jsonl'))
        throw Object.assign(new Error('private detail'), { code: 'EACCES' });
      return open(...args);
    });
    syncBuiltinESMExports();
    const status = await readExperimentRunStatus(root);
    assert.deepEqual(status.event_log, {
      state: 'unavailable',
      reason: 'io_error',
    });
    assert.equal(status.last_event_at, null);
    assert.equal(status.counts.pending, 1);
    assert.deepEqual(status.liveness, { state: 'alive', pid: process.pid });
    assert.ok(!JSON.stringify(status).includes('private detail'));
  });

  it('rejects out-of-range owner PIDs before probing a process', async () => {
    const { root, lock } = await fixture();
    await lockOwner(lock, 2_147_483_648);
    const probe = vi.spyOn(process, 'kill');
    assert.deepEqual((await readExperimentRunStatus(root)).liveness, {
      state: 'unknown',
      pid: null,
      reason: 'invalid_lock',
    });
    assert.equal(probe.mock.calls.length, 0);
  });

  it('bounds lock directory enumeration and rejects multiple owners as unknown', async () => {
    const { root, lock } = await fixture();
    await lockOwner(lock, process.pid);
    await fsPromises.writeFile(path.join(lock, 'extra-a'), '{}');
    await fsPromises.writeFile(path.join(lock, 'extra-b'), '{}');
    const opendir = fsPromises.opendir;
    let reads = 0;
    vi.spyOn(fsPromises, 'opendir').mockImplementation(async (...args) => {
      assert.deepEqual(args[1], { bufferSize: 2 });
      const directory = await opendir(...args);
      const read = directory.read.bind(directory);
      vi.spyOn(directory, 'read').mockImplementation(async () => {
        reads += 1;
        return read();
      });
      return directory;
    });
    syncBuiltinESMExports();
    const status = await readExperimentRunStatus(root);
    assert.deepEqual(status.liveness, {
      state: 'unknown',
      pid: null,
      reason: 'invalid_lock',
    });
    assert.equal(reads, 2);
  });

  it('keeps counts when lock access fails without leaking the error', async () => {
    const { root, lock } = await fixture();
    const lstat = fsPromises.lstat;
    vi.spyOn(fsPromises, 'lstat').mockImplementation(async (...args) => {
      if (args[0] === lock)
        throw Object.assign(new Error('private lock detail'), {
          code: 'EACCES',
        });
      return lstat(...args);
    });
    syncBuiltinESMExports();
    const status = await readExperimentRunStatus(root);
    assert.deepEqual(status.liveness, {
      state: 'unknown',
      pid: null,
      reason: 'io_error',
    });
    assert.equal(status.counts.pending, 1);
    assert.ok(!JSON.stringify(status).includes('private lock detail'));
  });

  it('allocates checkpoint and owner reads from their file sizes', async () => {
    const { root, file, lock } = await fixture();
    await lockOwner(lock, process.pid);
    const checkpointBytes = (await fsPromises.stat(file)).size;
    const ownerBytes = (await fsPromises.stat(path.join(lock, ownerName))).size;
    const allocations = vi.spyOn(Buffer, 'alloc');
    await readExperimentRunStatus(root);
    assert.deepEqual(
      allocations.mock.calls.map(([size]) => size),
      [checkpointBytes + 1, ownerBytes + 1],
    );
  });

  it('rejects a checkpoint that grows after stat instead of parsing a truncated prefix', async () => {
    const { root, file } = await fixture();
    const open = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === file) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation(async () => {
          const before = await stat();
          await fsPromises.appendFile(file, ' \n');
          return before;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(
      readExperimentRunStatus(root),
      /Cannot read a compatible/,
    );
  });

  it('reports a failed PID probe as unknown', async () => {
    const { root, lock } = await fixture();
    await lockOwner(lock, process.pid);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('private probe detail');
    });
    const status = await readExperimentRunStatus(root);
    assert.deepEqual(status.liveness, {
      state: 'unknown',
      pid: null,
      reason: 'probe_error',
    });
    assert.equal(status.counts.pending, 1);
  });

  it.each(['events.jsonl', '.experiment.lock', 'experiment.json'])(
    'bounds stalled %s reads',
    async (name) => {
      const { root } = await fixture();
      vi.useFakeTimers();
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const stalled = () => {
        entered();
        return new Promise<never>(() => {});
      };
      if (name === '.experiment.lock') {
        const lstat = fsPromises.lstat;
        vi.spyOn(fsPromises, 'lstat').mockImplementation((...args) =>
          args[0] === path.join(root, name) ? stalled() : lstat(...args),
        );
      } else {
        const open = fsPromises.open;
        vi.spyOn(fsPromises, 'open').mockImplementation((...args) =>
          args[0] === path.join(root, name) ? stalled() : open(...args),
        );
      }
      syncBuiltinESMExports();
      const reading = readExperimentRunStatus(root);
      const checked =
        name === 'experiment.json'
          ? assert.rejects(reading, /checkpoint read timed out/)
          : reading;
      await reached;
      await vi.advanceTimersByTimeAsync(EXPERIMENT_OBSERVATION_LIMITS.readMs);
      if (name === 'experiment.json') await checked;
      else {
        const status = await reading;
        assert.equal(status.counts.pending, 1);
        if (name === 'events.jsonl')
          assert.deepEqual(status.event_log, {
            state: 'unavailable',
            reason: 'io_timeout',
          });
        else
          assert.deepEqual(status.liveness, {
            state: 'unknown',
            pid: null,
            reason: 'io_timeout',
          });
      }
    },
  );
});
