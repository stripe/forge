import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';
import {inspectInstalledPluginTree} from './pluginReceipt.js';

describe('Claude plugin receipts', () => {
  it('identifies the stable installed content tree independently of insertion order', async () => {
    const first = createMemoryWorkspace({
      'plugin/z.txt': 'last',
      'plugin/a.txt': 'first',
    });
    const second = createMemoryWorkspace({
      'plugin/a.txt': 'first',
      'plugin/z.txt': 'last',
    });
    const changed = createMemoryWorkspace({
      'plugin/a.txt': 'changed',
      'plugin/z.txt': 'last',
    });
    const signal = new AbortController().signal;

    const firstReceipt = await inspectInstalledPluginTree(
      first.mutable,
      'plugin',
      signal,
    );
    const secondReceipt = await inspectInstalledPluginTree(
      second.mutable,
      'plugin',
      signal,
    );
    const changedReceipt = await inspectInstalledPluginTree(
      changed.mutable,
      'plugin',
      signal,
    );

    assert.deepEqual(firstReceipt, secondReceipt);
    assert.notEqual(firstReceipt.sha256, changedReceipt.sha256);
    assert.deepEqual(
      {
        entry_count: firstReceipt.entry_count,
        file_count: firstReceipt.file_count,
        size_bytes: firstReceipt.size_bytes,
      },
      {entry_count: 2, file_count: 2, size_bytes: 9},
    );
  });
});
