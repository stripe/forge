import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  CodexStreamError,
  isSafeCodexSessionId,
  parseCodexStream,
} from './stream.ts';

const SESSION_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const OTHER_SESSION_ID = '0199a213-81c0-7800-8aa1-bbab2a035a54';
const started = { type: 'thread.started', thread_id: SESSION_ID };
const turnStarted = { type: 'turn.started' };
const completed = {
  type: 'turn.completed',
  usage: {
    input_tokens: 24763,
    cached_input_tokens: 24448,
    output_tokens: 122,
  },
};

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function stream(...events: unknown[]): string {
  return jsonl(started, turnStarted, ...events, completed);
}

function item(
  type: string,
  fields: Record<string, unknown>,
  phase = 'completed',
): unknown {
  return { type: `item.${phase}`, item: { id: 'item_1', type, ...fields } };
}

function assertInvalid(
  stdout: string,
  expectedSessionId?: string,
): CodexStreamError {
  let captured: CodexStreamError | undefined;
  assert.throws(
    () => parseCodexStream(stdout, expectedSessionId),
    (error: unknown) => {
      assert.ok(error instanceof CodexStreamError);
      assert.equal(error.code, 'invalid_codex_stream');
      assert.equal(error.name, 'CodexStreamError');
      captured = error;
      return true;
    },
  );
  assert.ok(captured);
  return captured;
}

