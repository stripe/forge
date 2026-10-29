import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { CODEX_MCP_PROBE_SCRIPT } from './mcpProbe.ts';

const connected = {
  pluginId: 'fixture@test',
  name: 'stripe',
  serverInfo: { name: 'fixture', version: '1' },
  authStatus: 'bearerToken',
  tools: {},
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

  for (const [name, pages] of [
    ['missing server', [{ data: [], nextCursor: null }]],
    [
      'duplicate identity',
      [
        { data: [connected], nextCursor: 'next' },
        { data: [connected], nextCursor: null },
      ],
    ],
    [
      'failed authentication',
      [
        {
          data: [{ ...connected, authStatus: 'notLoggedIn' }],
          nextCursor: null,
        },
      ],
    ],
    [
      'failed discovery',
      [{ data: [{ ...connected, serverInfo: null }], nextCursor: null }],
    ],
    [
      'repeated cursor',
      [
        { data: [], nextCursor: 'same' },
        { data: [], nextCursor: 'same' },
      ],
    ],
    ['malformed page', [{ data: {}, nextCursor: null }]],
  ] as const)
    it(`rejects ${name}`, async () => {
      assert.equal((await probe(pages)).exitCode, 1);
    });
});
