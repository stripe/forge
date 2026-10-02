import {
  isSafeGitHubRepository,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from '../model/paths.js';
import type {AgentPluginInstallationReceipt} from './plugin.js';

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
      'native_plugin_id',
      'version',
      'source',
    ]) ||
    typeof input.adapter !== 'string' ||
    !isSafeSimpleIdentifier(input.adapter) ||
    typeof input.plugin !== 'string' ||
    !isQualifiedPluginId(input.plugin) ||
    typeof input.marketplace !== 'string' ||
    !isSafeGitHubRepository(input.marketplace) ||
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
    native_plugin_id: input.native_plugin_id,
    version: input.version,
    source: parsePluginSourceReceipt(input.source),
  });
}

function parsePluginSourceReceipt(
  input: unknown,
): AgentPluginInstallationReceipt['source'] {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['kind']) ||
    (input.kind !== 'marketplace-path' &&
      input.kind !== 'archive' &&
      input.kind !== 'github' &&
      input.kind !== 'url' &&
      input.kind !== 'git-subdir')
  ) {
    throw new TypeError('Agent plugin source receipt is invalid.');
  }
  return Object.freeze({kind: input.kind});
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
