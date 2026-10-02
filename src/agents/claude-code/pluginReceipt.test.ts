import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {MutableWorkspace, WorkspaceEntry} from '../../contracts/runtime.js';
import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';
import {assertInstalledPluginTree} from './pluginReceipt.js';

describe('Claude installed plugin inspection', () => {
  const signal = new AbortController().signal;

  it('checks the installed inventory without reading file contents', async () => {
    const state = createMemoryWorkspace({
      'plugin/.claude-plugin/plugin.json': '{"name":"example"}',
      'plugin/commands/run.sh': 'echo ready',
    });
    await assertInstalledPluginTree({
      ...state.mutable,
      async readFile() {
        assert.fail('Plugin inspection must not read bytes solely to fingerprint them.');
      },
    }, 'plugin', signal);
  });

  it('requires an installed directory with regular files', async () => {
    for (const state of [
      createMemoryWorkspace(),
      createMemoryWorkspace({'plugin': 'file'}),
    ]) {
      await assert.rejects(
        assertInstalledPluginTree(state.mutable, 'plugin', signal),
        /could not inspect/,
      );
    }
    await assert.rejects(
      assertInstalledPluginTree(inventory([{path: 'plugin/empty', kind: 'directory'}]),
        'plugin', signal),
      /does not contain a regular file/,
    );
  });

  it('rejects symlinks, special entries, and paths outside the plugin', async () => {
    for (const kind of ['symlink', 'other'] as const) {
      await assert.rejects(
        assertInstalledPluginTree(inventory([{path: 'plugin/entry', kind}]), 'plugin', signal),
        /unsupported filesystem entry/,
      );
    }
    await assert.rejects(
      assertInstalledPluginTree(inventory([{path: 'another/file', kind: 'file', size: 1}]),
        'plugin', signal),
      /invalid path/,
    );
  });

  it('enforces file and aggregate byte limits from the inventory', async () => {
    for (const size of [undefined, -1, Number.NaN, 64 * 1024 * 1024 + 1]) {
      await assert.rejects(
        assertInstalledPluginTree(inventory([{
          path: 'plugin/file', kind: 'file', ...(size === undefined ? {} : {size}),
        }]),
          'plugin', signal),
        /byte limits/,
      );
    }
    const files = Array.from({length: 5}, (_, index): WorkspaceEntry => ({
      path: `plugin/file-${index}`, kind: 'file', size: 64 * 1024 * 1024,
    }));
    await assert.rejects(assertInstalledPluginTree(inventory(files), 'plugin', signal),
      /byte limits/);
  });
});

function inventory(entries: readonly WorkspaceEntry[]): MutableWorkspace {
  return {
    async inspect(path) {return {path, kind: 'directory'};},
    async listFiles(options) {
      assert.equal(options?.maxEntries, 100_000);
      return entries;
    },
    async readFile() {assert.fail('Inventory checks do not read plugin contents.');},
    async writeFile() {assert.fail('Inspection cannot mutate plugin state.');},
  };
}
