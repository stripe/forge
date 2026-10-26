import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RunPhase } from '../contracts/observability.ts';
import type {
  CompletionCallSummaryV1,
  CompletionCallTotalsV1,
} from '../results/types.ts';
import { createRedactedTail } from '../security/diagnosticRedaction.ts';
import { redactSecrets } from '../security/redaction.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  type AgentDiagnosticsCapture,
  agentInvocationSchema,
  MAX_AGENT_DIAGNOSTICS_BYTES,
  type RestrictedAgentExcerpts,
} from './agent.ts';
import {
  type AttemptDiagnosticsIdentity,
  type AttemptDiagnosticsSnapshot,
  MAX_ATTEMPT_COMPLETION_BYTES,
  MAX_ATTEMPT_COMPLETION_SUMMARIES,
  reservedAttemptDiagnostics,
} from './model.ts';

export interface AttemptDiagnosticsWriter {
  (
    snapshot: AttemptDiagnosticsSnapshot,
    excerpts?: RestrictedAgentExcerpts,
  ): Promise<boolean>;
  readonly supportsRestrictedExcerpts?: boolean;
}

/** Execution owns this state; the store owns serialized publication and revisions. */
export function createAttemptRecorder(input: {
  identity: AttemptDiagnosticsIdentity;
  write?: AttemptDiagnosticsWriter | undefined;
  reservedAt?: string | undefined;
  now?: () => Date;
  monotonicNow?: () => number;
  warning?: () => void;
}) {
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  let start = monotonicNow();
  let warned = false;
  let available = false;
  let terminalPublished = false;
  let writing: Promise<void> | undefined;
  let pending:
    | {
        snapshot: AttemptDiagnosticsSnapshot;
        excerpts?: RestrictedAgentExcerpts | undefined;
      }
    | undefined;
  let excerpts: RestrictedAgentExcerpts | undefined;
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
    if (!input.write || terminalPublished) return Promise.resolve();
    pending = { snapshot: structuredClone(snapshot), excerpts };
    writing ??= drain().finally(() => {
      writing = undefined;
    });
    return writing;
  }
  async function drain(): Promise<void> {
    while (pending) {
      const captured = pending;
      pending = undefined;
      if (terminalPublished) continue;
      try {
        available = await input.write!(captured.snapshot, captured.excerpts);
        if (available && captured.snapshot.timing.finished_at !== undefined)
          terminalPublished = true;
        if (!available) warn();
      } catch {
        available = false;
        warn();
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
    agentCapture(
      secrets: readonly string[],
      restrictedExcerpts = false,
    ): AgentDiagnosticsCapture {
      const supported = input.write?.supportsRestrictedExcerpts === true;
      if (snapshot.timing.finished_at === undefined)
        snapshot = {
          ...snapshot,
          capture: {
            ...snapshot.capture,
            restricted: restrictedExcerpts
              ? supported
                ? 'enabled'
                : 'unsupported'
              : 'disabled',
          },
        };
      restrictedExcerpts = restrictedExcerpts && supported;
      return {
        restrictedExcerpts,
        redact: (text) => redactSecrets(text, secrets).value,
        redactedTail: (maximumBytes) =>
          createRedactedTail(secrets, maximumBytes),
        async record(candidate, body) {
          if (!input.write || snapshot.timing.finished_at !== undefined) return;
          try {
            const record = agentInvocationSchema.parse(candidate);
            const records = [
              ...(snapshot.agent_invocations ?? []).filter(
                (item) => item.sequence !== record.sequence,
              ),
              record,
            ];
            records.sort((a, b) => a.sequence - b.sequence);
            let omitted = snapshot.agent_invocations_omitted ?? 0;
            while (
              records.length > 64 ||
              Buffer.byteLength(serializeCanonicalJson(records)) >
                MAX_AGENT_DIAGNOSTICS_BYTES
            ) {
              records.shift();
              omitted += 1;
            }
            if (body && restrictedExcerpts) {
              excerpts = structuredClone(body);
              const descriptor = (value: string) => ({
                bytes: Buffer.byteLength(value),
                sha256: createHash('sha256').update(value).digest('hex'),
              });
              snapshot = {
                ...snapshot,
                restricted: {
                  invocation: record.sequence,
                  cli_events: descriptor(body.cli_events),
                  stderr: descriptor(body.stderr),
                  redacted: true,
                  events_truncated: body.events_truncated,
                  stderr_truncated: body.stderr_truncated,
                },
              };
            }
            snapshot = {
              ...snapshot,
              agent_invocations: records,
              agent_invocations_omitted: omitted,
              capture: {
                ...snapshot.capture,
                process: record.capture,
                protocol:
                  record.event_count > 0
                    ? record.capture === 'partial'
                      ? 'partial'
                      : 'observed'
                    : 'unsupported',
              },
            };
            await flush();
          } catch {
            available = false;
            warn();
          }
        },
      };
    },
    flush,
    reserve: flush,
    async start(startedAt?: string, persist = true) {
      if (snapshot.timing.finished_at !== undefined) return;
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
      if (snapshot.timing.finished_at !== undefined) return;
      snapshot = { ...snapshot, location: { phase } };
      await flush();
    },
    completions(
      calls: readonly CompletionCallSummaryV1[],
      totals: CompletionCallTotalsV1,
    ) {
      if (snapshot.timing.finished_at !== undefined) return;
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
      if (snapshot.timing.finished_at !== undefined) return;
      if (snapshot.primary_failure) return flush();
      // The failure is flushed as active state before cleanup starts.
      mark('failure_observed');
      snapshot = { ...snapshot, primary_failure: failure };
      await flush();
    },
    cleanupFailure(
      code: AttemptDiagnosticsSnapshot['cleanup_failures'][number],
    ) {
      if (snapshot.timing.finished_at !== undefined) return;
      if (!snapshot.cleanup_failures.includes(code))
        snapshot = {
          ...snapshot,
          cleanup_failures: [...snapshot.cleanup_failures, code],
        };
    },
    cleanupCompleted() {
      if (snapshot.timing.finished_at !== undefined) return;
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
