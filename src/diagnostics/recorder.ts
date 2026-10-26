import { performance } from 'node:perf_hooks';
import type { AttemptDiagnosticsStore } from '../contracts/attemptDiagnostics.ts';
import type { RunPhase } from '../contracts/observability.ts';
import type {
  CompletionCallSummaryV1,
  CompletionCallTotalsV1,
} from '../results/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  type AttemptDiagnosticsIdentity,
  type AttemptDiagnosticsSnapshot,
  MAX_ATTEMPT_COMPLETION_BYTES,
  MAX_ATTEMPT_COMPLETION_SUMMARIES,
  reservedAttemptDiagnostics,
} from './model.ts';

export const ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS = 2000;

/** Execution owns this state; the store owns serialized publication and revisions. */
export function createAttemptRecorder(input: {
  identity: AttemptDiagnosticsIdentity;
  store?: AttemptDiagnosticsStore | undefined;
  reservedAt?: string | undefined;
  now?: () => Date;
  monotonicNow?: () => number;
  warning?: () => void;
}) {
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  let start = monotonicNow();
  let remaining = ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS;
  let warned = false;
  let available = false;
  let writing: Promise<void> | undefined;
  let pending: AttemptDiagnosticsSnapshot | undefined;
  let snapshot = reservedAttemptDiagnostics(
    input.identity,
    input.reservedAt ?? now().toISOString(),
  );
  function warn() {
    if (!warned) {
      warned = true;
      input.warning?.();
    }
  }
  function flush(): Promise<void> {
    if (warned || !input.store) return Promise.resolve();
    pending = structuredClone(snapshot);
    writing ??= drain().finally(() => {
      writing = undefined;
    });
    return writing;
  }
  async function drain(): Promise<void> {
    while (pending && !warned) {
      const captured = pending;
      pending = undefined;
      if (remaining <= 0) {
        warn();
        return;
      }
      const before = performance.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          input.store!.write(captured, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              remaining = 0;
              controller.abort();
              reject(new Error('Diagnostic I/O budget exhausted.'));
            }, remaining);
          }),
        ]);
        available = true;
      } catch {
        available = false;
        warn();
      } finally {
        clearTimeout(timer);
        remaining = Math.max(0, remaining - (performance.now() - before));
      }
    }
    pending = undefined;
  }

  function mark(name: 'failure_observed' | 'cleanup_completed' | 'finished') {
    snapshot = {
      ...snapshot,
      timing: {
        ...snapshot.timing,
        [`${name}_at`]: now().toISOString(),
        ...(snapshot.timing.started_at === undefined
          ? {}
          : { [`${name}_elapsed_ms`]: Math.max(0, monotonicNow() - start) }),
      },
    };
  }
  return {
    get recordingFailed() {
      return warned;
    },
    get available() {
      return available;
    },
    get snapshot() {
      return structuredClone(snapshot);
    },
    flush,
    reserve: flush,
    async start(startedAt?: string, persist = true) {
      start = monotonicNow();
      snapshot = {
        ...snapshot,
        state: 'running',
        timing: {
          ...snapshot.timing,
          started_at: startedAt ?? now().toISOString(),
        },
      };
      if (persist) await flush();
    },
    async phase(phase: RunPhase) {
      snapshot = { ...snapshot, location: { phase } };
      await flush();
    },
    completions(
      calls: readonly CompletionCallSummaryV1[],
      totals: CompletionCallTotalsV1,
    ) {
      const retained = calls
        .slice(0, MAX_ATTEMPT_COMPLETION_SUMMARIES)
        .map(
          ({
            sequence,
            provider,
            provider_version,
            model,
            purpose,
            status,
            http_status,
            request_id,
            provider_error_code,
            retry_ordinal,
            retry_wait_ms,
            disposition,
          }) => ({
            sequence,
            provider,
            provider_version,
            model,
            purpose,
            status,
            ...(http_status === undefined ? {} : { http_status }),
            ...(request_id === undefined ? {} : { request_id }),
            ...(provider_error_code === undefined
              ? {}
              : { provider_error_code }),
            ...(retry_ordinal === undefined ? {} : { retry_ordinal }),
            ...(retry_wait_ms === undefined ? {} : { retry_wait_ms }),
            ...(disposition === undefined ? {} : { disposition }),
          }),
        );
      let retainedBytes = 3;
      const bounded = retained.filter((call) => {
        retainedBytes += Buffer.byteLength(serializeCanonicalJson(call)) + 1;
        return retainedBytes <= MAX_ATTEMPT_COMPLETION_BYTES;
      });
      snapshot = {
        ...snapshot,
        completion_calls: bounded,
        completion_call_totals: {
          ...totals,
          omitted: totals.calls - bounded.length,
        },
      };
      void flush();
    },
    async failure(
      failure: NonNullable<AttemptDiagnosticsSnapshot['primary_failure']>,
    ) {
      if (snapshot.primary_failure) return flush();
      // The failure is flushed as active state before cleanup starts.
      mark('failure_observed');
      snapshot = { ...snapshot, primary_failure: failure };
      await flush();
    },
    cleanupFailure(
      code: AttemptDiagnosticsSnapshot['cleanup_failures'][number],
    ) {
      if (!snapshot.cleanup_failures.includes(code))
        snapshot = {
          ...snapshot,
          cleanup_failures: [...snapshot.cleanup_failures, code],
        };
    },
    cleanupCompleted() {
      mark('cleanup_completed');
    },
    async finish(state: 'completed' | 'errored') {
      if (snapshot.timing.finished_at !== undefined) return flush();
      mark('finished');
      snapshot = { ...snapshot, state };
      await flush();
    },
  };
}

export type AttemptDiagnosticsRecorder = ReturnType<
  typeof createAttemptRecorder
>;
