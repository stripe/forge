import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { createAttemptDiagnosticsStore } from './localStore.ts';
import {
  attemptDiagnosticsIdentity,
  parseAttemptDiagnostics,
  reservedAttemptDiagnostics,
  serializeAttemptDiagnostics,
} from './model.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-diagnostics-'));
  roots.push(root);
  const identity = attemptDiagnosticsIdentity(
    'attempt-1',
    createTestResolvedRunPlan(),
    'experiment-1',
  );
  const snapshot = reservedAttemptDiagnostics(
    identity,
    '2026-01-01T00:00:00.000Z',
  );
  const signal = new AbortController().signal;
  return {
    root,
    identity,
    snapshot,
    signal,
    store: createAttemptDiagnosticsStore({ root }),
  };
}

describe('attempt diagnostics store', () => {
  it('serializes concurrent snapshots across store instances and makes terminal writes idempotent', async () => {
    const f = await fixture();
    await fs.symlink(f.root, path.join(f.root, 'alias'));
    const second = createAttemptDiagnosticsStore({
      root: path.join(f.root, 'alias'),
    });
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? f.store : second).write(
          {
            ...f.snapshot,
            state: 'running',
            timing: {
              ...f.snapshot.timing,
              started_at: '2026-01-01T00:00:01.000Z',
            },
            location: { phase: index === 19 ? 'interaction' : 'setup' },
          },
          f.signal,
        ),
      ),
    );
    assert.deepEqual(
      records.map(({ revision }) => revision).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    await second.write(
      {
        ...f.snapshot,
        state: 'running',
        timing: {
          ...f.snapshot.timing,
          started_at: '2026-01-01T00:00:01.000Z',
        },
        location: { phase: 'interaction' },
      },
      f.signal,
    );
    assert.equal(
      (await f.store.read(f.identity, f.signal))!.location!.phase,
      'interaction',
    );
    const terminal = {
      ...f.snapshot,
      state: 'completed' as const,
      timing: {
        ...f.snapshot.timing,
        started_at: '2026-01-01T00:00:01.000Z',
        finished_at: '2026-01-01T00:00:02.000Z',
        finished_elapsed_ms: 1000,
      },
    };
    const committed = await f.store.write(terminal, f.signal);
    const bytes = await fs.readFile(
      path.join(f.root, 'diagnostics', 'attempt-1', 'attempt.json'),
    );
    assert.equal(
      (await second.write(terminal, f.signal)).revision,
      committed.revision,
    );
    assert.deepEqual(
      await fs.readFile(
        path.join(f.root, 'diagnostics', 'attempt-1', 'attempt.json'),
      ),
      bytes,
    );
    await assert.rejects(f.store.write(f.snapshot, f.signal), /Terminal/);
    assert.equal(
      (await fs.stat(path.join(f.root, 'diagnostics', 'attempt-1'))).mode &
        0o777,
      0o700,
    );
    assert.equal(
      (
        await fs.stat(
          path.join(f.root, 'diagnostics', 'attempt-1', 'attempt.json'),
        )
      ).mode & 0o777,
      0o600,
    );
    assert.deepEqual(
      await fs.readdir(path.join(f.root, 'diagnostics', 'attempt-1')),
      ['attempt.json'],
    );
  });

  it('rejects unknown fields, invalid timestamps, oversized payloads and mismatched identities', async () => {
    const f = await fixture();
    const saved = await f.store.write(f.snapshot, f.signal);
    assert.deepEqual(
      parseAttemptDiagnostics(JSON.parse(serializeAttemptDiagnostics(saved))),
      saved,
    );
    for (const invalid of [
      { ...saved, raw: 'secret' },
      { ...saved, timing: { reserved_at: 'yesterday' } },
      {
        ...saved,
        identity: {
          ...saved.identity,
          selection: {
            ...saved.identity.selection,
            case_id: 'x'.repeat(600_000),
          },
        },
      },
    ])
      assert.throws(() => parseAttemptDiagnostics(invalid));
    await assert.rejects(
      f.store.read(
        { ...f.identity, plan_sha256: `sha256:${'f'.repeat(64)}` },
        f.signal,
      ),
      /identity/,
    );
    await assert.rejects(
      f.store.write(
        { ...f.snapshot, identity: { ...f.identity, run_id: '../escape' } },
        f.signal,
      ),
    );
  });

  it('rejects symlinks at directories and files, and never writes to their targets', async () => {
    for (const level of ['diagnostics', 'attempt-1', 'attempt.json']) {
      const f = await fixture();
      const outside = path.join(f.root, 'outside');
      await fs.mkdir(outside);
      const directory = path.join(f.root, 'diagnostics', 'attempt-1');
      if (level !== 'diagnostics')
        await fs.mkdir(path.join(f.root, 'diagnostics'), { mode: 0o700 });
      if (level === 'attempt.json') await fs.mkdir(directory, { mode: 0o700 });
      const target =
        level === 'diagnostics'
          ? path.join(f.root, level)
          : level === 'attempt-1'
            ? directory
            : path.join(directory, level);
      await fs.symlink(outside, target);
      await assert.rejects(f.store.write(f.snapshot, f.signal));
      await assert.rejects(f.store.read(f.identity, f.signal));
      assert.deepEqual(await fs.readdir(outside), []);
    }
  });

  it('does not publish aborted writes and recovers the fixed staging file after interruption', async () => {
    const f = await fixture();
    await f.store.write(f.snapshot, f.signal);
    const directory = path.join(f.root, 'diagnostics', 'attempt-1');
    await fs.writeFile(path.join(directory, 'attempt.pending'), 'partial', {
      mode: 0o600,
    });
    const aborted = AbortSignal.abort();
    await assert.rejects(
      f.store.write(
        {
          ...f.snapshot,
          state: 'running',
          timing: {
            ...f.snapshot.timing,
            started_at: '2026-01-01T00:00:01.000Z',
          },
        },
        aborted,
      ),
    );
    assert.equal((await f.store.read(f.identity, f.signal))!.revision, 1);
    await f.store.write(
      {
        ...f.snapshot,
        state: 'running',
        timing: {
          ...f.snapshot.timing,
          started_at: '2026-01-01T00:00:01.000Z',
        },
      },
      f.signal,
    );
    assert.equal((await f.store.read(f.identity, f.signal))!.revision, 2);
  });
});
