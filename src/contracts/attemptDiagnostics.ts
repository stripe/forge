import type { RestrictedAgentExcerpts } from '../diagnostics/agent.ts';
import type {
  AttemptDiagnosticsIdentity,
  AttemptDiagnosticsRecord,
  AttemptDiagnosticsSnapshot,
} from '../diagnostics/model.ts';

/** Separate from completed results; records must never be used as evaluation evidence. */
export interface AttemptDiagnosticsStore {
  /** Opt in only when write publishes and read verifies restricted companions. */
  readonly supportsRestrictedExcerpts?: boolean;
  /** Serialize writes for each identity, assign revisions, and atomically replace snapshots.
   * Publish excerpts atomically before snapshot references, and verify size/digest on read.
   * Honor cancellation before publication. Repeating an identical terminal write is idempotent.
   */
  write(
    snapshot: AttemptDiagnosticsSnapshot,
    signal: AbortSignal,
    excerpts?: RestrictedAgentExcerpts,
  ): Promise<AttemptDiagnosticsRecord>;
  /** Missing records are supported. Existing records must match the entire supplied identity.
   * Throw AttemptDiagnosticsIdentityError for a readable conflicting record; other read
   * failures degrade to unavailable history during resume.
   */
  read(
    identity: AttemptDiagnosticsIdentity,
    signal: AbortSignal,
  ): Promise<AttemptDiagnosticsRecord | undefined>;
}

export type {
  AgentDiagnosticsCapture,
  AgentEventSummary,
  AgentInvocationRecord,
  ProtocolRejection,
  RedactedDiagnosticTail,
  RestrictedAgentExcerpts,
} from '../diagnostics/agent.ts';
