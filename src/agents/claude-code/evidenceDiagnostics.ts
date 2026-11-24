import { AtifValidationError } from '../../atif/index.ts';
import type { AgentNativeEvidenceWarning } from '../../contracts/agent.ts';

const ATIF_FIELD_NAMES = new Set([
  'agent',
  'arguments',
  'content',
  'extra',
  'function_name',
  'message',
  'model_name',
  'name',
  'observation',
  'reasoning_content',
  'results',
  'schema_version',
  'session_id',
  'source',
  'source_call_id',
  'step_id',
  'steps',
  'timestamp',
  'tool_call_id',
  'tool_calls',
  'version',
]);

export class ClaudeSessionLimitError extends Error {}
export class ClaudeSessionIncompleteError extends Error {
  constructor(
    message: string,
    readonly location?: { line: number; kind: string },
  ) {
    super(message);
  }
}
export class ClaudeSessionInvalidError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

export function omittedValueWarning(
  message: string,
  line: number,
): AgentNativeEvidenceWarning {
  return { code: 'value_omitted', message, path: `line:${line}` };
}

export function safeSessionFailure(error: unknown): string {
  if (error instanceof ClaudeSessionLimitError) {
    return 'Claude session evidence exceeded a safety limit.';
  }
  if (error instanceof ClaudeSessionIncompleteError && error.location) {
    if (
      error.location.kind === 'compact summary' ||
      error.location.kind === 'system/compact_boundary'
    ) {
      return `Claude compaction may replace earlier turns; complete conversation coverage cannot be established (${error.location.kind} at line ${error.location.line}).`;
    }
    return `Claude session evidence could not be normalized safely (${error.location.kind} at line ${error.location.line}).`;
  }
  if (error instanceof ClaudeSessionInvalidError) {
    const location = error.line === undefined ? '' : ` at line ${error.line}`;
    return `Claude session evidence could not be normalized safely (${error.kind}${location}).`;
  }
  if (error instanceof AtifValidationError) {
    return `Claude session evidence could not be normalized safely (ATIF validation failed at ${safeAtifPath(error.issues[0]?.path ?? [])}).`;
  }
  return 'Claude session evidence could not be normalized safely.';
}

// Tool-call arguments and extras carry native keys, so the path stops at the
// first segment that is not a field this converter writes.
export function safeAtifPath(path: readonly (string | number)[]): string {
  const unsafeIndex = path.findIndex(
    (segment) => typeof segment === 'string' && !ATIF_FIELD_NAMES.has(segment),
  );
  const safe = unsafeIndex === -1 ? path : path.slice(0, unsafeIndex);
  return safe.length === 0 ? 'trajectory' : safe.join('.');
}
