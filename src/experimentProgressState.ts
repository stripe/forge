import type { ExperimentLogGap } from './experimentEvents.ts';
import { EXPERIMENT_OBSERVATION_LIMITS } from './experimentObservation.ts';
import { serializeCanonicalJson } from './serialization.ts';

export interface ExperimentProgressGaps {
  readonly total: ExperimentLogGap | undefined;
  readonly pending: ExperimentLogGap | undefined;
}

export function accumulateExperimentProgressGap(
  gaps: ExperimentProgressGaps,
  reason: ExperimentLogGap['reason'],
  count: number,
): ExperimentProgressGaps {
  if (count === 0) return gaps;
  const add = (previous: ExperimentLogGap | undefined): ExperimentLogGap => ({
    state: 'unavailable',
    reason: previous?.reason ?? reason,
    affected_events: Math.min(
      Number.MAX_SAFE_INTEGER,
      (previous?.affected_events ?? 0) + count,
    ),
  });
  return { total: add(gaps.total), pending: add(gaps.pending) };
}

export function acknowledgeExperimentProgressGap(
  gaps: ExperimentProgressGaps,
  recorded: ExperimentLogGap | undefined,
): ExperimentProgressGaps {
  if (recorded === undefined || gaps.pending === undefined) return gaps;
  const remaining = gaps.pending.affected_events - recorded.affected_events;
  return {
    ...gaps,
    pending:
      remaining === 0
        ? undefined
        : { ...gaps.pending, affected_events: remaining },
  };
}

export function prepareExperimentProgressRecord(
  body: string,
  gap: ExperimentLogGap | undefined,
):
  | { readonly state: 'ready'; readonly body: string }
  | { readonly state: 'unavailable'; readonly reason: 'buffer_full' } {
  const next =
    gap === undefined
      ? body
      : serializeCanonicalJson({ ...JSON.parse(body), recording_gap: gap });
  return Buffer.byteLength(next) > EXPERIMENT_OBSERVATION_LIMITS.eventBytes
    ? { state: 'unavailable', reason: 'buffer_full' }
    : { state: 'ready', body: next };
}
