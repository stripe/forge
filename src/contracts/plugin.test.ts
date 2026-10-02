import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseAgentPluginInstallationReceipt} from './pluginReceipt.js';

const RECEIPT = {
  adapter: 'claude-code',
  plugin: 'stripe@claude-plugins-official',
  marketplace: 'anthropics/claude-plugins-official',
  native_plugin_id: 'stripe@forge-test',
  version: '0.9.2',
  source: {kind: 'git-subdir'},
} as const;

describe('plugin installation receipts', () => {
  it('strictly snapshots a complete public resolution', () => {
    const input = structuredClone(RECEIPT);
    const parsed = parseAgentPluginInstallationReceipt(input);

    assert.deepEqual(parsed, RECEIPT);
    assert.notEqual(parsed, input);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.source));
  });

  it('accepts each supported source kind without unused digest metadata', () => {
    for (const kind of ['marketplace-path', 'archive', 'github', 'url', 'git-subdir']) {
      assert.deepEqual(parseAgentPluginInstallationReceipt({
        ...RECEIPT, source: {kind},
      }).source, {kind});
    }
  });

  it('rejects undeclared fields and retired hash metadata', () => {
    for (const input of [
      {...RECEIPT, unexpected: true},
      {...RECEIPT, marketplace_commit: 'a'.repeat(40)},
      {...RECEIPT, installed_tree: {}},
      {...RECEIPT, source: {kind: 'git-subdir', commit: 'b'.repeat(40)}},
      {...RECEIPT, source: {kind: 'archive', sha256: `sha256:${'c'.repeat(64)}`}},
      {...RECEIPT, source: {kind: 'unsupported'}},
      {...RECEIPT, source: {}},
      {...RECEIPT, version: undefined},
    ]) {
      assert.throws(() => parseAgentPluginInstallationReceipt(input));
    }
  });
});
