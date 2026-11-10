import type { CredentialResolver } from '../contracts/credentials.ts';
import type { ModelProbe, ModelProbeResult } from '../contracts/modelProbe.ts';
import { MODEL_PROBE_LIMITS } from './limits.ts';

const OUTCOMES = new Set([
  'ok',
  'unknown_model',
  'auth',
  'missing_structured_output',
  'rate_limited',
  'timeout',
  'other',
]);
const REASONS = new Set([
  'http_error',
  'invalid_response',
  'invalid_structured_output',
  'credential_unavailable',
  'transport_error',
  'probe_failed',
  'deadline_exceeded',
  'probe_unavailable',
  'invalid_probe_result',
]);

/** Copy only bounded public observations, including for third-party capabilities. */
export function normalizeProbeResult(value: unknown): ModelProbeResult {
  if (
    !value ||
    typeof value !== 'object' ||
    !('outcome' in value) ||
    typeof value.outcome !== 'string' ||
    !OUTCOMES.has(value.outcome)
  )
    return { outcome: 'other', reason: 'invalid_probe_result' };
  const { outcome } = value;
  const reason = 'reason' in value ? value.reason : undefined;
  const status = 'http_status' in value ? value.http_status : undefined;
  if (
    (reason !== undefined &&
      (typeof reason !== 'string' || !REASONS.has(reason))) ||
    (status !== undefined &&
      (typeof status !== 'number' ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599))
  )
    return { outcome: 'other', reason: 'invalid_probe_result' };
  return {
    outcome: outcome as ModelProbeResult['outcome'],
    ...(reason === undefined
      ? {}
      : { reason: reason as NonNullable<ModelProbeResult['reason']> }),
    ...(status === undefined ? {} : { http_status: status as number }),
  };
}

/** Command-owned deadline covers even dependencies that ignore cancellation. */
export async function runModelProbe(
  probe: ModelProbe,
  credentialResolver: CredentialResolver,
  signal: AbortSignal,
): Promise<ModelProbeResult> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const requestedTimeout = probe.timeoutMs;
  const timeoutMs =
    requestedTimeout !== undefined &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout > 0
      ? Math.min(requestedTimeout, MODEL_PROBE_LIMITS.timeoutMs)
      : MODEL_PROBE_LIMITS.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => undefined;
  const boundary = new Promise<ModelProbeResult>((resolve, reject) => {
    timer = setTimeout(() => {
      resolve({ outcome: 'timeout', reason: 'deadline_exceeded' });
      controller.abort();
    }, timeoutMs);
    cancel = () => {
      reject(signal.reason);
      controller.abort();
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
  const execution = Promise.resolve().then(
    async (): Promise<ModelProbeResult> => {
      try {
        controller.signal.throwIfAborted();
        return normalizeProbeResult(
          await probe.run({ credentialResolver, signal: controller.signal }),
        );
      } catch {
        return { outcome: 'other', reason: 'probe_failed' };
      }
    },
  );
  try {
    return await Promise.race([boundary, execution]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
