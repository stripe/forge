import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  type MutableWorkspace,
  WorkspaceEntryLimitError,
} from '../src/contracts/runtime.ts';
import { collectJudgeWorkspaceEvidence } from '../src/evaluation/judgeWorkspace.ts';
import { createOwnedWorkspace } from '../src/runtime/workspace.ts';
import { createMemoryWorkspace } from '../src/testing/memoryWorkspace.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe.each(['owned', 'memory'] as const)(
  '%s workspace listing contract',
  (kind) => {
    async function workspace(): Promise<MutableWorkspace> {
      if (kind === 'memory') return createMemoryWorkspace().mutable;
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-list-contract-'),
      );
      roots.push(root);
      return createOwnedWorkspace(root);
    }

    it('retains the same shallowest subset at each entry limit and sorts the result', async () => {
      const view = await workspace();
      for (const file of [
        'a/deep/nested.ts',
        'a/b.ts',
        'a.ts/deep/nested.ts',
        'a.ts/b.ts',
        'node_modules/pkg/ignored.js',
        'z.ts',
      ]) {
        await view.writeFile(file, Buffer.from('source'));
      }
      const retentionOrder = [
        'a',
        'a.ts',
        'z.ts',
        'a.ts/b.ts',
        'a.ts/deep',
        'a/b.ts',
        'a/deep',
        'a.ts/deep/nested.ts',
        'a/deep/nested.ts',
      ];
      for (
        let maxEntries = 1;
        maxEntries < retentionOrder.length;
        maxEntries += 1
      ) {
        await assert.rejects(
          view.listFiles({
            maxEntries,
            excludeDirectoryNames: ['node_modules'],
          }),
          (error) => {
            assert.ok(error instanceof WorkspaceEntryLimitError);
            assert.equal(error.maxEntries, maxEntries);
            assert.deepEqual(
              error.entries.map(({ path }) => path),
              retentionOrder.slice(0, maxEntries).sort(),
            );
            return true;
          },
        );
      }
      assert.deepEqual(
        (
          await view.listFiles({
            maxEntries: retentionOrder.length,
            excludeDirectoryNames: ['node_modules'],
          })
        ).map(({ path }) => path),
        [...retentionOrder].sort(),
      );
      await assert.rejects(
        view.listFiles({ under: 'a', maxEntries: 2 }),
        (error) => {
          assert.ok(error instanceof WorkspaceEntryLimitError);
          assert.deepEqual(
            error.entries.map(({ path }) => path),
            ['a/b.ts', 'a/deep'],
          );
          return true;
        },
      );
    });

    it('warns when shallow directories consume the budget before any file', async () => {
      const view = await workspace();
      for (const file of ['a/app.ts', 'b/app.ts', 'c/app.ts']) {
        await view.writeFile(file, Buffer.from('source'));
      }
      await assert.rejects(view.listFiles({ maxEntries: 2 }), (error) => {
        assert.ok(error instanceof WorkspaceEntryLimitError);
        assert.deepEqual(error.entries, [
          { path: 'a', kind: 'directory' },
          { path: 'b', kind: 'directory' },
        ]);
        return true;
      });
      const collected = await collectJudgeWorkspaceEvidence(view, {
        maxEntries: 2,
      });
      assert.deepEqual(collected.evidence.entries, []);
      assert.equal(collected.evidence.complete, false);
      assert.equal(collected.evidence.truncated, true);
      assert.match(
        collected.renderedText,
        /listing was truncated.*entry limit of 2/,
      );
    });

    it('rejects invalid exclusion names without copying their values into errors', async () => {
      const view = await workspace();
      const invalid: unknown[] = [
        [''],
        ['.'],
        ['..'],
        ['a/b'],
        ['a\\b'],
        ['a\0b'],
        [1],
        [null],
        'node_modules',
        null,
        new Array(1),
      ];
      for (const names of invalid) {
        await assert.rejects(
          view.listFiles({ excludeDirectoryNames: names as readonly string[] }),
          (error) => {
            assert.ok(error instanceof TypeError);
            assert.match(error.message, /^excludeDirectoryNames must /);
            assert.doesNotMatch(error.message, /a\/b|a\\b|node_modules/);
            return true;
          },
        );
      }
    });
  },
);
