import type { AgentPluginInstallationReceipt } from '../../contracts/plugin.ts';

export { inspectInstalledPluginTree } from '../pluginTree.ts';

export function pluginSourceReceipt(
  source: unknown,
  resolvedCommit: string | undefined,
): AgentPluginInstallationReceipt['source'] {
  if (typeof source === 'string')
    return Object.freeze({ kind: 'marketplace-path' });
  if (!isPlainRecord(source) || typeof source.source !== 'string') {
    throw new Error('Marketplace plugin source is malformed.');
  }
  if (source.source === 'archive') return Object.freeze({ kind: 'archive' });
  if (
    source.source === 'github' ||
    source.source === 'url' ||
    source.source === 'git-subdir'
  ) {
    return Object.freeze({
      kind: source.source,
      ...(resolvedCommit === undefined ? {} : { commit: resolvedCommit }),
    });
  }
  throw new Error('Marketplace plugin source resolution is incomplete.');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
