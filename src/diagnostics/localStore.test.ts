import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createAttemptDiagnosticsWriter } from '../execution/diagnosticsIO.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import type {
  AgentInvocationRecord,
  RestrictedAgentExcerpts,
} from './agent.ts';
import { createAttemptDiagnosticsStore } from './localStore.ts';
import {
  attemptDiagnosticsIdentity,
  parseAttemptDiagnostics,
  reservedAttemptDiagnostics,
  serializeAttemptDiagnostics,
} from './model.ts';
import { createAttemptRecorder } from './recorder.ts';

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
  it('can finalize an attempt after a later capture drops an earlier native companion', async () => {
    const f = await fixture();
    const recorder = createAttemptRecorder({
      identity: f.identity,
      write: createAttemptDiagnosticsWriter(f.store),
    });
    await recorder.start();
    recorder.agentCapture([], true);
    const initial = {
      partial_trajectory: {
        state: 'empty' as const,
        completed_turns: 0,
        tool_calls: 0,
        retained_turns: 0,
      },
      native_log: {
        state: 'available' as const,
        format: 'claude-code-jsonl' as const,
        source_bytes: 4,
        capture_point: 'failure' as const,
      },
    };
    recorder.failureEvidence(initial, { native_log: 'text' });
    await recorder.failure({
      error_code: 'agent_failed',
      phase: 'interaction',
      reason: 'failure',
      message: 'Agent failed.',
    });
    recorder.failureEvidence(
      { ...initial, native_log: { state: 'unavailable' } },
      {},
    );
    await recorder.finish('errored');
    const saved = (await f.store.read(f.identity, f.signal))!;
    assert.equal(saved.state, 'errored');
    assert.equal(saved.failure_evidence!.native_log.state, 'unavailable');
    assert.equal(recorder.recordingFailed, false);
  });

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

const invocation: AgentInvocationRecord = {
  sequence: 1,
  operation: 'agent_exec',
  cli_version: '1.0.0',
  source: 'codex_exec_json',
  state: 'failed',
  capture: 'observed',
  event_count: 1,
  tool_failure_count: 0,
  last_completed_turn: 0,
  events: [],
  rejection: { code: 'invalid_json', line_index: 1, schema_path: 'event' },
};

