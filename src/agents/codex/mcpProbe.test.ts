import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { createMemoryWorkspace } from '../../testing/memoryWorkspace.ts';
import { CODEX_HOME_STATE_ID } from './layout.ts';
import { CODEX_MCP_PROBE_EXIT, CODEX_MCP_PROBE_SCRIPT } from './mcpProbe.ts';
import { createCodexPluginInstaller } from './plugins.ts';

const connected = {
  pluginId: 'fixture@test',
  name: 'stripe',
  serverInfo: { name: 'fixture', version: '1' },
  authStatus: 'bearerToken',
  tools: { probe: { name: 'probe', inputSchema: { type: 'object' } } },
};

async function probe(pages: readonly unknown[]) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const lines = new EventEmitter();
  const messages: { method: string; params: { cursor?: string } }[] = [];
  let page = 0;
  let killed = false;
  const exitCode = await new Promise<number>((resolve) => {
    runInNewContext(CODEX_MCP_PROBE_SCRIPT, {
      require(name: string) {
        if (name === 'node:readline') return { createInterface: () => lines };
        assert.equal(name, 'node:child_process');
        return {
          spawn: () =>
            Object.assign(child, {
              stdout,
              kill() {
                killed = true;
              },
              stdin: Object.assign(new EventEmitter(), {
                write(line: string) {
                  const message = JSON.parse(line);
                  messages.push(message);
                  if (message.id === undefined) return;
                  const result =
                    message.method === 'initialize' ? {} : pages[page++];
                  queueMicrotask(() =>
                    lines.emit(
                      'line',
                      JSON.stringify({ id: message.id, result }),
                    ),
                  );
                },
              }),
            }),
        };
      },
      process: {
        argv: ['node', 'codex', 'fixture@test', '["stripe"]'],
        set exitCode(value: number) {
          resolve(value);
        },
      },
      setTimeout,
      clearTimeout,
    });
  });
  assert.ok(killed);
  assert.ok(
    messages.every(({ method }) =>
      ['initialize', 'initialized', 'mcpServerStatus/list'].includes(method),
    ),
  );
  return { exitCode, messages };
}

describe('Codex MCP native status probe', () => {
  it('reports generated probe outcomes through the installer using shared codes', async () => {
    const installer = createCodexPluginInstaller({
      adapterId: 'codex',
      executable: 'codex',
    });
    for (const [data, expectedCode, reason] of [
      [
        [],
        CODEX_MCP_PROBE_EXIT.serverUnavailable,
        'plugin server missing or disconnected',
      ],
      [
        [{ ...connected, authStatus: 'notLoggedIn' }],
        CODEX_MCP_PROBE_EXIT.authenticationUnavailable,
        'bearer authentication unavailable',
      ],
      [
        [{ ...connected, tools: {} }],
        CODEX_MCP_PROBE_EXIT.toolsUnavailable,
        'no usable tools discovered',
      ],
      [null, CODEX_MCP_PROBE_EXIT.discoveryFailed, 'native discovery failed'],
    ] as const) {
      const result = await probe([{ data, nextCursor: null }]);
      assert.equal(result.exitCode, expectedCode);
      await assert.rejects(
        installer.checkMcp!({
          receipt: {
            version: '1',
            adapter: 'codex',
            plugin: 'fixture@test',
            marketplace: 'example/plugins',
            marketplace_commit: 'a'.repeat(40),
            native_plugin_id: 'fixture@test',
            source: { kind: 'marketplace-path' },
            installed_tree: {
              format: 'forge-plugin-tree-v1',
              sha256: `sha256:${'b'.repeat(64)}`,
              entry_count: 1,
              file_count: 1,
              size_bytes: 1,
            },
          },
          servers: ['stripe'],
          stateDirectories: new Map([
            [CODEX_HOME_STATE_ID, createMemoryWorkspace().mutable],
          ]),
          signal: new AbortController().signal,
          commands: {
            async run() {
              return {
                ...result,
                stdout: 'untrusted native details',
                stderr: '',
                durationMs: 0,
              };
            },
          },
        }),
        (error) => {
          assert.equal(
            (error as Error).message,
            `Codex MCP readiness failed: ${reason}.`,
          );
          return true;
        },
      );
    }
  });

  it('finds the requested plugin server on a later status page', async () => {
    const result = await probe([
      {
        data: Array.from({ length: 100 }, (_, i) => ({
          ...connected,
          name: `other-${i}`,
        })),
        nextCursor: 'next',
      },
      { data: [connected], nextCursor: null },
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.messages.at(-1)?.params.cursor, 'next');
  });

  for (const [name, pages, exitCode] of [
    ['missing server', [{ data: [], nextCursor: null }], 2],
    [
      'duplicate identity',
      [
        { data: [connected], nextCursor: 'next' },
        { data: [connected], nextCursor: null },
      ],
      2,
    ],
    [
      'failed authentication',
      [
        {
          data: [{ ...connected, authStatus: 'notLoggedIn' }],
          nextCursor: null,
        },
      ],
      3,
    ],
    ...['notLoggedIn', 'oAuth', 'unsupported'].map(
      (authStatus) =>
        [
          'unauthenticated server without connection metadata',
          [
            {
              data: [{ ...connected, serverInfo: null, authStatus }],
              nextCursor: null,
            },
          ],
          3,
        ] as const,
    ),
    [
      'failed discovery',
      [{ data: [{ ...connected, serverInfo: null }], nextCursor: null }],
      2,
    ],
    [
      'repeated cursor',
      [
        { data: [], nextCursor: 'same' },
        { data: [], nextCursor: 'same' },
      ],
      1,
    ],
    ['malformed page', [{ data: {}, nextCursor: null }], 1],
    ...[{}, [], null].map(
      (tools) =>
        [
          'empty or malformed tool surface',
          [{ data: [{ ...connected, tools }], nextCursor: null }],
          4,
        ] as const,
    ),
    [
      'wrong plugin namespace',
      [{ data: [{ ...connected, pluginId: 'other@test' }], nextCursor: null }],
      2,
    ],
  ] as const)
    it(`rejects ${name}`, async () => {
      assert.equal((await probe(pages)).exitCode, exitCode);
    });
});
