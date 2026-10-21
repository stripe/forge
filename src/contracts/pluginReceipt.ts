import { isSha256Digest } from '../model/hashes.ts';
import {
  isSafeGitHubRepository,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from '../model/paths.ts';
import type { AgentPluginInstallationReceipt } from './plugin.ts';

/** Validate and snapshot an adapter-produced plugin receipt at a trust boundary. */
export function parseAgentPluginInstallationReceipt(
  input: unknown,
): AgentPluginInstallationReceipt {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'adapter',
      'plugin',
      'marketplace',
      'marketplace_commit',
      'native_plugin_id',
      'version',
      'source',
      'installed_tree',
    ]) ||
    typeof input.adapter !== 'string' ||
    !isSafeSimpleIdentifier(input.adapter) ||
    typeof input.plugin !== 'string' ||
    !isQualifiedPluginId(input.plugin) ||
    typeof input.marketplace !== 'string' ||
    !isSafeGitHubRepository(input.marketplace) ||
    typeof input.marketplace_commit !== 'string' ||
    !isFullGitCommit(input.marketplace_commit) ||
    typeof input.native_plugin_id !== 'string' ||
    !isQualifiedPluginId(input.native_plugin_id) ||
    typeof input.version !== 'string' ||
    !isSafeVersion(input.version)
  ) {
    throw new TypeError('Agent plugin installation receipt is invalid.');
  }
  return Object.freeze({
    adapter: input.adapter,
    plugin: input.plugin,
    marketplace: input.marketplace,
    marketplace_commit: input.marketplace_commit,
    native_plugin_id: input.native_plugin_id,
    version: input.version,
    source: parsePluginSourceReceipt(input.source),
    installed_tree: parseInstalledPluginTree(input.installed_tree),
  });
}

function parsePluginSourceReceipt(
  input: unknown,
): AgentPluginInstallationReceipt['source'] {
  if (
    !isPlainRecord(input) ||
    (input.kind !== 'marketplace-path' &&
      input.kind !== 'archive' &&
      input.kind !== 'github' &&
      input.kind !== 'url' &&
      input.kind !== 'git-subdir')
  ) {
    throw new TypeError('Agent plugin source receipt is invalid.');
  }
  if (hasExactKeys(input, ['kind'])) {
    return Object.freeze({ kind: input.kind });
  }
  if (
    (input.kind === 'github' ||
      input.kind === 'url' ||
      input.kind === 'git-subdir') &&
    hasExactKeys(input, ['kind', 'commit']) &&
    typeof input.commit === 'string' &&
    isFullGitCommit(input.commit)
  ) {
    return Object.freeze({ kind: input.kind, commit: input.commit });
  }
  throw new TypeError('Agent plugin source receipt is invalid.');
}

function isQualifiedPluginId(value: string): boolean {
  const separator = value.indexOf('@');
  return (
    separator > 0 &&
    separator === value.lastIndexOf('@') &&
    isSafeSimpleIdentifier(value.slice(0, separator)) &&
    isSafeSimpleIdentifier(value.slice(separator + 1))
  );
}

function parseInstalledPluginTree(
  input: unknown,
): AgentPluginInstallationReceipt['installed_tree'] {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'format',
      'sha256',
      'entry_count',
      'file_count',
      'size_bytes',
    ]) ||
    input.format !== 'forge-plugin-tree-v1' ||
    typeof input.sha256 !== 'string' ||
    !isSha256Digest(input.sha256) ||
    !isPositiveSafeInteger(input.entry_count) ||
    !isPositiveSafeInteger(input.file_count) ||
    input.file_count > input.entry_count ||
    !isNonnegativeSafeInteger(input.size_bytes)
  ) {
    throw new TypeError('Installed plugin tree receipt is invalid.');
  }
  return Object.freeze({
    format: input.format,
    sha256: input.sha256,
    entry_count: input.entry_count,
    file_count: input.file_count,
    size_bytes: input.size_bytes,
  });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const allowed = new Set(expected);
  const keys = Reflect.ownKeys(input);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        allowed.has(key) &&
        Object.getOwnPropertyDescriptor(input, key)?.enumerable === true,
    ) &&
    expected.every((key) => Object.hasOwn(input, key))
  );
}

function isFullGitCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
