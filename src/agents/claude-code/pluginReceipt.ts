import {createHash} from 'node:crypto';

import type {AgentPluginInstallationReceipt} from '../../contracts/plugin.js';
import type {MutableWorkspace, WorkspaceEntry} from '../../contracts/runtime.js';
import {serializeCanonicalJson} from '../../serialization.js';

const MAX_PLUGIN_FILES = 100_000;
const MAX_PLUGIN_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_TREE_BYTES = 256 * 1024 * 1024;

type InstalledPluginTree = AgentPluginInstallationReceipt['installed_tree'];

export async function inspectInstalledPluginTree(
  state: MutableWorkspace,
  relativePath: string,
  signal: AbortSignal,
): Promise<InstalledPluginTree> {
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

  const hash = createHash('sha256');
  hash.update('forge-plugin-tree-v1\n');
  const prefix = `${relativePath}/`;
  let fileCount = 0;
  let sizeBytes = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    if (!entry.path.startsWith(prefix)) {
      throw new Error('Installed plugin tree contains an invalid path.');
    }
    const pluginPath = entry.path.slice(prefix.length);
    if (entry.kind === 'directory') {
      hash.update(serializeCanonicalJson({kind: 'directory', path: pluginPath}));
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
    const body = await state.readFile(entry.path, {maxBytes: MAX_PLUGIN_FILE_BYTES});
    if (body.byteLength !== entry.size) {
      throw new Error('Installed plugin tree changed while Forge inspected it.');
    }
    fileCount += 1;
    sizeBytes += body.byteLength;
    hash.update(
      serializeCanonicalJson({
        kind: 'file',
        path: pluginPath,
        sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        size_bytes: body.byteLength,
      }),
    );
  }
  if (fileCount === 0) {
    throw new Error('Installed plugin tree does not contain a regular file.');
  }
  return Object.freeze({
    format: 'forge-plugin-tree-v1',
    sha256: `sha256:${hash.digest('hex')}`,
    entry_count: entries.length,
    file_count: fileCount,
    size_bytes: sizeBytes,
  });
}

export function pluginSourceReceipt(
  source: unknown,
  resolvedCommit: string | undefined,
): AgentPluginInstallationReceipt['source'] {
  if (typeof source === 'string') return Object.freeze({kind: 'marketplace-path'});
  if (!isPlainRecord(source) || typeof source.source !== 'string') {
    throw new Error('Marketplace plugin source is malformed.');
  }
  if (source.source === 'archive') {
    return Object.freeze({
      kind: 'archive',
      ...(typeof source.sha256 === 'string'
        ? {sha256: `sha256:${source.sha256.toLowerCase()}` as const}
        : {}),
    });
  }
  if (
    (source.source === 'github' ||
      source.source === 'url' ||
      source.source === 'git-subdir') &&
    resolvedCommit !== undefined
  ) {
    return Object.freeze({kind: source.source, commit: resolvedCommit});
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
