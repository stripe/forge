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

  it('rejects undeclared, incomplete, and inconsistent fields', () => {
    assert.throws(() =>
      parseAgentPluginInstallationReceipt({...RECEIPT, unexpected: true}),
    );
    assert.throws(() =>
      parseAgentPluginInstallationReceipt({
        ...RECEIPT,
        source: {kind: 'git-subdir'},
      }),
    );
    assert.throws(() =>
      parseAgentPluginInstallationReceipt({
        ...RECEIPT,
        installed_tree: {
          ...RECEIPT.installed_tree,
          entry_count: 1,
          file_count: 2,
        },
      }),
    );
  });
});