it('publishes restricted excerpts through the attempt store and verifies their digests on read', async () => {
  const f = await fixture();
  const recorder = createAttemptRecorder({
    identity: f.identity,
    write: createAttemptDiagnosticsWriter(f.store),
  });
  await recorder.start();
  const body: RestrictedAgentExcerpts = {
    cli_events: '{"events":[]}',
    stderr: 'redacted excerpt',
    events_truncated: false,
    stderr_truncated: false,
  };
  await recorder.agentCapture([], true).record(invocation, body);
  const saved = (await f.store.read(f.identity, f.signal))!;
  assert.equal(saved.capture.restricted, 'enabled');
  assert.deepEqual(saved.agent_invocations, [invocation]);
  const directory = path.join(
    f.root,
    'diagnostics',
    f.identity.run_id,
    'restricted',
  );
  const stderrPath = path.join(
    directory,
    `${saved.restricted!.stderr.sha256}.txt`,
  );
  assert.equal(await fs.readFile(stderrPath, 'utf8'), body.stderr);
  assert.equal((await fs.stat(stderrPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  await fs.writeFile(stderrPath, 'tampered excerpt');
  await assert.rejects(
    f.store.read(f.identity, f.signal),
    /digest|Unsafe|mismatched/,
  );
});

it('rejects symlinked restricted directories and excerpt files before publishing references', async () => {
  for (const level of ['directory', 'file']) {
    const f = await fixture();
    await f.store.write(f.snapshot, f.signal);
    const directory = path.join(
      f.root,
      'diagnostics',
      f.identity.run_id,
      'restricted',
    );
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    const body: RestrictedAgentExcerpts = {
      cli_events: '{}',
      stderr: '',
      events_truncated: false,
      stderr_truncated: false,
    };
    const descriptor = (value: string) => ({
      sha256: createHash('sha256').update(value).digest('hex'),
      bytes: Buffer.byteLength(value),
    });
    if (level === 'directory') await fs.symlink(outside, directory);
    else {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.symlink(
        outside,
        path.join(directory, `${descriptor(body.cli_events).sha256}.json`),
      );
    }
    await assert.rejects(
      f.store.write(
        {
          ...f.snapshot,
          capture: { ...f.snapshot.capture, restricted: 'enabled' },
          restricted: {
            invocation: 1,
            cli_events: descriptor(body.cli_events),
            stderr: descriptor(body.stderr),
            redacted: true,
            events_truncated: false,
            stderr_truncated: false,
          },
        },
        f.signal,
        body,
      ),
    );
    assert.equal(
      (await f.store.read(f.identity, f.signal))!.restricted,
      undefined,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  }
});

it('requires opt-in and an explicit store capability for restricted persistence', async () => {
  const f = await fixture();
  const recorder = createAttemptRecorder({
    identity: f.identity,
    write: createAttemptDiagnosticsWriter(f.store),
  });
  await recorder.start();
  await recorder.agentCapture([]).record(invocation);
  assert.equal(
    (await f.store.read(f.identity, f.signal))!.restricted,
    undefined,
  );
  await assert.rejects(
    fs.stat(path.join(f.root, 'diagnostics', f.identity.run_id, 'restricted')),
    { code: 'ENOENT' },
  );
  const unsupported = createAttemptRecorder({
    identity: f.identity,
    write: createAttemptDiagnosticsWriter({
      read: f.store.read,
      write: f.store.write,
    }),
  });
  const capture = unsupported.agentCapture([], true);
  assert.equal(capture.restrictedExcerpts, false);
  assert.equal(unsupported.snapshot.capture.restricted, 'unsupported');
});

it('keeps old snapshots readable and rejects unsafe protocol paths and unknown nested fields', async () => {
  const f = await fixture();
  const old = await f.store.write(f.snapshot, f.signal);
  assert.equal(parseAttemptDiagnostics(old).agent_invocations, undefined);
  for (const changed of [
    { ...invocation, message: 'private' },
    {
      ...invocation,
      rejection: { code: 'invalid_json', schema_path: 'event.private-name' },
    },
    {
      ...invocation,
      events: [
        {
          sequence: 1,
          observed_at: '2026-01-01T00:00:00.000Z',
          event_type: 'private-name',
        },
      ],
    },
  ])
    assert.throws(() =>
      parseAttemptDiagnostics({ ...old, agent_invocations: [changed] }),
    );
});

it('rejects missing excerpt companions instead of treating the attempt as absent', async () => {
  const f = await fixture();
  const recorder = createAttemptRecorder({
    identity: f.identity,
    write: createAttemptDiagnosticsWriter(f.store),
  });
  await recorder.start();
  await recorder.agentCapture([], true).record(invocation, {
    cli_events: '{}',
    stderr: 'tail',
    events_truncated: false,
    stderr_truncated: false,
  });
  const saved = (await f.store.read(f.identity, f.signal))!;
  await fs.unlink(
    path.join(
      f.root,
      'diagnostics',
      f.identity.run_id,
      'restricted',
      `${saved.restricted!.stderr.sha256}.txt`,
    ),
  );
  await assert.rejects(f.store.read(f.identity, f.signal), /missing/);
});

it('references only the latest failed invocation and preserves older digest files for prior snapshots', async () => {
  const f = await fixture();
  const recorder = createAttemptRecorder({
    identity: f.identity,
    write: createAttemptDiagnosticsWriter(f.store),
  });
  const capture = recorder.agentCapture([], true);
  const bodies: RestrictedAgentExcerpts[] = [
    {
      cli_events: '{"failure":1}',
      stderr: 'first tail',
      events_truncated: false,
      stderr_truncated: false,
    },
    {
      cli_events: '{"failure":2}',
      stderr: 'second tail',
      events_truncated: false,
      stderr_truncated: false,
    },
  ];
  await recorder.start();
  await capture.record(invocation, bodies[0]);
  const first = (await f.store.read(f.identity, f.signal))!;
  await capture.record({ ...invocation, sequence: 2 }, bodies[1]);
  const latest = (await f.store.read(f.identity, f.signal))!;
  assert.equal(latest.restricted!.invocation, 2);
  assert.equal(latest.agent_invocations!.length, 2);
  assert.notDeepEqual(latest.restricted, first.restricted);
  const folder = path.join(
    f.root,
    'diagnostics',
    f.identity.run_id,
    'restricted',
  );
  for (const [record, body] of [
    [first, bodies[0]!],
    [latest, bodies[1]!],
  ] as const) {
    for (const [key, extension] of [
      ['cli_events', 'json'],
      ['stderr', 'txt'],
    ] as const)
      assert.equal(
        await fs.readFile(
          path.join(folder, `${record.restricted![key].sha256}.${extension}`),
          'utf8',
        ),
        body[key],
      );
  }
  assert.equal((await fs.readdir(folder)).length, 4);
});
