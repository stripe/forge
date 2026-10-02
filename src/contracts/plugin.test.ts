import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseAgentPluginInstallationReceipt} from './pluginReceipt.js';

const RECEIPT = {
  adapter: 'claude-code',
  plugin: 'stripe@claude-plugins-official',
  marketplace: 'anthropics/claude-plugins-official',
  marketplace_commit: 'a'.repeat(40),
  native_plugin_id: 'stripe@forge-test',
  version: '0.9.2',
  source: {kind: 'git-subdir', commit: 'b'.repeat(40)},
  installed_tree: {
    format: 'forge-plugin-tree-v1',
    sha256: `sha256:${'c'.repeat(64)}`,
    entry_count: 2,
    file_count: 1,
    size_bytes: 42,
  },
} as const;

describe('plugin installation receipts', () => {
  it('strictly snapshots a complete public resolution', () => {
    const input = structuredClone(RECEIPT);
    const parsed = parseAgentPluginInstallationReceipt(input);

    assert.deepEqual(parsed, RECEIPT);
    assert.notEqual(parsed, input);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.source));
    assert.ok(Object.isFrozen(parsed.installed_tree));
  });

  it('accepts each supported source kind when no source commit is reported', () => {
    for (const kind of ['marketplace-path', 'archive', 'github', 'url', 'git-subdir']) {
      assert.deepEqual(parseAgentPluginInstallationReceipt({
        ...RECEIPT, source: {kind},
      }).source, {kind});
    }
  });

  it('preserves an observed full Git commit for each Git source kind', () => {
    for (const kind of ['github', 'url', 'git-subdir']) {
      const source = {kind, commit: 'd'.repeat(40)};
      assert.deepEqual(parseAgentPluginInstallationReceipt({...RECEIPT, source}).source, source);
    }
  });

  it('rejects malformed observed commits and unsupported source metadata', () => {
    for (const input of [
      {...RECEIPT, unexpected: true},
      {...RECEIPT, marketplace_commit: 'a'.repeat(39)},
      {...RECEIPT, marketplace_commit: 'A'.repeat(40)},
      {...RECEIPT, marketplace_commit: undefined},
      {...RECEIPT, installed_tree: {}},
      {...RECEIPT, source: {kind: 'git-subdir', commit: 'not-a-commit'}},
      {...RECEIPT, source: {kind: 'git-subdir', commit: 'B'.repeat(40)}},
      {...RECEIPT, source: {kind: 'marketplace-path', commit: 'b'.repeat(40)}},
      {...RECEIPT, source: {kind: 'archive', commit: 'b'.repeat(40)}},
      {...RECEIPT, source: {kind: 'archive', sha256: `sha256:${'c'.repeat(64)}`}},
      {...RECEIPT, source: {kind: 'unsupported'}},
      {...RECEIPT, source: {}},
      {...RECEIPT, version: undefined},
    ]) {
      assert.throws(() => parseAgentPluginInstallationReceipt(input));
    }
  });

  it('requires a strict, bounded installed-tree fingerprint description', () => {
    for (const installed_tree of [
      {...RECEIPT.installed_tree, format: 'unsupported'},
      {...RECEIPT.installed_tree, sha256: 'invalid'},
      {...RECEIPT.installed_tree, entry_count: 0},
      {...RECEIPT.installed_tree, file_count: 0},
      {...RECEIPT.installed_tree, file_count: 3},
      {...RECEIPT.installed_tree, size_bytes: -1},
      {...RECEIPT.installed_tree, extra: true},
    ]) {
      assert.throws(() => parseAgentPluginInstallationReceipt({...RECEIPT, installed_tree}));
    }
  });
});
