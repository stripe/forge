import type { ChecksV1 } from './types.ts';

export function hasDeterministicWorkspaceChecks(
  checks: ChecksV1 | undefined,
): boolean {
  return (
    (checks?.files_created?.length ?? 0) > 0 ||
    (checks?.file_checks?.length ?? 0) > 0
  );
}

export function hasToolCallChecks(checks: ChecksV1 | undefined): boolean {
  return (checks?.tool_call_checks?.length ?? 0) > 0;
}

/** True when evaluation emits any deterministic check result. */
export function hasDeterministicChecks(checks: ChecksV1 | undefined): boolean {
  return hasDeterministicWorkspaceChecks(checks) || hasToolCallChecks(checks);
}
