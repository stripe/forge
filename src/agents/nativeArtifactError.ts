import type {
  AgentEvidenceContext,
  AgentNativeArtifactUnavailableReason,
} from '../contracts/agent.ts';

export class NativeArtifactReadError extends Error {
  constructor(readonly reason: AgentNativeArtifactUnavailableReason) {
    super('The exact native artifact is unavailable.');
  }
}

export function reportNativeArtifactUnavailable(
  context: Pick<AgentEvidenceContext, 'onNativeArtifactUnavailable'>,
  error?: unknown,
) {
  try {
    context.onNativeArtifactUnavailable?.(
      error instanceof NativeArtifactReadError ? error.reason : 'read_failed',
    );
  } catch {
    /* Observation cannot control evidence collection. */
  }
}
