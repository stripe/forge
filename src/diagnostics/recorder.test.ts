import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, it, vi } from 'vitest';
import type { AttemptDiagnosticsStore } from '../contracts/attemptDiagnostics.ts';
import { createAttemptDiagnosticsWriter } from '../execution/diagnosticsIO.ts';
import type { CompletionCallSummaryV1 } from '../results/types.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import type {
  AgentInvocationRecord,
  RestrictedAgentExcerpts,
} from './agent.ts';
import {
  type AttemptDiagnosticsSnapshot,
  attemptDiagnosticsIdentity,
  MAX_ATTEMPT_COMPLETION_SUMMARIES,
  parseAttemptDiagnostics,
} from './model.ts';
import { createAttemptRecorder as createRecorder } from './recorder.ts';

function createAttemptRecorder(
  input: Omit<Parameters<typeof createRecorder>[0], 'write'> & {
    store?: AttemptDiagnosticsStore;
  },
) {
  const { store, ...options } = input;
  return createRecorder({
    ...options,
    write: createAttemptDiagnosticsWriter(store),
  });
}

afterEach(() => vi.useRealTimers());
const identity = attemptDiagnosticsIdentity(
  'timed-attempt',
  createTestResolvedRunPlan(),
);

describe('attempt recorder', () => {
  it('records independent UTC times and monotonic durations even when the wall clock moves backwards', async () => {
    let wall = new Date('2026-01-01T00:00:10.000Z');
    let elapsed = 0;
    const snapshots: AttemptDiagnosticsSnapshot[] = [];
    const store: AttemptDiagnosticsStore = {
      async read() {
        return undefined;
      },
      async write(snapshot) {
        snapshots.push(snapshot);
        return parseAttemptDiagnostics({
          ...snapshot,
          revision: snapshots.length,
        });
      },
    };
    const recorder = createAttemptRecorder({
      identity,
      store,
      now: () => wall,
      monotonicNow: () => elapsed,
    });
    await recorder.reserve();
    await recorder.start();
    wall = new Date('2026-01-01T00:00:00.000Z');
    elapsed = 50;
    await recorder.failure({
      error_code: 'agent_failed',
      phase: 'interaction',
      reason: 'failure',
      message: 'Agent failed.',
    });
    assert.equal(snapshots.at(-1)!.timing.failure_observed_elapsed_ms, 50);
    assert.equal(snapshots.at(-1)!.timing.finished_at, undefined);
    recorder.cleanupFailure('runtime_dispose_failed');
    elapsed = 90;
    recorder.cleanupCompleted();
    elapsed = 100;
    await recorder.finish('errored');
    const final = snapshots.at(-1)!;
    assert.equal(final.timing.failure_observed_at, '2026-01-01T00:00:00.000Z');
    assert.equal(final.timing.cleanup_completed_elapsed_ms, 90);
    assert.equal(final.timing.finished_elapsed_ms, 100);
    assert.equal(final.primary_failure!.error_code, 'agent_failed');
    assert.deepEqual(final.cleanup_failures, ['runtime_dispose_failed']);
  });

  it('bounds hung progress and terminal storage separately within two seconds and warns once', async () => {
    vi.useFakeTimers();
    let writes = 0;
    let warnings = 0;
    let signal: AbortSignal | undefined;
    const recorder = createAttemptRecorder({
      identity,
      warning: () => warnings++,
      store: {
        async read() {
          return undefined;
        },
        async write(_snapshot, currentSignal) {
          writes++;
          signal = currentSignal;
          return await new Promise<never>(() => undefined);
        },
      },
    });
    const reserving = recorder.reserve();
    await vi.advanceTimersByTimeAsync(1000);
    await reserving;
    await recorder.start();
    const failing = recorder.failure({
      error_code: 'agent_failed',
      phase: 'interaction',
      reason: 'failure',
      message: 'Agent failed.',
    });
    await vi.advanceTimersByTimeAsync(500);
    await failing;
    const finishing = recorder.finish('errored');
    await vi.advanceTimersByTimeAsync(500);
    await finishing;
    assert.equal(writes, 3);
    assert.equal(warnings, 1);
    assert.equal(signal!.aborted, true);
    assert.equal(recorder.available, false);
  });

  it('reserves failure and terminal writes after slow progress exhausts its allowance', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const writes: AttemptDiagnosticsSnapshot[] = [];
    const recorder = createAttemptRecorder({
      identity,
      store: {
        async read() {
          return undefined;
        },
        async write(snapshot) {
          elapsed += 300;
          writes.push(snapshot);
          return parseAttemptDiagnostics({
            ...snapshot,
            revision: writes.length,
          });
        },
      },
    });
    try {
      await recorder.start();
      for (let index = 0; index < 8; index++)
        await recorder.phase('interaction');
      assert.equal(writes.length, 4);
      await recorder.failure({
        error_code: 'agent_failed',
        phase: 'interaction',
        reason: 'failure',
        message: 'Agent failed.',
      });
      assert.equal(writes.at(-1)!.primary_failure!.error_code, 'agent_failed');
      recorder.cleanupCompleted();
      await recorder.finish('errored');
      assert.equal(writes.at(-1)!.state, 'errored');
      assert.equal(writes.length, 6);
      assert.equal(recorder.available, true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('ignores observations and lifecycle mutations after terminal publication', async () => {
    let terminal: AttemptDiagnosticsSnapshot | undefined;
    let writes = 0;
    const recorder = createAttemptRecorder({
      identity,
      store: {
        async read() {
          return undefined;
        },
        async write(snapshot) {
          writes++;
          if (terminal) assert.deepEqual(snapshot, terminal);
          if (snapshot.timing.finished_at) terminal = snapshot;
          return parseAttemptDiagnostics({ ...snapshot, revision: writes });
        },
      },
    });
    await recorder.start();
    await recorder.failure({
      error_code: 'agent_failed',
      phase: 'interaction',
      reason: 'failure',
      message: 'Agent failed.',
    });
    recorder.cleanupCompleted();
    await recorder.finish('errored');
    const saved = recorder.snapshot;
    recorder.completions([], {
      calls: 1,
      failed: 1,
      omitted: 1,
      rate_limit_wait_ms: 0,
    });
    await recorder.start();
    await recorder.phase('evidence');
    await recorder.failure({
      error_code: 'runtime_failed',
      phase: 'evidence',
      reason: 'failure',
      message: 'Late failure.',
    });
    recorder.cleanupFailure('runtime_dispose_failed');
    recorder.cleanupCompleted();
    await recorder.flush();
    assert.deepEqual(recorder.snapshot, saved);
    assert.equal(writes, 3);
    assert.equal(recorder.available, true);
    assert.equal(recorder.recordingFailed, false);
  });

  it('preserves the first observed failure and terminal timestamp across repeated recording', async () => {
    let milliseconds = 0;
    const recorder = createAttemptRecorder({
      identity,
      monotonicNow: () => milliseconds,
      now: () => new Date(milliseconds),
    });
    await recorder.start();
    milliseconds = 10;
    await recorder.failure({
      error_code: 'agent_failed',
      phase: 'interaction',
      reason: 'failure',
      message: 'First failure.',
    });
    milliseconds = 20;
    await recorder.failure({
      error_code: 'runtime_failed',
      phase: 'runtime_dispose',
      reason: 'failure',
      message: 'Later failure.',
    });
    await recorder.finish('errored');
    const terminal = recorder.snapshot;
    milliseconds = 30;
    await recorder.finish('errored');
    assert.deepEqual(recorder.snapshot, terminal);
    assert.equal(terminal.primary_failure!.message, 'First failure.');
    assert.equal(terminal.timing.failure_observed_elapsed_ms, 10);
  });

  it('stops retaining whole subattempt records at the byte cap and continues totals', () => {
    const recorder = createAttemptRecorder({ identity });
    const calls = Array.from(
      { length: 256 },
      (_, index) =>
        ({
          sequence: index + 1,
          purpose: 'judge',
          provider: 'scripted',
          provider_version: '1',
          model: 'm'.repeat(4096),
          status: 'succeeded',
        }) as CompletionCallSummaryV1,
    );
    recorder.completions(calls, {
      calls: 256,
      failed: 0,
      omitted: 0,
      rate_limit_wait_ms: 0,
    });
    const record = parseAttemptDiagnostics({
      ...recorder.snapshot,
      revision: 1,
    });
    assert.ok(
      record.completion_calls.length > 0 &&
        record.completion_calls.length < 256,
    );
    assert.equal(
      record.completion_call_totals.omitted,
      256 - record.completion_calls.length,
    );
    assert.equal(record.completion_calls[0]!.model, 'm'.repeat(4096));
    assert.throws(() =>
      parseAttemptDiagnostics({
        ...record,
        completion_calls: calls.slice(0, 80),
        completion_call_totals: {
          calls: 80,
          failed: 0,
          omitted: 0,
          rate_limit_wait_ms: 0,
        },
      }),
    );
  });

  it('coalesces concurrent observations behind the active writer and flushes the latest state', async () => {
    const writes: AttemptDiagnosticsSnapshot[] = [];
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = createAttemptRecorder({
      identity,
      store: {
        async read() {
          return undefined;
        },
        async write(snapshot) {
          writes.push(snapshot);
          if (writes.length === 1) await firstWrite;
          return parseAttemptDiagnostics({
            ...snapshot,
            revision: writes.length,
          });
        },
      },
    });
    const reservation = recorder.reserve();
    const phases = Array.from({ length: 100 }, (_, index) =>
      recorder.phase(index === 99 ? 'interaction' : 'setup'),
    );
    release();
    await Promise.all([reservation, ...phases]);
    assert.equal(writes.length, 2);
    assert.equal(writes.at(-1)!.location!.phase, 'interaction');
  });

  it('caps completion subattempts, keeps retry dispositions and counts omitted calls without retaining arbitrary fields', async () => {
    const recorder = createAttemptRecorder({ identity });
    const calls = Array.from(
      { length: MAX_ATTEMPT_COMPLETION_SUMMARIES + 2 },
      (_, i) =>
        ({
          sequence: i + 1,
          purpose: 'judge',
          provider: 'scripted',
          provider_version: '1',
          model: 'example',
          status: 'failed',
          http_status: 429,
          request_id: 'request_1',
          retry_ordinal: 1,
          retry_wait_ms: 100,
          disposition: 'rate_limit_retry',
          content: 'private prompt',
        }) as unknown as CompletionCallSummaryV1,
    );
    recorder.completions(calls, {
      calls: calls.length,
      failed: calls.length,
      omitted: 0,
      rate_limit_wait_ms: calls.length * 100,
    });
    const record = parseAttemptDiagnostics({
      ...recorder.snapshot,
      revision: 1,
    });
    assert.equal(
      record.completion_calls.length,
      MAX_ATTEMPT_COMPLETION_SUMMARIES,
    );
    assert.equal(record.completion_call_totals.omitted, 2);
    assert.equal(
      record.completion_call_totals.rate_limit_wait_ms,
      calls.length * 100,
    );
    assert.equal(record.completion_calls[0]!.disposition, 'rate_limit_retry');
    assert.doesNotMatch(JSON.stringify(record), /private prompt|content/);
  });
});

it('bounds accumulated agent invocations while preserving the newest failure and omitted counts', async () => {
  const recorder = createAttemptRecorder({
    identity,
    store: {
      async read() {
        return undefined;
      },
      async write(snapshot) {
        return parseAttemptDiagnostics({ ...snapshot, revision: 1 });
      },
    },
  });
  const capture = recorder.agentCapture([]);
  for (let sequence = 1; sequence <= 100; sequence++) {
    await capture.record({
      sequence,
      operation: 'agent_exec',
      cli_version: '1.0.0',
      source: 'codex_exec_json',
      state: sequence === 100 ? 'failed' : 'completed',
      capture: 'observed',
      event_count: 0,
      tool_failure_count: 0,
      last_completed_turn: 0,
      events: [],
      ...(sequence === 100 ? { rejection: { code: 'unknown' as const } } : {}),
    });
  }
  assert.equal(recorder.snapshot.agent_invocations!.length, 64);
  assert.equal(recorder.snapshot.agent_invocations_omitted, 36);
  assert.equal(recorder.snapshot.agent_invocations!.at(-1)!.state, 'failed');
  assert.equal(recorder.recordingFailed, false);
});

it('gives adapters redaction authority without exposing resolved secrets', () => {
  const recorder = createAttemptRecorder({
    identity,
    store: {
      supportsRestrictedExcerpts: true,
      async read() {
        return undefined;
      },
      async write(snapshot) {
        return parseAttemptDiagnostics({ ...snapshot, revision: 1 });
      },
    },
  });
  const capture = recorder.agentCapture(['host-only-key'], true);
  assert.equal('secrets' in capture, false);
  assert.equal(JSON.stringify(capture).includes('host-only-key'), false);
  assert.equal(capture.redact('failure host-only-key'), 'failure [REDACTED]');
  const tail = capture.redactedTail(32);
  tail.push('failure host-only-');
  tail.push('key');
  assert.equal(tail.finish().text, 'failure [REDACTED]');
});

it('publishes Codex failures and excerpts with reserved budgets after progress fails, then ignores late capture', async () => {
  const invocation: AgentInvocationRecord = {
    sequence: 1,
    operation: 'agent_exec',
    cli_version: '1.0.0',
    source: 'codex_exec_json',
    state: 'failed',
    capture: 'observed',
    event_count: 0,
    tool_failure_count: 0,
    last_completed_turn: 0,
    events: [],
    rejection: { code: 'invalid_json' },
  };
  const body: RestrictedAgentExcerpts = {
    cli_events: '{"failure":"synthetic"}',
    stderr: 'redacted tail',
    events_truncated: false,
    stderr_truncated: false,
  };
  const writes: Array<{
    snapshot: AttemptDiagnosticsSnapshot;
    excerpts: RestrictedAgentExcerpts | undefined;
  }> = [];
  const recorder = createAttemptRecorder({
    identity,
    store: {
      supportsRestrictedExcerpts: true,
      async read() {
        return undefined;
      },
      async write(snapshot, _signal, excerpts) {
        writes.push({ snapshot, excerpts });
        if (!snapshot.primary_failure)
          throw new Error('Progress storage failed.');
        return parseAttemptDiagnostics({
          ...snapshot,
          revision: writes.length,
        });
      },
    },
  });
  await recorder.start();
  assert.equal(recorder.recordingFailed, true);
  const capture = recorder.agentCapture([], true);
  await capture.record(invocation, body);
  assert.equal(writes.length, 1);
  await recorder.failure({
    error_code: 'agent_failed',
    phase: 'interaction',
    reason: 'failure',
    message: 'Agent failed.',
  });
  await recorder.finish('errored');
  assert.equal(writes.length, 3);
  for (const write of writes.slice(1)) {
    assert.deepEqual(write.snapshot.agent_invocations, [invocation]);
    assert.equal(write.snapshot.capture.restricted, 'enabled');
    assert.deepEqual(write.excerpts, body);
    assert.ok(write.snapshot.restricted);
  }
  assert.equal(writes.at(-1)!.snapshot.state, 'errored');
  const terminal = recorder.snapshot;
  await capture.record(
    { ...invocation, sequence: 2 },
    { ...body, stderr: 'late tail' },
  );
  recorder.agentCapture([], false);
  await recorder.flush();
  assert.deepEqual(recorder.snapshot, terminal);
  assert.equal(writes.length, 3);
});
