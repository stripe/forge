import type {AgentPluginInstallationReceipt} from '../../contracts/plugin.js';
import type {MutableWorkspace, WorkspaceEntry} from '../../contracts/runtime.js';

const MAX_PLUGIN_FILES = 100_000;
const MAX_PLUGIN_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_TREE_BYTES = 256 * 1024 * 1024;

export async function assertInstalledPluginTree(
  state: MutableWorkspace,
  relativePath: string,
  signal: AbortSignal,
): Promise<void> {
  let entries: readonly WorkspaceEntry[];
  try {
    const root = await state.inspect(relativePath);
    if (root.kind !== 'directory') {
      throw new Error('Installed plugin root is not a directory.');
    }
    entries = await state.listFiles({
      under: relativePath,
      maxEntries: MAX_PLUGIN_FILES,
      signal,
    });
  } catch (error) {
    throw new Error('Forge could not inspect the installed plugin tree.', {
      cause: error,
    });
  }
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.kind !== 'file' && entry.kind !== 'directory')
  ) {
    throw new Error('Installed plugin tree contains an unsupported filesystem entry.');
  }

  const prefix = `${relativePath}/`;
  let fileCount = 0;
  let sizeBytes = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    if (!entry.path.startsWith(prefix)) {
      throw new Error('Installed plugin tree contains an invalid path.');
    }
    if (entry.kind === 'directory') {
      continue;
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size === undefined ||
      entry.size < 0 ||
      entry.size > MAX_PLUGIN_FILE_BYTES ||
      sizeBytes + entry.size > MAX_PLUGIN_TREE_BYTES
    ) {
      throw new Error('Installed plugin tree exceeds Forge byte limits.');
    }
    fileCount += 1;
    sizeBytes += entry.size;
  }
  if (fileCount === 0) {
    throw new Error('Installed plugin tree does not contain a regular file.');
  }
}

export function pluginSourceReceipt(
  source: unknown,
): AgentPluginInstallationReceipt['source'] {
  if (typeof source === 'string') return Object.freeze({kind: 'marketplace-path'});
  if (!isPlainRecord(source) || typeof source.source !== 'string') {
    throw new Error('Marketplace plugin source is malformed.');
  }
  if (
    source.source === 'archive' ||
    source.source === 'github' ||
    source.source === 'url' ||
    source.source === 'git-subdir'
  ) {
    return Object.freeze({kind: source.source});
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
