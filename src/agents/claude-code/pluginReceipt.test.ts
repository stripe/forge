import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {MutableWorkspace, WorkspaceEntry} from '../../contracts/runtime.js';
import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';
import {inspectInstalledPluginTree} from './pluginReceipt.js';

describe('Claude installed plugin snapshots', () => {
  const signal = new AbortController().signal;

  it('hashes a stable path order independently of the adapter listing order', async () => {
    const state = createMemoryWorkspace({
      'plugin/.claude-plugin/plugin.json': '{"name":"example"}',
      'plugin/A.txt': 'uppercase',
      'plugin/a.txt': 'lowercase',
    });
    const first = await inspectInstalledPluginTree(state.mutable, 'plugin', signal);
    const reversed = await inspectInstalledPluginTree({
      ...state.mutable,
      async listFiles(options) {
        return Object.freeze([...(await state.mutable.listFiles(options))].reverse());
      },
    }, 'plugin', signal);
    assert.deepEqual(first, reversed);
    assert.match(first.sha256, /^sha256:[a-f0-9]{64}$/);
  });

  it('distinguishes different installed contents under the same version', async () => {
    const first = createMemoryWorkspace({'plugin/1.0.0/a.txt': 'first'});
    const changed = createMemoryWorkspace({'plugin/1.0.0/a.txt': 'other'});
    const before = await inspectInstalledPluginTree(first.mutable, 'plugin/1.0.0', signal);
    const after = await inspectInstalledPluginTree(changed.mutable, 'plugin/1.0.0', signal);
    assert.notEqual(before.sha256, after.sha256);
    assert.equal(before.file_count, after.file_count);
    assert.equal(before.size_bytes, after.size_bytes);
  });

  it('hashes the bytes actually returned by file reads', async () => {
    const oldState = createMemoryWorkspace({'plugin/a.txt': 'old'});
    const newState = createMemoryWorkspace({'plugin/a.txt': 'new'});
    const actual = await inspectInstalledPluginTree({
      ...oldState.mutable,
      async readFile() {return Buffer.from('new');},
    }, 'plugin', signal);
    const expected = await inspectInstalledPluginTree(newState.mutable, 'plugin', signal);
    assert.deepEqual(actual, expected);
  });

  it('rejects a file whose size changes after listing', async () => {
    await assert.rejects(inspectInstalledPluginTree(inventory([
      {path: 'plugin/a.txt', kind: 'file', size: 4},
    ], Buffer.from('new')), 'plugin', signal), /changed while Forge inspected/);
  });

  it('requires an installed directory with regular files', async () => {
    for (const state of [
      createMemoryWorkspace(),
      createMemoryWorkspace({'plugin': 'file'}),
    ]) {
      await assert.rejects(
        inspectInstalledPluginTree(state.mutable, 'plugin', signal),
        /could not inspect/,
      );
    }
    await assert.rejects(
      inspectInstalledPluginTree(inventory([{path: 'plugin/empty', kind: 'directory'}]),
        'plugin', signal),
      /does not contain a regular file/,
    );
  });

  it('rejects symlinks, special entries, and paths outside the plugin', async () => {
    for (const kind of ['symlink', 'other'] as const) {
      await assert.rejects(
        inspectInstalledPluginTree(inventory([{path: 'plugin/entry', kind}]), 'plugin', signal),
        /unsupported filesystem entry/,
      );
    }
    await assert.rejects(
      inspectInstalledPluginTree(inventory([{path: 'another/file', kind: 'file', size: 1}]),
        'plugin', signal),
      /invalid path/,
    );
  });

  it('enforces file and aggregate byte limits from the inventory', async () => {
    for (const size of [undefined, -1, Number.NaN, 64 * 1024 * 1024 + 1]) {
      await assert.rejects(
        inspectInstalledPluginTree(inventory([{
          path: 'plugin/file', kind: 'file', ...(size === undefined ? {} : {size}),
        }]),
          'plugin', signal),
        /byte limits/,
      );
    }
    const body = new Uint8Array(1024 * 1024);
    const files = Array.from({length: 257}, (_, index): WorkspaceEntry => ({
      path: `plugin/file-${index}`, kind: 'file', size: body.byteLength,
    }));
    await assert.rejects(inspectInstalledPluginTree(inventory(files, body), 'plugin', signal),
      /byte limits/);
  });

  it('enforces the entry limit when an adapter ignores its requested bound', async () => {
    const entries = new Array<WorkspaceEntry>(100_001).fill({
      path: 'plugin/a.txt', kind: 'file', size: 1,
    });
    await assert.rejects(inspectInstalledPluginTree(inventory(entries), 'plugin', signal),
      /entry limits/);
  });
});

function inventory(
  entries: readonly WorkspaceEntry[],
  body: Uint8Array = new Uint8Array(),
): MutableWorkspace {
  return {
    async inspect(path) {return {path, kind: 'directory'};},
    async listFiles(options) {
      assert.equal(options?.maxEntries, 100_000);
      return entries;
    },
    async readFile() {return body;},
    async writeFile() {assert.fail('Inspection cannot mutate plugin state.');},
  };
}
