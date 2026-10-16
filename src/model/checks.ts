import type { ChecksV1 } from './types.ts';

export function hasDeterministicWorkspaceChecks(
  checks: ChecksV1 | undefined,
): boolean {
  return (
    (checks?.files_created?.length ?? 0) > 0 ||
    (checks?.file_checks?.length ?? 0) > 0
  );
}
