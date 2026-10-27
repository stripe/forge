import { isSafeWorkspaceRelativePath } from '../model/paths.ts';

export function workspaceDirectoryExclusions(
  names: readonly string[] = [],
): ReadonlySet<string> {
  if (!Array.isArray(names)) {
    throw new TypeError(
      'excludeDirectoryNames must be an array of directory basenames.',
    );
  }
  for (const name of names) {
    if (
      typeof name !== 'string' ||
      name.includes('/') ||
      !isSafeWorkspaceRelativePath(name)
    ) {
      throw new TypeError(
        'excludeDirectoryNames must contain only safe, non-empty directory basenames.',
      );
    }
  }
  return new Set(names);
}

/** Retain shallowest entries first, then code-unit path order at each depth. */
export function compareWorkspaceListingPaths(
  left: string,
  right: string,
): number {
  const depthDifference = left.split('/').length - right.split('/').length;
  return depthDifference || (left < right ? -1 : left > right ? 1 : 0);
}