describe('Codex exec stream', () => {
  it('accepts the pinned CLI model-metadata advisory only for the selected model before the turn', () => {
    const notice = (model: string) =>
      `Model metadata for \`${model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;
    const advisory = (message: string) => ({
      type: 'item.completed',
      item: { id: 'item_0', type: 'error', message },
    });
    const answer = item('agent_message', { id: 'item_1', text: 'ok' });
    const accepted = jsonl(
      started,
      advisory(notice('gpt-6.1-sol')),
      turnStarted,
      answer,
      completed,
    );
    assert.equal(
      parseCodexStream(accepted, undefined, { model: 'gpt-6.1-sol' }).text,
      'ok',
    );
    // Not tolerated without the selected model, for another model, or mid-turn.
    assertInvalid(accepted);
    for (const [events, model] of [
      [
        [
          started,
          advisory(notice('gpt-6.1-sol')),
          turnStarted,
          answer,
          completed,
        ],
        'gpt-5.4',
      ],
      [
        [started, turnStarted, advisory(notice('gpt-6.1-sol')), completed],
        'gpt-6.1-sol',
      ],
    ] as const)
      assert.throws(
        () => parseCodexStream(jsonl(...events), undefined, { model }),
        CodexStreamError,
      );
  });

  it('accepts only captured pre-turn hook automation and ignored-provider advisories for the selected invocation', () => {
    const warning =
      '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.';
    const advisory = (id: string, message = warning) => ({
      type: 'item.completed',
      item: { id, type: 'error', message },
    });
    const answer = item('agent_message', { id: 'item_3', text: 'Done' });
    const stdout = jsonl(
      started,
      advisory('item_0'),
      advisory('item_1'),
      turnStarted,
      answer,
      completed,
    );
    assert.equal(
      parseCodexStream(stdout, undefined, { hookAutomation: true }).text,
      'Done',
    );
    assert.equal(
      parseCodexStream(stdout, SESSION_ID, { hookAutomation: true }).sessionId,
      SESSION_ID,
    );
    assertInvalid(stdout);
    for (const events of [
      [advisory('item_0'), started, turnStarted, completed],
      [started, turnStarted, advisory('item_0'), completed],
      [
        started,
        advisory('item_0', 'synthetic-secret failed'),
        turnStarted,
        completed,
      ],
      [started, advisory('item_0'), advisory('item_0'), turnStarted, completed],
      [
        started,
        advisory('item_0'),
        turnStarted,
        item('agent_message', { id: 'item_0', text: 'collision' }),
        completed,
      ],
    ])
      assert.throws(
        () =>
          parseCodexStream(jsonl(...events), undefined, {
            hookAutomation: true,
          }),
        CodexStreamError,
      );
    const ignoredProvider =
      'Ignored unsupported project-local config keys in /workspace/.codex/config.toml: model_providers. If you want these settings to apply, manually set them in your user-level config.toml.';
    const configured = jsonl(
      started,
      advisory('item_0', ignoredProvider),
      turnStarted,
      answer,
      completed,
    );
    assert.equal(
      parseCodexStream(configured, undefined, { workspacePath: '/workspace' })
        .text,
      'Done',
    );
    assertInvalid(configured);
  });
  it('parses the documented JSONL invocation with an exact UUID session', () => {
    const stdout = jsonl(
      started,
      turnStarted,
      item(
        'command_execution',
        { command: 'bash -lc ls', status: 'in_progress' },
        'started',
      ),
      item('agent_message', {
        id: 'item_3',
        text: 'Repo contains docs and examples.',
      }),
      {
        ...completed,
        usage: { ...completed.usage, reasoning_output_tokens: 0 },
      },
    );
    assert.deepEqual(
      parseCodexStream(`\n${stdout.replaceAll('\n', '\r\n')}\r\n`),
      {
        text: 'Repo contains docs and examples.',
        sessionId: SESSION_ID,
        toolCalls: [
          {
            id: 'item_1',
            name: 'command_execution',
            input: { command: 'bash -lc ls' },
          },
        ],
      },
    );
  });

  it('retains the latest item snapshots once in first-seen order', () => {
    assert.deepEqual(
      parseCodexStream(
        stream(
          item('agent_message', { id: 'message_1', text: 'I will' }, 'started'),
          item(
            'command_execution',
            { command: 'pwd', status: 'in_progress' },
            'started',
          ),
          item(
            'agent_message',
            { id: 'message_1', text: 'I will inspect the project.' },
            'updated',
          ),
          item('reasoning', { id: 'reasoning_1', text: 'Private reasoning.' }),
          item('command_execution', {
            command: 'pwd',
            status: 'completed',
            aggregated_output: '/workspace\n',
            exit_code: 0,
          }),
          item('agent_message', {
            id: 'message_1',
            text: 'I will inspect the project.',
          }),
          item('agent_message', { id: 'message_2', text: 'Finished.' }),
          item('agent_message', { id: 'message_2', text: 'Finished.' }),
        ),
      ),
      {
        text: 'I will inspect the project.\n\nFinished.',
        sessionId: SESSION_ID,
        toolCalls: [
          {
            id: 'item_1',
            name: 'command_execution',
            input: { command: 'pwd' },
          },
        ],
      },
    );
  });

  it('accepts pinned Codex 0.149.0 initial and resume output with all emitted usage counters', () => {
    // Captured from the real pinned CLI against an offline synthetic Responses
    // endpoint. Both invocations start their item numbering at item_0.
    const first = jsonl(
      started,
      turnStarted,
      item('agent_message', { id: 'item_0', text: 'First response.' }),
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    );
    const resumed = jsonl(
      started,
      turnStarted,
      item('agent_message', { id: 'item_0', text: 'Second response.' }),
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 20,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    );
    const firstTurn = parseCodexStream(first);
    assert.deepEqual(firstTurn, {
      text: 'First response.',
      sessionId: SESSION_ID,
      toolCalls: [],
    });
    assert.deepEqual(parseCodexStream(resumed, firstTurn.sessionId), {
      text: 'Second response.',
      sessionId: SESSION_ID,
      toolCalls: [],
    });
    assertInvalid(resumed, OTHER_SESSION_ID);
  });

  it('accepts pinned CLI tool snapshots for patch add/update/delete, reasoning, and command output', () => {
    // The real offline CLI capture's temporary root is replaced by /workspace;
    // the event shapes, state transitions, and command results are retained.
    const changes = [
      [{ path: '/workspace/codex-tool.txt', kind: 'add' }],
      [
        { path: '/workspace/codex-tool.txt', kind: 'update' },
        { path: '/workspace/transient.txt', kind: 'add' },
      ],
      [{ path: '/workspace/transient.txt', kind: 'delete' }],
    ];
    const patchEvents = changes.flatMap((change, index) => [
      item(
        'file_change',
        { id: `item_${index + 1}`, changes: change, status: 'in_progress' },
        'started',
      ),
      item('file_change', {
        id: `item_${index + 1}`,
        changes: change,
        status: 'completed',
      }),
    ]);
    const command = "/bin/zsh -lc 'wc -c codex-tool.txt'";
    assert.deepEqual(
      parseCodexStream(
        jsonl(
          started,
          turnStarted,
          item('reasoning', {
            id: 'item_0',
            text: 'A synthetic reasoning summary for parser testing.',
          }),
          ...patchEvents,
          item(
            'command_execution',
            {
              id: 'item_4',
              command,
              aggregated_output: '',
              exit_code: null,
              status: 'in_progress',
            },
            'started',
          ),
          item('command_execution', {
            id: 'item_4',
            command,
            aggregated_output: '      27 codex-tool.txt\n',
            exit_code: 0,
            status: 'completed',
          }),
          item('agent_message', {
            id: 'item_5',
            text: 'Created codex-tool.txt and checked its size.',
          }),
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 50,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 25,
              reasoning_output_tokens: 0,
            },
          },
        ),
      ),
      {
        text: 'Created codex-tool.txt and checked its size.',
        sessionId: SESSION_ID,
        toolCalls: [
          ...changes.map((change, index) => ({
            id: `item_${index + 1}`,
            name: 'file_change',
            input: { changes: change },
          })),
          { id: 'item_4', name: 'command_execution', input: { command } },
        ],
      },
    );
  });

  it('captures the supported tool families without turning a tool failure into a turn failure', () => {
    const changes = [{ path: 'hello.txt', kind: 'add' }];
    const argumentsValue = { query: 'sample', nested: ['one', 2, null] };
    const action = { type: 'search', queries: ['example'] };
    const todos = [{ text: 'Run tests', completed: true }];
    const parsed = parseCodexStream(
      stream(
        item('file_change', { id: 'file', changes, status: 'completed' }),
        item('mcp_tool_call', {
          id: 'mcp',
          server: 'docs',
          tool: 'search',
          arguments: argumentsValue,
          result: {
            content: [{ type: 'text', text: 'Found it.' }],
            structured_content: { count: 1 },
          },
          error: null,
          status: 'completed',
        }),
        item('web_search', { id: 'web', query: 'example', action }),
        item(
          'todo_list',
          { id: 'todos', items: [{ text: 'Run tests', completed: false }] },
          'started',
        ),
        item('todo_list', { id: 'todos', items: todos }, 'updated'),
        item('command_execution', {
          id: 'command',
          command: 'false',
          aggregated_output: '',
          exit_code: 1,
          status: 'failed',
        }),
        item('mcp_tool_call', {
          id: 'failed-mcp',
          server: 'docs',
          tool: 'search',
          arguments: {},
          result: null,
          error: { message: 'Tool unavailable.' },
          status: 'failed',
        }),
      ),
    );
    assert.deepEqual(parsed.toolCalls, [
      { id: 'file', name: 'file_change', input: { changes } },
      { id: 'mcp', name: 'mcp__docs__search', input: argumentsValue },
      { id: 'web', name: 'web_search', input: { query: 'example', action } },
      { id: 'todos', name: 'todo_list', input: { items: todos } },
      { id: 'command', name: 'command_execution', input: { command: 'false' } },
      { id: 'failed-mcp', name: 'mcp__docs__search', input: {} },
    ]);
    assert.equal(parsed.text, '');
  });

  it('requires the exact resume identity and does not manufacture it from the requested ID', () => {
    assert.equal(parseCodexStream(stream(), SESSION_ID).sessionId, SESSION_ID);
    assertInvalid(stream(), OTHER_SESSION_ID);
    assertInvalid(jsonl(turnStarted, completed), SESSION_ID);
    assertInvalid(stream(), '../unsafe');
    assertInvalid(stream(), `${SESSION_ID}\n`);
    assertInvalid(stream(), SESSION_ID.toUpperCase());
  });

  it('accepts only UUID-shaped session IDs without normalizing their spelling', () => {
    assert.equal(isSafeCodexSessionId(SESSION_ID), true);
    assert.equal(isSafeCodexSessionId(SESSION_ID.toUpperCase()), true);
    for (const value of [
      '',
      '.',
      '..',
      '../session',
      'session-1',
      `${SESSION_ID}/x`,
      `${SESSION_ID}\0`,
      `${SESSION_ID}\n`,
      `${SESSION_ID}\r`,
      `${SESSION_ID}\r\n`,
    ]) {
      assert.equal(isSafeCodexSessionId(value), false);
      assertInvalid(
        jsonl({ ...started, thread_id: value }, turnStarted, completed),
      );
    }
    const uppercase = SESSION_ID.toUpperCase();
    assert.equal(
      parseCodexStream(
        jsonl({ ...started, thread_id: uppercase }, turnStarted, completed),
        uppercase,
      ).sessionId,
      uppercase,
    );
  });

  it('requires a single started and completed turn and rejects events outside it', () => {
    for (const stdout of [
      '',
      '\n',
      jsonl(started),
      jsonl(started, turnStarted),
      jsonl(started, completed),
      jsonl(
        started,
        turnStarted,
        item('agent_message', { text: 'Not terminal.' }),
      ),
      jsonl(turnStarted, started, completed),
      jsonl(started, started, turnStarted, completed),
      jsonl(started, turnStarted, turnStarted, completed),
      jsonl(
        started,
        item('agent_message', { text: 'Too early.' }),
        turnStarted,
        completed,
      ),
      `${stream()}\n${JSON.stringify(completed)}`,
      `${stream()}\n${JSON.stringify(item('agent_message', { text: 'Too late.' }))}`,
      `${stream()}\n${stream()}`,
    ])
      assertInvalid(stdout);
  });

  it('fails closed for unknown event or item types, fields, and changing item identities', () => {
    for (const event of [
      { type: 'thread.updated', thread_id: SESSION_ID },
      item('new_tool', { arguments: {} }),
      {
        type: 'item.completed',
        item: { id: 'new', type: 'agent_message', text: 'Done' },
        hidden: 'x',
      },
      item('agent_message', {
        text: 'Done',
        another_message: 'Unknown semantics',
      }),
    ])
      assertInvalid(stream(event));
    assertInvalid(
      stream(
        item('agent_message', { text: 'First' }, 'started'),
        item('command_execution', {
          command: 'echo changed',
          status: 'completed',
        }),
      ),
    );
    for (const phase of ['started', 'updated', 'completed']) {
      assertInvalid(
        stream(
          item('agent_message', { text: 'Already finished' }),
          item('agent_message', { text: 'Changed after completion' }, phase),
        ),
      );
    }
  });

  it('rejects malformed JSON, banners, payloads, statuses, and terminal usage', () => {
    for (const line of [
      'null',
      '[]',
      '7',
      '"text"',
      '{}',
      '{',
      'Codex banner',
      '{"type":',
    ]) {
      assertInvalid(
        `${jsonl(started, turnStarted)}\n${line}\n${JSON.stringify(completed)}`,
      );
    }
    for (const malformed of [
      item('agent_message', { text: null }),
      item('reasoning', { text: { secret: true } }),
      item('agent_message', { id: '../item', text: 'x' }),
      item('agent_message', { id: 'item_1\n', text: 'x' }),
      item('agent_message', { id: 'item_1\r', text: 'x' }),
      item('command_execution', { command: ['ls'], status: 'completed' }),
      item('command_execution', { command: 'ls', status: 'unknown' }),
      item('command_execution', {
        command: 'ls',
        status: 'completed',
        exit_code: 0.5,
      }),
      item('command_execution', {
        command: 'ls',
        status: 'completed',
        aggregated_output: [],
      }),
      item('file_change', {
        changes: [{ path: 'a', kind: 'rename' }],
        status: 'completed',
      }),
      item('mcp_tool_call', {
        server: 'docs',
        tool: 'search',
        status: 'completed',
      }),
      item('mcp_tool_call', {
        server: 'docs',
        tool: 'search',
        arguments: {},
        result: {},
        status: 'completed',
      }),
      item('web_search', { query: 'hello', action: [] }),
      item('todo_list', { items: [{ text: 'task', completed: 'yes' }] }),
    ])
      assertInvalid(stream(malformed));
    for (const usage of [
      null,
      {},
      { ...completed.usage, input_tokens: -1 },
      { ...completed.usage, cached_input_tokens: 0.5 },
      { ...completed.usage, output_tokens: '1' },
      { ...completed.usage, reasoning_output_tokens: null },
      { ...completed.usage, cache_write_input_tokens: -1 },
      { ...completed.usage, cache_write_input_tokens: '0' },
    ])
      assertInvalid(jsonl(started, turnStarted, { ...completed, usage }));
    assertInvalid(
      stream(
        item('mcp_tool_call', {
          server: 'docs',
          tool: 'search',
          arguments: 'NONFINITE',
          status: 'completed',
        }),
      ).replace('"NONFINITE"', '1e400'),
    );
  });

  it('never includes raw event or provider error details in failures', () => {
    const secret = 'provider-key-never-print-this';
    for (const stdout of [
      stream({ type: 'error', message: secret }),
      stream({ type: 'turn.failed', error: { message: secret } }),
      stream(item('error', { message: secret })),
      stream({ type: secret }),
      stream(item(secret, { text: secret })),
      jsonl({ ...started, thread_id: secret }, turnStarted, completed),
      `${stream()}\n${secret}`,
      `${stream()}\n${JSON.stringify({ type: 'error', message: secret })}`,
    ]) {
      const error = assertInvalid(stdout);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.stack?.includes(secret), false);
      assert.equal(error.cause, undefined);
    }
  });

  it('bounds total UTF-8 bytes, individual lines, and line count', () => {
    assert.match(
      assertInvalid('x'.repeat(16 * 1024 * 1024 + 1)).message,
      /byte limit/,
    );
    assert.match(
      assertInvalid(
        stream(
          item('agent_message', {
            text: 'é'.repeat(600_000),
          }),
        ),
      ).message,
      /oversized line/,
    );
    assert.match(
      assertInvalid(`${'\n'.repeat(100_000)}${stream()}`).message,
      /line limit/,
    );
  });

  it('bounds JSON depth, expanded nodes, and the aggregate graph across snapshots', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < 70; index += 1) nested = { nested };
    for (const argumentsValue of [
      nested,
      Array.from({ length: 100_001 }, () => null),
    ]) {
      assert.match(
        assertInvalid(
          stream(
            item('mcp_tool_call', {
              server: 'docs',
              tool: 'search',
              arguments: argumentsValue,
              status: 'completed',
            }),
          ),
        ).message,
        /JSON structure limits/,
      );
    }
    const snapshot = JSON.stringify(
      item('reasoning', { text: 'Thinking' }, 'updated'),
    );
    assert.match(
      assertInvalid(
        `${jsonl(started, turnStarted)}\n${`${snapshot}\n`.repeat(17_000)}${JSON.stringify(completed)}`,
      ).message,
      /JSON structure limits/,
    );
  });

  it('bounds distinct tool calls, not repeated snapshots of one call', () => {
    const calls = Array.from({ length: 2_001 }, (_, index) =>
      item('command_execution', {
        id: `call_${index}`,
        command: 'true',
        status: 'completed',
      }),
    );
    assert.match(assertInvalid(stream(...calls)).message, /tool-call limit/);
    const snapshot = item(
      'command_execution',
      { command: 'true', status: 'in_progress' },
      'updated',
    );
    assert.equal(
      parseCodexStream(stream(...Array.from({ length: 2_001 }, () => snapshot)))
        .toolCalls.length,
      1,
    );
  });
});
