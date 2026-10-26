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
import {
  readExperimentRunStatus,
  summarizeExperimentRun,
} from './experimentStatus.ts';
import { createTestResolvedRunPlan } from './testing/index.ts';
import { FORGE_BUILD_IDENTITY } from './version.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    const summary = summarizeExperimentRun(saved, null, noLock);
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
    await assert.rejects(readExperimentRunStatus(root), /another run/);
  });

  it('rejects symlinks, oversized checkpoints and malformed lock owners', async () => {
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
      /Invalid experiment status file/,
    );
    await fsPromises.rename(target, file);
    await lockOwner(lock, -1);
    await assert.rejects(readExperimentRunStatus(root));
    await fsPromises.unlink(path.join(lock, ownerName));
    await fsPromises.symlink(file, path.join(lock, ownerName));
    await assert.rejects(readExperimentRunStatus(root));
    await fsPromises.unlink(path.join(lock, ownerName));
    await fsPromises.writeFile(path.join(lock, 'unexpected.json'), '{}');
    await assert.rejects(
      readExperimentRunStatus(root),
      /Invalid experiment run lock owner/,
    );
  });
});
