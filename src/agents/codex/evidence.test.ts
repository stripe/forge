import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';

import { parseAtifTrajectory } from '../../atif/index.ts';
import type { ReadonlyWorkspace } from '../../contracts/runtime.ts';
import {
  createJudgeTranscriptProjection,
  type JudgeVisibleStepV1,
} from '../../evaluation/judgeTranscript.ts';
import { trajectoryCoversCompletedTurns } from '../../evidence/selection.ts';
import { createMemoryWorkspace } from '../../testing/memoryWorkspace.ts';
import { loadCodexEvidence, loadCodexNativeArtifact } from './evidence.ts';

const SESSION = '01999999-1111-7111-8111-111111111111';
const OTHER_SESSION = '01999999-2222-7222-8222-222222222222';
const VERSION = '0.149.0';
const MODEL = 'test-model';
const PATH = `sessions/2026/09/22/rollout-2026-09-22T12-00-00-${SESSION}.jsonl`;
const METADATA = record('session_meta', {
  id: SESSION,
  source: 'exec',
  cli_version: VERSION,
  cwd: '/workspace',
  base_instructions: { text: 'Base agent instructions.' },
});

function record(type: string, payload: Record<string, unknown>) {
  return { timestamp: '2026-09-22T12:00:00.000Z', type, payload };
}
function message(role: string, text: string) {
  return record('response_item', {
    type: 'message',
    role,
    content: [
      { type: role === 'assistant' ? 'output_text' : 'input_text', text },
    ],
  });
}
function turn(prompt = 'Do the task', answer = 'Done', turnId = 'turn-1') {
  return [
    record('event_msg', { type: 'task_started', turn_id: turnId }),
    record('turn_context', { turn_id: turnId, model: MODEL }),
    message('user', prompt),
    record('event_msg', {
      type: 'user_message',
      message: prompt,
      images: [],
      local_images: [],
      text_elements: [],
    }),
    record('event_msg', {
      type: 'agent_message',
      message: answer,
      phase: 'final_answer',
    }),
    message('assistant', answer),
    record('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: answer,
    }),
  ];
}
function jsonl(records: readonly unknown[]) {
  return `${records.map((value) => JSON.stringify(value)).join('\n')}\n`;
}
function context(
  home: ReadonlyWorkspace | undefined,
  signal = new AbortController().signal,
) {
  return {
    home,
    sessionId: SESSION,
    agentVersion: VERSION,
    model: MODEL,
    signal,
  };
}
async function load(records: readonly unknown[]) {
  return loadCodexEvidence(
    context(createMemoryWorkspace({ [PATH]: jsonl(records) }).readonly),
  );
}

// Minimized shapes captured from Codex CLI 0.149.0 against an offline, synthetic
// Responses server. Paths, IDs, instructions and timings are fixture-only.
// The disk rollout is distinct from `codex exec --json` stdout.
function capturedResponse(
  payload: Record<string, unknown>,
  turnId = 'turn-1',
): {
  type: string;
  payload: Record<string, unknown>;
} {
  return {
    type: 'response_item',
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}
function capturedItem(item: Record<string, unknown>, turnId = 'turn-1') {
  return record('event_msg', {
    type: 'item_completed',
    thread_id: SESSION,
    turn_id: turnId,
    item,
    started_at_ms: 1790091485621,
    completed_at_ms: 1790091485621,
  });
}
function capturedTurn(
  prompt = 'First prompt.',
  answer = 'First response.',
  turnId = 'turn-1',
) {
  return [
    record('event_msg', {
      type: 'task_started',
      turn_id: turnId,
      started_at: 1790091485,
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    }),
    record('turn_context', {
      turn_id: turnId,
      model: MODEL,
      cwd: '/workspace',
      approval_policy: 'never',
      permission_profile: { type: 'disabled' },
    }),
    capturedResponse(
      {
        type: 'message',
        id: `user-response-${turnId}`,
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
      turnId,
    ),
    capturedItem(
      {
        type: 'UserMessage',
        id: `user-event-${turnId}`,
        content: [{ type: 'text', text: prompt, text_elements: [] }],
      },
      turnId,
    ),
    capturedItem(
      {
        type: 'AgentMessage',
        id: `assistant-${turnId}`,
        content: [{ type: 'Text', text: answer }],
      },
      turnId,
    ),
    capturedResponse(
      {
        type: 'message',
        id: `assistant-${turnId}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: answer }],
      },
      turnId,
    ),
    record('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
          total_tokens: 15,
        },
        model_context_window: 258400,
      },
      rate_limits: null,
    }),
    record('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: answer,
      started_at: 1790091485,
      completed_at: 1790091485,
      duration_ms: 100,
      time_to_first_token_ms: 10,
    }),
  ];
}
function capturedWorldState() {
  return record('world_state', {
    full: true,
    state: {
      agents_md: { directory: '/workspace', text: 'Use the test runner.' },
      apps_instructions: false,
      collaboration_mode: {
        mode: 'default',
        model: MODEL,
        instructions: 'Default mode.',
      },
      environments: {
        environments: {
          local: { cwd: '/workspace', status: 'connected', shell: 'sh' },
        },
        current_date: '2026-09-22',
        timezone: 'UTC',
        filesystem: '<filesystem />',
      },
      environments_instructions: false,
      git_attribution: false,
      host_skills: {
        body: 'Synthetic skill instructions.',
        includeInstructions: true,
      },
      model: MODEL,
      multi_agent_mode: {},
      orchestrator_skills: { includeInstructions: true, enabled: false },
      permissions: {
        instructions: 'Synthetic permission instructions.',
        approved_command_prefixes: [],
      },
      personality: { model: MODEL, personality: 'pragmatic' },
      plugins_instructions: false,
      realtime: { active: false },
      skills: { includeInstructions: true },
    },
  });
}
function capturedThreadSettings() {
  return record('event_msg', {
    type: 'thread_settings_applied',
    thread_settings: {
      model: MODEL,
      model_provider_id: 'forge',
      approval_policy: 'never',
      approvals_reviewer: 'user',
      permission_profile: { type: 'disabled' },
      cwd: '/workspace',
      personality: 'pragmatic',
      collaboration_mode: {
        mode: 'default',
        settings: {
          model: MODEL,
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    },
  });
}
function capturedPatch(
  callId: string,
  input: string,
  changes: Record<string, unknown>,
) {
  return [
    capturedResponse({
      type: 'custom_tool_call',
      id: `item-${callId}`,
      call_id: callId,
      name: 'apply_patch',
      input,
    }),
    capturedItem({
      type: 'FileChange',
      id: callId,
      changes,
      status: 'completed',
      stdout: 'Success. Updated the following files:\n',
      stderr: '',
    }),
    capturedResponse({
      type: 'custom_tool_call_output',
      id: `output-${callId}`,
      call_id: callId,
      output:
        'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\n',
    }),
  ];
}
function capturedTools() {
  return [
    capturedItem({
      type: 'Reasoning',
      id: 'reasoning-1',
      summary_text: ['Synthetic private reasoning.'],
      raw_content: [],
    }),
    capturedResponse({
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [{ type: 'summary_text', text: 'Synthetic private reasoning.' }],
      content: null,
      encrypted_content: null,
    }),
    ...capturedPatch(
      'call-add',
      '*** Begin Patch\n*** Add File: result.txt\n+first\n*** End Patch',
      { '/workspace/result.txt': { type: 'add', content: 'first\n' } },
    ),
    ...capturedPatch(
      'call-update',
      '*** Begin Patch\n*** Update File: result.txt\n@@\n-first\n+second\n*** End Patch',
      {
        '/workspace/result.txt': {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-first\n+second\n',
          move_path: null,
        },
      },
    ),
    ...capturedPatch(
      'call-delete',
      '*** Begin Patch\n*** Delete File: result.txt\n*** End Patch',
      { '/workspace/result.txt': { type: 'delete', content: 'second\n' } },
    ),
    capturedResponse({
      type: 'function_call',
      id: 'command-1',
      name: 'exec_command',
      arguments: '{"cmd":"pwd","max_output_tokens":1000}',
      call_id: 'call-exec',
    }),
    capturedItem({
      type: 'CommandExecution',
      id: 'call-exec',
      process_id: '1234',
      command: ['/bin/sh', '-lc', 'pwd'],
      cwd: 'file:///workspace',
      parsed_cmd: [{ type: 'unknown', cmd: 'pwd' }],
      source: 'unified_exec_startup',
      status: 'completed',
      stdout: '/workspace\n',
      stderr: '',
      aggregated_output: '/workspace\n',
      exit_code: 0,
      duration: { secs: 0, nanos: 1792 },
      formatted_output: '/workspace\n',
    }),
    capturedResponse({
      type: 'function_call_output',
      id: 'output-exec',
      call_id: 'call-exec',
      output:
        'Chunk ID: fixture\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\n/workspace\n',
    }),
  ];
}

const IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4z8DwnxLMMGrAqAGjBgwXAwAwxP4QHCfkAAAAAABJRU5ErkJggg==';
const MCP_TEXT = 'Native MCP tool evidence.';
const MCP_HEADER = 'Wall time: 0.001 seconds\nOutput:';

// Captured CLI policy: four UTF-8 bytes per approximate token, equal retained
// ends, and a marker whose count is computed before codepoint-boundary rounding.
function clippedMcpText(original: string, budget = 12_000): string {
  const bytes = Buffer.from(original);
  let prefix = budget * 2;
  let suffix = bytes.length - budget * 2;
  while ((bytes[prefix]! & 0xc0) === 0x80) prefix -= 1;
  while ((bytes[suffix]! & 0xc0) === 0x80) suffix += 1;
  return (
    bytes.subarray(0, prefix).toString() +
    `…${Math.ceil(bytes.length / 4) - budget} tokens truncated…` +
    bytes.subarray(suffix).toString()
  );
}

// Bytes policy: the extra odd byte goes to the tail, and the marker counts
// omitted Unicode scalars after both ends round to complete UTF-8 codepoints.
function clippedMcpChars(original: string, budget = 12_000): string {
  const bytes = Buffer.from(original);
  let prefix = Math.floor(budget / 2);
  let suffix = bytes.length - (budget - prefix);
  while ((bytes[prefix]! & 0xc0) === 0x80) prefix -= 1;
  while ((bytes[suffix]! & 0xc0) === 0x80) suffix += 1;
  const omitted = Array.from(bytes.subarray(prefix, suffix).toString()).length;
  return (
    bytes.subarray(0, prefix).toString() +
    `…${omitted} chars truncated…` +
    bytes.subarray(suffix).toString()
  );
}

const MCP_CLIPS = [
  { unit: 'tokens', clip: clippedMcpText },
  { unit: 'chars', clip: clippedMcpChars },
];

function capturedMcp(
  options: {
    result?: Record<string, unknown>;
    error?: { message: string };
    output?: unknown;
    turnId?: string;
  } = {},
) {
  const turnId = options.turnId ?? 'turn-1';
  const result = options.error
    ? undefined
    : (options.result ?? {
        content: [{ type: 'text', text: MCP_TEXT }],
        isError: false,
      });
  const output =
    options.output ??
    `${MCP_HEADER}\n${JSON.stringify(
      options.error
        ? [{ type: 'text', text: options.error.message }]
        : (result?.structuredContent ?? result?.content),
    )}`;
  return [
    capturedResponse(
      {
        type: 'tool_search_call',
        id: 'search-item',
        call_id: 'search-call',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'fixture probe', limit: 1 },
      },
      turnId,
    ),
    capturedResponse(
      {
        type: 'tool_search_output',
        id: 'search-output',
        call_id: 'search-call',
        status: 'completed',
        execution: 'client',
        tools: [
          {
            type: 'namespace',
            name: 'mcp__fixture',
            description: 'Synthetic fixture tools.',
            tools: [
              {
                type: 'function',
                name: 'probe',
                description: 'Look up the fixture.',
                strict: false,
                defer_loading: true,
                parameters: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      },
      turnId,
    ),
    capturedResponse(
      {
        type: 'function_call',
        id: 'mcp-item',
        call_id: 'mcp-call',
        namespace: 'mcp__fixture',
        name: 'probe',
        arguments: '{}',
      },
      turnId,
    ),
    capturedItem(
      {
        type: 'McpToolCall',
        id: 'mcp-call',
        server: 'fixture',
        tool: 'probe',
        arguments: {},
        readOnlyHint: true,
        status: options.error || result?.isError ? 'failed' : 'completed',
        ...(options.error ? { error: options.error } : { result }),
        duration: { secs: 0, nanos: 1 },
      },
      turnId,
    ),
    capturedResponse(
      {
        type: 'function_call_output',
        id: 'mcp-output',
        call_id: 'mcp-call',
        output,
      },
      turnId,
    ),
  ];
}

async function loadToolSequence(
  sequence: readonly ReturnType<typeof capturedResponse>[],
) {
  const records = capturedTurn();
  records.splice(4, 0, ...sequence);
  return load([METADATA, ...records]);
}

function capturedMcpListing(
  tool: string,
  options: Parameters<typeof capturedMcp>[0],
) {
  const sequence = capturedMcp(options).slice(2);
  delete sequence[0]!.payload.namespace;
  sequence[0]!.payload.name = tool;
  const item = sequence[1]!.payload.item as Record<string, unknown>;
  item.server = 'codex';
  item.tool = tool;
  return sequence;
}

describe('Codex exact rollout evidence', () => {
  it('normalizes web search actions once in either native record order', async () => {
    for (const action of [
      {
        type: 'search',
        query: 'synthetic query',
        queries: ['synthetic query'],
      },
      { type: 'search', queries: ['synthetic query', 'second query'] },
      { type: 'search', query: 'synthetic query' },
      { type: 'search' },
      { type: 'open_page' },
      { type: 'find_in_page' },
      { type: 'find_in_page', url: 'https://example.com/guide' },
      { type: 'find_in_page', pattern: 'sample' },
      { type: 'open_page', url: 'https://example.com/guide' },
      {
        type: 'find_in_page',
        url: 'https://example.com/guide',
        pattern: 'sample',
      },
    ]) {
      for (const reverse of [false, true]) {
        const sequence = [
          capturedItem({
            type: 'WebSearch',
            id: 'web-1',
            query: 'lookup',
            action,
          }),
          capturedResponse({
            type: 'web_search_call',
            id: 'web-1',
            status: 'completed',
            action,
          }),
        ];
        const evidence = await loadToolSequence(
          reverse ? sequence.reverse() : sequence,
        );
        assert.equal(evidence.kind, 'available');
        if (evidence.kind !== 'available')
          throw new Error('Expected web evidence.');
        assert.deepEqual(evidence.warnings, []);
        const trajectory = parseAtifTrajectory(evidence.trajectory);
        assert.deepEqual(
          trajectory.steps.flatMap((step) => step.tool_calls ?? []),
          [
            {
              tool_call_id: 'web-1',
              function_name: 'web_search',
              arguments: { query: 'lookup', action },
            },
          ],
        );
        assert.equal(
          trajectoryCoversCompletedTurns(
            trajectory,
            [
              {
                user: 'First prompt.',
                assistant: 'First response.',
                toolCalls: [
                  {
                    id: 'web-1',
                    name: 'web_search',
                    input: { query: 'lookup', action },
                  },
                ],
              },
            ],
            { kind: 'native_log', format: 'codex-rollout-jsonl' },
          ),
          true,
        );
      }
    }
  });

  it('rejects incomplete, duplicate, contradictory, and unknown web search records', async () => {
    const action = { type: 'search', query: 'synthetic query' };
    const completed = capturedItem({
      type: 'WebSearch',
      id: 'web-1',
      query: 'synthetic query',
      action,
    });
    const response = capturedResponse({
      type: 'web_search_call',
      id: 'web-1',
      status: 'completed',
      action,
    });
    for (const sequence of [
      [completed],
      [response],
      [completed, response, response],
      [completed, completed, response],
      [
        completed,
        capturedResponse({ ...response.payload, status: 'in_progress' }),
      ],
      [
        completed,
        capturedResponse({
          ...response.payload,
          action: { ...action, query: 'other' },
        }),
      ],
      [completed, capturedResponse({ ...response.payload, extra: true })],
      [
        capturedItem({
          type: 'WebSearch',
          id: 'web-1',
          query: 'synthetic query',
          action,
          extra: true,
        }),
        response,
      ],
      [
        capturedItem({ type: 'WebSearch', id: 'web-1', query: 1, action }),
        response,
      ],
      [
        completed,
        capturedResponse({
          ...response.payload,
          action: { ...action, extra: true },
        }),
      ],
      [
        completed,
        capturedResponse({
          ...response.payload,
          action: { ...action, queries: [1] },
        }),
      ],
      [
        completed,
        capturedResponse({ ...response.payload, action: { type: 'unknown' } }),
      ],
      [completed, capturedResponse(response.payload, 'other-turn')],
      [
        capturedItem(
          completed.payload.item as Record<string, unknown>,
          'other-turn',
        ),
        response,
      ],
      ...[
        { ...action, extra: true },
        { ...action, query: 1 },
        { ...action, queries: [1] },
        { ...action, queries: 'synthetic query' },
        { type: 'open_page', extra: true },
        { type: 'find_in_page', extra: true },
        { type: 'unknown' },
        { type: 'open_page', url: 1 },
        { type: 'find_in_page', url: 1 },
        { type: 'find_in_page', url: 'https://example.com/guide', pattern: 1 },
      ].map((invalidAction) => [
        capturedItem({
          type: 'WebSearch',
          id: 'web-1',
          query: 'lookup',
          action: invalidAction,
        }),
        capturedResponse({ ...response.payload, action: invalidAction }),
      ]),
      [capturedItem({ type: 'UnknownItem', id: 'unknown' })],
      [capturedResponse({ type: 'unknown_response', id: 'unknown' })],
    ]) {
      assert.equal((await loadToolSequence(sequence)).kind, 'unavailable');
    }
  });

  it.each(['turn-1', 'turn-2'])(
    'rejects a web search response in %s paired with a completion in the other turn',
    async (responseTurn) => {
      const action = { type: 'search', query: 'synthetic query' };
      const first = capturedTurn();
      const second = capturedTurn(
        'Second prompt.',
        'Second response.',
        'turn-2',
      );
      const completionTurn = responseTurn === 'turn-1' ? 'turn-2' : 'turn-1';
      const response = capturedResponse(
        { type: 'web_search_call', id: 'web-1', status: 'completed', action },
        responseTurn,
      );
      const completion = capturedItem(
        { type: 'WebSearch', id: 'web-1', query: 'synthetic query', action },
        completionTurn,
      );
      first.splice(4, 0, responseTurn === 'turn-1' ? response : completion);
      second.splice(4, 0, responseTurn === 'turn-2' ? response : completion);
      const evidence = await load([METADATA, ...first, ...second]);
      assert.equal(evidence.kind, 'unavailable', responseTurn);
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    },
  );

  it('rejects a function call reusing a web search ID in either order', async () => {
    const action = { type: 'search', query: 'synthetic query' };
    const web = [
      capturedResponse({
        type: 'web_search_call',
        id: 'web-1',
        status: 'completed',
        action,
      }),
      capturedItem({ type: 'WebSearch', id: 'web-1', query: 'lookup', action }),
    ];
    const call = [
      capturedResponse({
        type: 'function_call',
        call_id: 'web-1',
        name: 'read_file',
        arguments: '{}',
      }),
      capturedResponse({
        type: 'function_call_output',
        call_id: 'web-1',
        output: 'File contents.',
      }),
    ];
    for (const sequence of [
      [...web, ...call],
      [...call, ...web],
    ]) {
      const evidence = await loadToolSequence(sequence);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    }
  });

  it('rejects a web search response before the user message', async () => {
    const action = { type: 'search', query: 'synthetic query' };
    const records = capturedTurn();
    records.splice(
      4,
      0,
      capturedItem({ type: 'WebSearch', id: 'web-1', query: 'lookup', action }),
    );
    records.splice(
      2,
      0,
      capturedResponse({
        type: 'web_search_call',
        id: 'web-1',
        status: 'completed',
        action,
      }),
    );
    const evidence = await load([METADATA, ...records]);
    assert.equal(evidence.kind, 'unavailable');
    if (evidence.kind === 'unavailable')
      assert.equal(evidence.reason.code, 'source_incomplete');
  });

  it('correlates image view snapshots with their existing calls and marks omitted images', async () => {
    for (const { argumentPath, path } of [
      {
        argumentPath: '/tmp/synthetic image.png',
        path: '/tmp/synthetic image.png',
      },
      {
        argumentPath: '/tmp/synthetic image.png',
        path: 'file:///tmp/synthetic%20image.png',
      },
      { argumentPath: 'image.png', path: 'file:///workspace/image.png' },
      { argumentPath: './image.png', path: 'file:///workspace/image.png' },
    ]) {
      const sequence = [
        capturedResponse({
          type: 'function_call',
          call_id: 'image-1',
          name: 'view_image',
          arguments: JSON.stringify({ path: argumentPath }),
        }),
        capturedItem({ type: 'ImageView', id: 'image-1', path }),
        capturedResponse({
          type: 'function_call_output',
          call_id: 'image-1',
          output: [
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${IMAGE_DATA}`,
            },
          ],
        }),
      ];
      const evidence = await loadToolSequence(sequence);
      if (evidence.kind !== 'available')
        throw new Error('Expected image evidence.');
      assert.equal(evidence.warnings.length, 1);
      assert.equal(evidence.warnings[0]?.code, 'value_omitted');
      const steps = parseAtifTrajectory(evidence.trajectory).steps.filter(
        (step) => step.tool_calls?.length,
      );
      assert.equal(steps.length, 1);
      assert.deepEqual(steps[0]?.tool_calls, [
        {
          tool_call_id: 'image-1',
          function_name: 'view_image',
          arguments: { path: argumentPath },
        },
      ]);
      assert.equal(
        steps[0]?.observation?.results[0]?.source_call_id,
        'image-1',
      );
      assert.equal(
        JSON.stringify(evidence.trajectory).includes(IMAGE_DATA),
        false,
      );
      for (const item of [
        { type: 'ImageView', id: 'image-1', path: '/tmp/other.png' },
        { type: 'ImageView', id: 'image-1', path, extra: true },
        { type: 'ImageView', id: 'orphan', path },
        {
          type: 'ImageView',
          id: 'image-1',
          path: 'file://remote/tmp/synthetic.png',
        },
      ]) {
        assert.equal(
          (
            await loadToolSequence([
              sequence[0]!,
              capturedItem(item),
              sequence[2]!,
            ])
          ).kind,
          'unavailable',
        );
      }
    }
  });

  it('resolves image arguments against the current turn cwd only', async () => {
    const image = (turnId: string) => [
      capturedResponse(
        {
          type: 'function_call',
          call_id: `image-${turnId}`,
          name: 'view_image',
          arguments: '{"path":"./image.png"}',
        },
        turnId,
      ),
      capturedItem(
        {
          type: 'ImageView',
          id: `image-${turnId}`,
          path: 'file:///workspace/second/image.png',
        },
        turnId,
      ),
      capturedResponse(
        {
          type: 'function_call_output',
          call_id: `image-${turnId}`,
          output: 'Image unavailable.',
        },
        turnId,
      ),
    ];
    const first = capturedTurn();
    first[1]!.payload.cwd = '/workspace/second';
    for (const { cwd, omitContext } of [
      ...['/workspace/second', '/workspace', undefined, 'relative'].map(
        (cwd) => ({ cwd, omitContext: false }),
      ),
      { cwd: undefined, omitContext: true },
    ]) {
      const second = capturedTurn(
        'Second prompt.',
        'Second response.',
        'turn-2',
      );
      if (cwd === undefined) delete second[1]!.payload.cwd;
      else second[1]!.payload.cwd = cwd;
      second.splice(4, 0, ...image('turn-2'));
      if (omitContext) second.splice(1, 1);
      const evidence = await load([METADATA, ...first, ...second]);
      assert.equal(
        evidence.kind,
        cwd === '/workspace/second' ? 'available' : 'unavailable',
      );
    }
  });

  it('rejects a relative image cwd even when host resolution would match the snapshot', async () => {
    const records = capturedTurn();
    records[1]!.payload.cwd = 'relative';
    records.splice(
      4,
      0,
      capturedResponse({
        type: 'function_call',
        call_id: 'image-1',
        name: 'view_image',
        arguments: '{"path":"image.png"}',
      }),
      capturedItem({
        type: 'ImageView',
        id: 'image-1',
        path: pathToFileURL(posix.resolve('relative', 'image.png')).href,
      }),
      capturedResponse({
        type: 'function_call_output',
        call_id: 'image-1',
        output: 'Image unavailable.',
      }),
    );
    const evidence = await load([METADATA, ...records]);
    assert.equal(evidence.kind, 'unavailable');
    if (evidence.kind === 'unavailable')
      assert.equal(evidence.reason.code, 'source_incomplete');
  });

  it('requires usable cwd data only when resolving relative image arguments', async () => {
    for (const cwd of [undefined, null, 1, {}, 'relative']) {
      for (const argumentPath of [
        undefined,
        '/workspace/image.png',
        'image.png',
      ]) {
        const records = capturedTurn();
        records[1]!.payload.cwd = cwd;
        if (argumentPath !== undefined) {
          records.splice(
            4,
            0,
            capturedResponse({
              type: 'function_call',
              call_id: 'image-1',
              name: 'view_image',
              arguments: JSON.stringify({ path: argumentPath }),
            }),
            capturedItem({
              type: 'ImageView',
              id: 'image-1',
              path: 'file:///workspace/image.png',
            }),
            capturedResponse({
              type: 'function_call_output',
              call_id: 'image-1',
              output: 'Image unavailable.',
            }),
          );
        }
        const evidence = await load([METADATA, ...records]);
        assert.equal(
          evidence.kind,
          argumentPath === 'image.png' ? 'unavailable' : 'available',
        );
        if (evidence.kind === 'unavailable')
          assert.equal(evidence.reason.code, 'source_incomplete');
      }
    }
  });

  it('rejects an ImageView attached to a read_file call', async () => {
    const evidence = await loadToolSequence([
      capturedResponse({
        type: 'function_call',
        call_id: 'image-1',
        name: 'read_file',
        arguments: '{"path":"/workspace/image.png"}',
      }),
      capturedItem({
        type: 'ImageView',
        id: 'image-1',
        path: 'file:///workspace/image.png',
      }),
      capturedResponse({
        type: 'function_call_output',
        call_id: 'image-1',
        output: 'Image unavailable.',
      }),
    ]);
    assert.equal(evidence.kind, 'unavailable');
    if (evidence.kind === 'unavailable')
      assert.equal(evidence.reason.code, 'source_incomplete');
  });

  it('rejects an image snapshot in a later turn than its complete call and output', async () => {
    const first = capturedTurn();
    first.splice(
      4,
      0,
      capturedResponse({
        type: 'function_call',
        call_id: 'image-1',
        name: 'view_image',
        arguments: '{"path":"/workspace/image.png"}',
      }),
      capturedResponse({
        type: 'function_call_output',
        call_id: 'image-1',
        output: 'Image unavailable.',
      }),
    );
    const second = capturedTurn('Second prompt.', 'Second response.', 'turn-2');
    second.splice(
      4,
      0,
      capturedItem(
        {
          type: 'ImageView',
          id: 'image-1',
          path: 'file:///workspace/image.png',
        },
        'turn-2',
      ),
    );
    const evidence = await load([METADATA, ...first, ...second]);
    assert.equal(evidence.kind, 'unavailable');
    if (evidence.kind === 'unavailable')
      assert.equal(evidence.reason.code, 'source_incomplete');
  });

  it('does not treat a namespaced view_image as the built-in image tool', async () => {
    const evidence = await loadToolSequence([
      capturedResponse({
        type: 'function_call',
        call_id: 'image-1',
        name: 'view_image',
        namespace: 'custom',
        arguments: '{"path":"/workspace/image.png"}',
      }),
      capturedItem({
        type: 'ImageView',
        id: 'image-1',
        path: 'file:///workspace/image.png',
      }),
      capturedResponse({
        type: 'function_call_output',
        call_id: 'image-1',
        output: 'Image unavailable.',
      }),
    ]);
    assert.equal(evidence.kind, 'unavailable');
    if (evidence.kind === 'unavailable')
      assert.equal(evidence.reason.code, 'source_incomplete');
  });

  it('rejects an image output missing or moved to another turn', async () => {
    const first = capturedTurn();
    first.splice(
      4,
      0,
      capturedResponse({
        type: 'function_call',
        call_id: 'image-1',
        name: 'view_image',
        arguments: '{"path":"/workspace/image.png"}',
      }),
      capturedItem({
        type: 'ImageView',
        id: 'image-1',
        path: 'file:///workspace/image.png',
      }),
    );
    const second = capturedTurn('Second prompt.', 'Second response.', 'turn-2');
    second.splice(
      4,
      0,
      capturedResponse(
        {
          type: 'function_call_output',
          call_id: 'image-1',
          output: 'Image unavailable.',
        },
        'turn-2',
      ),
    );
    for (const records of [first, [...first, ...second]]) {
      const evidence = await load([METADATA, ...records]);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    }
  });

  it('preserves web, image, and MCP activity together for judging and coverage', async () => {
    const action = { type: 'search', query: 'synthetic query' };
    const evidence = await loadToolSequence([
      ...capturedMcp(),
      capturedItem({
        type: 'WebSearch',
        id: 'web-1',
        query: 'synthetic query',
        action,
      }),
      capturedResponse({
        type: 'web_search_call',
        id: 'web-1',
        status: 'completed',
        action,
      }),
      capturedResponse({
        type: 'function_call',
        call_id: 'image-1',
        name: 'view_image',
        arguments: '{"path":"/tmp/sample.png"}',
      }),
      capturedItem({
        type: 'ImageView',
        id: 'image-1',
        path: 'file:///tmp/sample.png',
      }),
      capturedResponse({
        type: 'function_call_output',
        call_id: 'image-1',
        output: [
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${IMAGE_DATA}`,
          },
        ],
      }),
    ]);
    if (evidence.kind !== 'available')
      throw new Error('Expected mixed evidence.');
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    const projection = createJudgeTranscriptProjection(trajectory);
    const projectedSteps = JSON.parse(
      projection.transcriptJson,
    ) as JudgeVisibleStepV1[];
    assert.deepEqual(
      projectedSteps
        .flatMap((step) =>
          step.source === 'agent' ? (step.tool_calls ?? []) : [],
        )
        .map((call) => call.function_name),
      ['tool_search', 'mcp__fixture.probe', 'web_search', 'view_image'],
    );
    assert.equal(
      trajectoryCoversCompletedTurns(
        trajectory,
        [
          {
            user: 'First prompt.',
            assistant: 'First response.',
            toolCalls: [
              { name: 'web_search' },
              { name: 'mcp__fixture__probe' },
            ],
          },
        ],
        { kind: 'native_log', format: 'codex-rollout-jsonl' },
      ),
      true,
    );
  });

  it('validates direct results for built-in MCP resource listings and restores their server identity', async () => {
    for (const tool of ['list_mcp_resources', 'list_mcp_resource_templates']) {
      const text = JSON.stringify(
        tool === 'list_mcp_resources'
          ? { resources: [] }
          : { resourceTemplates: [] },
      );
      const makeSequence = () =>
        capturedMcpListing(tool, {
          result: { content: [{ type: 'text', text }] },
          output: text,
        });
      const evidence = await loadToolSequence(makeSequence());
      if (evidence.kind !== 'available')
        throw new Error('Expected resource evidence.');
      assert.deepEqual(evidence.warnings, []);
      const step = parseAtifTrajectory(evidence.trajectory).steps.find(
        (step) => step.tool_calls?.[0]?.tool_call_id === 'mcp-call',
      );
      assert.equal(step?.tool_calls?.[0]?.function_name, `mcp__codex.${tool}`);
      assert.equal(step?.observation?.results[0]?.content, text);
      const bare = makeSequence().filter((entry) => entry.type !== 'event_msg');
      const bareEvidence = await loadToolSequence(bare);
      assert.equal(bareEvidence.kind, 'available');
      if (bareEvidence.kind !== 'available')
        throw new Error('Expected ordinary function evidence.');
      assert.deepEqual(bareEvidence.warnings, []);
      const bareStep = parseAtifTrajectory(bareEvidence.trajectory).steps.find(
        (step) => step.tool_calls?.[0]?.tool_call_id === 'mcp-call',
      );
      assert.equal(bareStep?.tool_calls?.[0]?.function_name, tool);
      assert.equal(bareStep?.observation?.results[0]?.content, text);
      for (const mutate of [
        (sequence: ReturnType<typeof capturedMcp>) => {
          const item = sequence[1]!.payload.item as Record<string, unknown>;
          (item.result as Record<string, unknown>).structuredContent = {
            hidden: 'Snapshot-only data.',
          };
        },
        (sequence: ReturnType<typeof capturedMcp>) => {
          sequence[2]!.payload.output = '{"different":[]}';
        },
        (sequence: ReturnType<typeof capturedMcp>) => {
          sequence[0]!.payload.namespace = 'mcp__other';
        },
        (sequence: ReturnType<typeof capturedMcp>) => {
          sequence[0]!.payload.name = 'other';
        },
        (sequence: ReturnType<typeof capturedMcp>) => {
          sequence[0]!.payload.arguments = '{"different":true}';
        },
        (sequence: ReturnType<typeof capturedMcp>) => {
          (sequence[1]!.payload.item as Record<string, unknown>).status =
            'failed';
        },
      ]) {
        const sequence = makeSequence();
        mutate(sequence);
        assert.equal((await loadToolSequence(sequence)).kind, 'unavailable');
      }
    }
  });

  it('preserves failed bare MCP listing observations', async () => {
    for (const tool of ['list_mcp_resources', 'list_mcp_resource_templates']) {
      const text = 'Resource listing failed.';
      const evidence = await loadToolSequence(
        capturedMcpListing(tool, { error: { message: text }, output: text }),
      );
      if (evidence.kind !== 'available')
        throw new Error('Expected failed listing evidence.');
      const step = parseAtifTrajectory(evidence.trajectory).steps.find(
        (step) => step.tool_calls?.[0]?.tool_call_id === 'mcp-call',
      );
      assert.equal(step?.tool_calls?.[0]?.function_name, `mcp__codex.${tool}`);
      assert.deepEqual(step?.observation?.results, [
        {
          source_call_id: 'mcp-call',
          content: text,
          extra: { is_error: true },
        },
      ]);
    }
  });

  it('rejects bare non-listing MCP names and multi-block listing snapshots', async () => {
    const text = '{"resources":[]}';
    for (const { tool, content } of [
      { tool: 'probe', content: [{ type: 'text', text }] },
      ...['list_mcp_resources', 'list_mcp_resource_templates'].map((tool) => ({
        tool,
        content: [
          { type: 'text', text },
          { type: 'text', text: 'Extra block.' },
        ],
      })),
    ]) {
      const evidence = await loadToolSequence(
        capturedMcpListing(tool, { result: { content }, output: text }),
      );
      assert.equal(evidence.kind, 'unavailable', tool);
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    }
  });

  it('accepts captured native plugin MCP attribution and rejects malformed identities', async () => {
    for (const pluginId of [
      'fixture@forge-fixture',
      '',
      'fixture',
      '../fixture@test',
      null,
      1,
    ]) {
      const sequence = capturedMcp();
      sequence[3]!.payload.item = {
        ...(sequence[3]!.payload.item as object),
        pluginId,
      };
      const evidence = await loadToolSequence(sequence);
      assert.equal(
        evidence.kind,
        pluginId === 'fixture@forge-fixture' ? 'available' : 'unavailable',
      );
      if (evidence.kind === 'available') {
        assert.deepEqual(evidence.warnings, []);
        const calls = parseAtifTrajectory(evidence.trajectory).steps.flatMap(
          (step) => step.tool_calls ?? [],
        );
        assert.equal(calls.at(-1)?.function_name, 'mcp__fixture.probe');
      }
    }
  });

  it('requires MCP completion snapshots regardless of naming form or explicit output error flags', async () => {
    for (const server of ['fixture', '__fixture', 'fixture__nested']) {
      for (const naming of [
        'namespaced',
        'qualified',
        'empty-namespace-qualified',
      ]) {
        for (const isError of [undefined, true, false]) {
          const sequence = capturedMcp({
            result: {
              content: [{ type: 'text', text: 'Tool failed.' }],
              isError: true,
            },
          });
          const call = sequence[2]!.payload;
          if (naming === 'namespaced') call.namespace = `mcp__${server}`;
          else {
            call.name = `mcp__${server}__probe`;
            if (naming === 'qualified') delete call.namespace;
            else call.namespace = '';
          }
          if (isError !== undefined) sequence[4]!.payload.is_error = isError;
          const evidence = await loadToolSequence(
            sequence.filter((_, index) => index !== 3),
          );
          assert.equal(
            evidence.kind,
            'unavailable',
            `${server}/${naming}/${String(isError)}`,
          );
          if (evidence.kind === 'unavailable')
            assert.equal(evidence.reason.code, 'source_incomplete');
        }
      }
    }
  });

  it('requires a snapshot for successful MCP results and RPC errors too', async () => {
    for (const options of [{}, { error: { message: 'Fixture RPC failed.' } }]) {
      const sequence = capturedMcp(options);
      const evidence = await loadToolSequence(
        sequence.filter((_, index) => index !== 3),
      );
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    }
  });

  it('does not substitute a command completion for an MCP completion with the same call ID', async () => {
    const command = capturedTools().find(
      (entry) =>
        (entry.payload.item as { type?: string } | undefined)?.type ===
        'CommandExecution',
    )!;
    for (const tool of ['exec_command', 'write_stdin']) {
      const sequence = capturedMcp();
      sequence[2]!.payload.name = tool;
      sequence[3]!.payload.item = {
        ...(command.payload.item as object),
        id: 'mcp-call',
      };
      const evidence = await loadToolSequence(sequence);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    }
  });

  it('fails closed for MCP-shaped custom calls without a typed completion snapshot', async () => {
    for (const naming of ['namespaced', 'qualified']) {
      const sequence = capturedMcp();
      const call = sequence[2]!.payload;
      call.type = 'custom_tool_call';
      call.input = '{}';
      delete call.arguments;
      if (naming === 'qualified') {
        delete call.namespace;
        call.name = 'mcp__fixture__probe';
      }
      sequence[4]!.payload.type = 'custom_tool_call_output';
      assert.equal(
        (await loadToolSequence(sequence.filter((_, index) => index !== 3)))
          .kind,
        'unavailable',
      );
    }
  });

  it('accepts typed MCP completions in either record order and preserves verified error flags', async () => {
    for (const server of ['fixture', '__fixture', 'fixture__nested']) {
      for (const naming of [
        'namespaced',
        'qualified',
        'empty-namespace-qualified',
      ]) {
        for (const failed of [true, false]) {
          const sequence = capturedMcp({
            result: {
              content: [{ type: 'text', text: MCP_TEXT }],
              isError: failed,
            },
          });
          const call = sequence[2]!.payload;
          if (naming === 'namespaced') call.namespace = `mcp__${server}`;
          else {
            call.name = `mcp__${server}__probe`;
            if (naming === 'qualified') delete call.namespace;
            else call.namespace = '';
          }
          sequence[3]!.payload.item = {
            ...(sequence[3]!.payload.item as object),
            server,
          };
          for (const records of [
            sequence,
            [
              sequence[0]!,
              sequence[1]!,
              sequence[3]!,
              sequence[2]!,
              sequence[4]!,
            ],
          ]) {
            const evidence = await loadToolSequence(records);
            assert.equal(evidence.kind, 'available');
            if (evidence.kind !== 'available')
              throw new Error('Expected verified MCP evidence.');
            assert.deepEqual(evidence.warnings, []);
            const calls = parseAtifTrajectory(
              evidence.trajectory,
            ).steps.flatMap((step) => step.tool_calls ?? []);
            assert.equal(
              calls.find((call) => call.tool_call_id === 'mcp-call')
                ?.function_name,
              naming === 'namespaced'
                ? `mcp__${server}.probe`
                : `mcp__${server}__probe`,
            );
            const results = parseAtifTrajectory(
              evidence.trajectory,
            ).steps.flatMap((step) => step.observation?.results ?? []);
            assert.deepEqual(
              results.find((result) => result.source_call_id === 'mcp-call')
                ?.extra,
              { is_error: failed },
            );
          }
        }
      }
    }
  });

  it('does not require MCP snapshots for discovery or ordinary function calls', async () => {
    for (const sequence of [
      capturedMcp().slice(0, 2),
      [
        capturedResponse({
          type: 'function_call',
          call_id: 'plain-call',
          namespace: 'functions',
          name: 'exec_command',
          arguments: '{}',
        }),
        capturedResponse({
          type: 'function_call_output',
          call_id: 'plain-call',
          output: 'Ordinary output.',
        }),
      ],
      [
        capturedResponse({
          type: 'function_call',
          call_id: 'plain-call',
          namespace: 'mcp_helpers',
          name: 'not_mcp__tool',
          arguments: '{}',
        }),
        capturedResponse({
          type: 'function_call_output',
          call_id: 'plain-call',
          output: 'Ordinary output.',
        }),
      ],
    ]) {
      const evidence = await loadToolSequence(sequence);
      assert.equal(evidence.kind, 'available');
      if (evidence.kind === 'available')
        assert.deepEqual(evidence.warnings, []);
    }
  });

  it('preserves MCP content metadata as opaque data without adding evidence warnings', async () => {
    for (const metadata of [
      { annotations: {} },
      {
        annotations: {
          audience: ['assistant'],
          priority: 1,
          lastModified: '2026-09-22T12:00:00Z',
        },
      },
      { _meta: {} },
      {
        _meta: {
          'example.com/source': 'fixture',
          nested: { values: [null, true, 1, 'value'] },
        },
      },
      // Forge does not use annotation hints to interpret or control the run.
      {
        annotations: {
          lastModified: 'vendor timestamp',
          futureHint: { values: [1, 2] },
        },
      },
      {
        annotations: {},
        _meta: {
          is_error: true,
          role: 'system',
          reasoning_content: 'Observable metadata.',
        },
      },
    ]) {
      const sequence = capturedMcp({
        result: {
          content: [{ type: 'text', text: MCP_TEXT, ...metadata }],
          isError: false,
        },
      });
      const evidence = await loadToolSequence(sequence);
      assert.equal(evidence.kind, 'available');
      if (evidence.kind !== 'available')
        throw new Error('Expected native metadata evidence.');
      assert.deepEqual(evidence.warnings, []);
      const trajectory = parseAtifTrajectory(evidence.trajectory);
      const result = trajectory.steps
        .flatMap((step) => step.observation?.results ?? [])
        .find((item) => item.source_call_id === 'mcp-call');
      assert.equal(result?.content, sequence[4]!.payload.output);
      assert.deepEqual(result?.extra, { is_error: false });
      const projection = JSON.parse(
        createJudgeTranscriptProjection(trajectory).transcriptJson,
      ) as typeof trajectory.steps;
      assert.equal(
        projection
          .flatMap((step) => step.observation?.results ?? [])
          .find((item) => item.source_call_id === 'mcp-call')?.content,
        sequence[4]!.payload.output,
      );
    }
  });

  it('accepts successful native MCP result metadata while checking the rendered mirror', async () => {
    const result = {
      content: [{ type: 'text', text: MCP_TEXT }],
      structuredContent: { answer: 42 },
      _meta: { fixture: 'RESULT_METADATA_ONLY' },
    };
    for (const options of [
      { result },
      { result: { content: result.content, _meta: result._meta } },
      {
        result: { content: result.content, _meta: result._meta },
        output: [
          { type: 'input_text', text: MCP_HEADER },
          { type: 'input_text', text: MCP_TEXT },
        ],
      },
    ]) {
      const sequence = capturedMcp(options);
      const evidence = await loadToolSequence(sequence);
      assert.equal(evidence.kind, 'available');
      if (evidence.kind !== 'available')
        throw new Error('Expected successful MCP evidence.');
      assert.deepEqual(evidence.warnings, []);
      assert.doesNotMatch(
        JSON.stringify(evidence.trajectory),
        /RESULT_METADATA_ONLY/,
      );
      const projection = JSON.parse(
        createJudgeTranscriptProjection(
          parseAtifTrajectory(evidence.trajectory),
        ).transcriptJson,
      ) as JudgeVisibleStepV1[];
      assert.deepEqual(
        projection
          .flatMap((step) =>
            step.source === 'agent' ? (step.observation?.results ?? []) : [],
          )
          .find((entry) => entry.source_call_id === 'mcp-call'),
        {
          source_call_id: 'mcp-call',
          content:
            typeof sequence[4]!.payload.output === 'string'
              ? sequence[4]!.payload.output
              : [
                  { type: 'text', text: MCP_HEADER },
                  { type: 'text', text: MCP_TEXT },
                ],
          is_error: false,
        },
      );
    }
    assert.equal(
      (
        await loadToolSequence(
          capturedMcp({ result, output: `${MCP_HEADER}\n{"answer":43}` }),
        )
      ).kind,
      'unavailable',
    );
  });

  it('accepts null native result metadata as absent', async () => {
    const result = { content: [{ type: 'text', text: MCP_TEXT }] };
    const withoutMetadata = await loadToolSequence(capturedMcp({ result }));
    assert.equal(withoutMetadata.kind, 'available');
    const withNullMetadata = await loadToolSequence(
      capturedMcp({ result: { ...result, _meta: null } }),
    );
    assert.deepEqual(withNullMetadata, withoutMetadata);
  });

  it('falls back explicitly for unsupported native result metadata types', async () => {
    for (const _meta of [[], 'metadata', 0, false]) {
      const evidence = await loadToolSequence(
        capturedMcp({
          result: { content: [{ type: 'text', text: MCP_TEXT }], _meta },
        }),
      );
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
    }
  });

  it('does not inject snapshot-only metadata into structured or text-array output', async () => {
    const content = [
      {
        type: 'text',
        text: MCP_TEXT,
        annotations: { fixture: 'SNAPSHOT_ONLY_ANNOTATION' },
        _meta: { fixture: 'SNAPSHOT_ONLY_METADATA' },
      },
    ];
    for (const sequence of [
      capturedMcp({
        result: {
          content,
          structuredContent: { answer: MCP_TEXT },
          isError: true,
        },
      }),
      capturedMcp({
        result: { content },
        output: [
          { type: 'input_text', text: MCP_HEADER },
          { type: 'input_text', text: MCP_TEXT },
        ],
      }),
    ]) {
      const evidence = await loadToolSequence(sequence);
      assert.equal(evidence.kind, 'available');
      if (evidence.kind !== 'available')
        throw new Error('Expected native rendered output.');
      assert.deepEqual(evidence.warnings, []);
      const projection = createJudgeTranscriptProjection(
        parseAtifTrajectory(evidence.trajectory),
      ).transcriptJson;
      assert.ok(projection.includes(MCP_TEXT));
      assert.ok(!projection.includes('SNAPSHOT_ONLY_'));
    }
  });

  it('accepts image content metadata without exposing snapshot metadata or image bytes', async () => {
    const evidence = await loadToolSequence(
      capturedMcp({
        result: {
          content: [
            { type: 'text', text: MCP_TEXT, annotations: {} },
            {
              type: 'image',
              mimeType: 'image/png',
              data: IMAGE_DATA,
              annotations: { audience: ['user'] },
              _meta: { fixture: 'SNAPSHOT_ONLY_IMAGE_METADATA' },
            },
          ],
        },
        output: [
          { type: 'input_text', text: MCP_HEADER },
          { type: 'input_text', text: MCP_TEXT },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${IMAGE_DATA}`,
          },
        ],
      }),
    );
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native image evidence.');
    assert.equal(evidence.warnings.length, 1);
    assert.match(evidence.warnings[0]?.message ?? '', /image content/);
    const projection = createJudgeTranscriptProjection(
      parseAtifTrajectory(evidence.trajectory),
    ).transcriptJson;
    assert.ok(projection.includes(MCP_TEXT));
    assert.ok(!projection.includes('SNAPSHOT_ONLY_IMAGE_METADATA'));
    assert.ok(!projection.includes(IMAGE_DATA));
  });

  it('requires MCP metadata containers to be objects on both text and image content', async () => {
    for (const field of ['annotations', '_meta']) {
      for (const value of [null, [], 'metadata', 0, false]) {
        for (const block of [
          { type: 'text', text: MCP_TEXT },
          { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
        ]) {
          const output =
            block.type === 'image'
              ? [
                  { type: 'input_text', text: MCP_HEADER },
                  {
                    type: 'input_image',
                    image_url: `data:image/png;base64,${IMAGE_DATA}`,
                  },
                ]
              : undefined;
          const evidence = await loadToolSequence(
            capturedMcp({
              result: { content: [{ ...block, [field]: value }] },
              output,
            }),
          );
          assert.equal(evidence.kind, 'unavailable');
          if (evidence.kind === 'unavailable')
            assert.equal(evidence.reason.code, 'source_incomplete');
        }
      }
    }
  });

  it('still rejects unknown content fields and metadata mirror mismatches', async () => {
    const content = [
      {
        type: 'text',
        text: MCP_TEXT,
        annotations: {},
        _meta: { source: 'original' },
      },
    ];
    for (const options of [
      { result: { content: [{ ...content[0], unknown: 'unclassified' }] } },
      { result: { content, _meta: {}, unknown: 'unclassified' } },
      {
        result: { content },
        output: `${MCP_HEADER}\n${JSON.stringify([{ ...content[0], _meta: { source: 'changed' } }])}`,
      },
      {
        result: { content },
        output: `${MCP_HEADER}\n${JSON.stringify([{ type: 'text', text: MCP_TEXT }])}`,
      },
    ])
      assert.equal(
        (await loadToolSequence(capturedMcp(options))).kind,
        'unavailable',
      );
  });

  it('validates truncation that crosses metadata without reconstructing the omitted data', async () => {
    const sequence = capturedMcp({
      result: {
        content: [
          {
            type: 'text',
            text: MCP_TEXT,
            annotations: {},
            _meta: {
              value:
                'prefix '.repeat(100) +
                'HIDDEN_METADATA_MIDDLE' +
                ' suffix'.repeat(100),
            },
          },
        ],
      },
    });
    const output = clippedMcpText(String(sequence[4]!.payload.output), 100);
    sequence[4]!.payload.output = output;
    const evidence = await loadToolSequence(sequence);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected truncated metadata evidence.');
    assert.equal(evidence.warnings.length, 1);
    assert.match(evidence.warnings[0]?.message ?? '', /Codex truncated/);
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(
      trajectory.steps
        .flatMap((step) => step.observation?.results ?? [])
        .find((item) => item.source_call_id === 'mcp-call')?.content,
      output,
    );
    assert.ok(
      !createJudgeTranscriptProjection(trajectory).transcriptJson.includes(
        'HIDDEN_METADATA_MIDDLE',
      ),
    );
    sequence[4]!.payload.output = output.replace('prefix', 'Prefix');
    assert.equal((await loadToolSequence(sequence)).kind, 'unavailable');
  });

  it('applies the existing graph and line bounds to opaque metadata', async () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    for (const metadata of [
      nested,
      { values: Array.from({ length: 100_001 }, () => 0) },
      { text: 'x'.repeat(1024 * 1024) },
    ]) {
      assert.equal(
        (
          await loadToolSequence(
            capturedMcp({
              result: {
                content: [{ type: 'text', text: MCP_TEXT }],
                _meta: metadata,
              },
            }),
          )
        ).kind,
        'unavailable',
      );
      for (const field of ['annotations', '_meta']) {
        assert.equal(
          (
            await loadToolSequence(
              capturedMcp({
                result: {
                  content: [
                    { type: 'text', text: MCP_TEXT, [field]: metadata },
                  ],
                },
              }),
            )
          ).kind,
          'unavailable',
        );
      }
    }
  });

  it.each(MCP_CLIPS)(
    'preserves proven plain, structured, Unicode, and failed MCP $unit truncation exactly',
    async ({ clip }) => {
      const longText =
        'prefix …1 tokens truncated… ' +
        'abcdef🦀漢字'.repeat(12_000) +
        ' suffix';
      for (const options of [
        {
          result: {
            content: [{ type: 'text', text: longText }],
            isError: false,
          },
        },
        {
          result: {
            content: [{ type: 'text', text: 'unused' }],
            structuredContent: { answer: longText },
            isError: true,
          },
        },
        { error: { message: longText } },
      ]) {
        const sequence = capturedMcp(options);
        const output = clip(String(sequence[4]!.payload.output));
        sequence[4]!.payload.output = output;
        const evidence = await loadToolSequence(sequence);
        assert.equal(evidence.kind, 'available');
        if (evidence.kind !== 'available')
          throw new Error('Expected truncated MCP evidence.');
        assert.equal(evidence.warnings.length, 1);
        assert.equal(evidence.warnings[0]?.code, 'value_omitted');
        assert.match(evidence.warnings[0]?.message ?? '', /Codex truncated/);
        const trajectory = parseAtifTrajectory(evidence.trajectory);
        const result = trajectory.steps
          .flatMap((step) => step.observation?.results ?? [])
          .find((item) => item.source_call_id === 'mcp-call');
        assert.equal(result?.content, output);
        assert.deepEqual(result?.extra, {
          is_error: Boolean(options.error || options.result?.isError),
        });
        const projection = createJudgeTranscriptProjection(trajectory);
        assert.ok(
          projection.transcriptJson.includes(
            JSON.stringify(output).slice(1, -1),
          ),
        );
        assert.ok(
          !projection.transcriptJson.includes(
            JSON.stringify(longText).slice(1, -1),
          ),
        );
      }
    },
  );

  it('accepts exact clipping through a JSON escape without requiring valid output JSON', async () => {
    const result = { content: [{ type: 'text', text: '\\'.repeat(1_000) }] };
    const full = `${MCP_HEADER}\n${JSON.stringify(result.content)}`;
    const output = clippedMcpText(full, 36);
    assert.throws(() => JSON.parse(output.slice(MCP_HEADER.length + 1)));
    const evidence = await loadToolSequence(capturedMcp({ result, output }));
    assert.equal(evidence.kind, 'available');
  });

  it('uses raw snapshot JSON spellings and key order instead of JavaScript reserialization', async () => {
    const rawStructured = `{"float":1.0,"zero":-0.0,"9":"nine","2":"two","payload":${JSON.stringify('x'.repeat(2_000))},"end":1e-7}`;
    const structuredContent: unknown = JSON.parse(rawStructured);
    const output = clippedMcpText(`${MCP_HEADER}\n${rawStructured}`, 100);
    const records = capturedTurn();
    records.splice(
      4,
      0,
      ...capturedMcp({ result: { content: [], structuredContent }, output }),
    );
    const raw = jsonl([METADATA, ...records]).replace(
      JSON.stringify(structuredContent),
      rawStructured,
    );
    const home = createMemoryWorkspace({ [PATH]: raw }).readonly;
    const evidence = await loadCodexEvidence(context(home));
    assert.equal(evidence.kind, 'available');
    assert.equal(
      Buffer.from(
        (await loadCodexNativeArtifact(context(home)))!.body,
      ).toString(),
      raw,
    );
  });

  it('does not interpret marker-like source text as actual truncation', async () => {
    const text =
      'Literal …42 tokens truncated… and …42 chars truncated… and [omitted 2 text items ...].';
    for (const output of [
      undefined,
      [
        { type: 'input_text', text: MCP_HEADER },
        { type: 'input_text', text },
      ],
    ]) {
      const evidence = await loadToolSequence(
        capturedMcp({ result: { content: [{ type: 'text', text }] }, output }),
      );
      assert.equal(evidence.kind, 'available');
      if (evidence.kind === 'available')
        assert.deepEqual(evidence.warnings, []);
    }
  });

  it.each(MCP_CLIPS)(
    'validates the shared array $unit budget, later text omissions, and retained images',
    async ({ clip }) => {
      const longText = `…3 tokens truncated…${'x'.repeat(900)}`;
      const image = { type: 'image', mimeType: 'image/png', data: IMAGE_DATA };
      const content = [
        { type: 'text', text: 'small' },
        { type: 'text', text: longText },
        { type: 'text', text: '' },
        image,
        { type: 'text', text: 'not shown' },
      ];
      const output = [
        { type: 'input_text', text: MCP_HEADER },
        { type: 'input_text', text: 'small' },
        { type: 'input_text', text: clip(longText, 25) },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${IMAGE_DATA}`,
        },
        { type: 'input_text', text: '[omitted 2 text items ...]' },
      ];
      const evidence = await loadToolSequence(
        capturedMcp({ result: { content }, output }),
      );
      assert.equal(evidence.kind, 'available');
      if (evidence.kind !== 'available')
        throw new Error('Expected truncated mixed output.');
      assert.equal(
        evidence.warnings.filter(({ message }) =>
          message.includes('Codex truncated'),
        ).length,
        1,
      );
      const projection = createJudgeTranscriptProjection(
        parseAtifTrajectory(evidence.trajectory),
      );
      assert.ok(
        projection.transcriptJson.includes('[omitted 2 text items ...]'),
      );
      assert.ok(!projection.transcriptJson.includes('not shown'));
      assert.ok(!projection.transcriptJson.includes(IMAGE_DATA));
      for (const corrupt of [
        output.map((block, index) =>
          index === 2 ? { ...block, text: `${block.text}!` } : block,
        ),
        output.map((block, index) =>
          index === 4
            ? { ...block, text: '[omitted 1 text items ...]' }
            : block,
        ),
        output.filter((_, index) => index !== 3),
        [...output, { type: 'input_text', text: 'not shown' }],
      ])
        assert.equal(
          (
            await loadToolSequence(
              capturedMcp({ result: { content }, output: corrupt }),
            )
          ).kind,
          'unavailable',
        );
    },
  );

  it('supports omission exactly at a text boundary but rejects retained empty text after exhaustion', async () => {
    const content = [
      { type: 'text', text: 'kept' },
      { type: 'text', text: '' },
      { type: 'text', text: 'dropped' },
    ];
    const output = [
      { type: 'input_text', text: MCP_HEADER },
      { type: 'input_text', text: 'kept' },
      { type: 'input_text', text: '[omitted 2 text items ...]' },
    ];
    assert.equal(
      (await loadToolSequence(capturedMcp({ result: { content }, output })))
        .kind,
      'available',
    );
    const badOutput = [
      output[0],
      output[1],
      { type: 'input_text', text: '' },
      { type: 'input_text', text: '[omitted 1 text items ...]' },
    ];
    assert.equal(
      (
        await loadToolSequence(
          capturedMcp({ result: { content }, output: badOutput }),
        )
      ).kind,
      'unavailable',
    );
  });

  it('validates a final omission marker even when a dropped source block is identical to it', async () => {
    const text = '[omitted 2 text items ...]';
    const content = [
      { type: 'text', text: 'kept' },
      { type: 'text', text },
      { type: 'text', text: 'hidden' },
    ];
    const output = [
      { type: 'input_text', text: MCP_HEADER },
      { type: 'input_text', text: 'kept' },
      { type: 'input_text', text },
    ];
    const evidence = await loadToolSequence(
      capturedMcp({ result: { content }, output }),
    );
    assert.equal(evidence.kind, 'available');
    if (evidence.kind === 'available')
      assert.equal(evidence.warnings.length, 1);
    const wrongCount = '[omitted 3 text items ...]';
    assert.equal(
      (
        await loadToolSequence(
          capturedMcp({
            result: {
              content: [
                content[0],
                { type: 'text', text: wrongCount },
                content[2],
              ],
            },
            output: [
              output[0],
              output[1],
              { type: 'input_text', text: wrongCount },
            ],
          }),
        )
      ).kind,
      'unavailable',
    );
    assert.equal(
      (
        await loadToolSequence(
          capturedMcp({
            result: {
              content: [
                content[0],
                { type: 'text', text: '' },
                ...content.slice(1),
              ],
            },
            output: [
              output[0],
              output[1],
              { type: 'input_text', text: '' },
              output[2],
            ],
          }),
        )
      ).kind,
      'unavailable',
    );
  });

  it.each(MCP_CLIPS)(
    'rejects fabricated $unit clips and keeps identity, argument, status, and header checks',
    async ({ unit, clip }) => {
      const result = {
        content: [{ type: 'text', text: 'abcdefgh'.repeat(1_000) }],
      };
      const original = `${MCP_HEADER}\n${JSON.stringify(result.content)}`;
      const output = clip(original, 100);
      const marker = new RegExp(`…[0-9]+ ${unit} truncated…`);
      for (const corrupt of [
        output.replace('abcdefgh', 'Abcdefgh'),
        `${output.slice(0, -1)}!`,
        output.replace(marker, `…0 ${unit} truncated…`),
        output.replace(marker, `…2 ${unit} truncated…`),
        output.replace(marker, (match) =>
          match.replace(/[0-9]+/, (count) => String(Number(count) + 1)),
        ),
        `${MCP_HEADER}\nunrelated …100 ${unit} truncated… text`,
        clip(original, 2), // The elapsed-time header itself is unavailable.
      ])
        assert.equal(
          (await loadToolSequence(capturedMcp({ result, output: corrupt })))
            .kind,
          'unavailable',
        );
      for (const changed of [
        { id: 'other' },
        { arguments: { changed: true } },
        { status: 'failed' },
      ]) {
        const sequence = capturedMcp({ result, output });
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          ...changed,
        };
        assert.equal((await loadToolSequence(sequence)).kind, 'unavailable');
      }
      const wrongTurn = capturedMcp({ result, output });
      wrongTurn[3]!.payload.turn_id = 'other';
      assert.equal((await loadToolSequence(wrongTurn)).kind, 'unavailable');
    },
  );

  it('normalizes captured discovery and MCP calls as correlated root behavior', async () => {
    const result = await loadToolSequence(capturedMcp());
    assert.equal(result.kind, 'available');
    if (result.kind !== 'available')
      throw new Error('Expected native MCP evidence.');
    const trajectory = parseAtifTrajectory(result.trajectory);
    const toolSteps = trajectory.steps.filter(
      (step) => step.tool_calls?.length,
    );
    assert.deepEqual(
      toolSteps.map((step) => step.tool_calls?.[0]?.function_name),
      ['tool_search', 'mcp__fixture.probe'],
    );
    assert.deepEqual(toolSteps[0]?.tool_calls?.[0]?.arguments, {
      query: 'fixture probe',
      limit: 1,
    });
    assert.equal(
      toolSteps[0]?.observation?.results[0]?.source_call_id,
      'search-call',
    );
    assert.deepEqual(
      JSON.parse(String(toolSteps[0]?.observation?.results[0]?.content)).tools,
      capturedMcp()[1]!.payload.tools,
    );
    assert.equal(
      toolSteps[1]?.observation?.results[0]?.source_call_id,
      'mcp-call',
    );
    assert.deepEqual(toolSteps[1]?.observation?.results[0]?.extra, {
      is_error: false,
    });
    assert.deepEqual(result.warnings, []);
  });

  it('preserves structured MCP JSON within strings and plain-text native arrays', async () => {
    const structured = {
      answer: MCP_TEXT,
      reasoning_content: 'Opaque observable result.',
    };
    for (const sequence of [
      capturedMcp({
        result: {
          content: [{ type: 'text', text: 'Alternate MCP text.' }],
          structuredContent: structured,
          isError: false,
        },
      }),
      capturedMcp({
        output: [
          { type: 'input_text', text: MCP_HEADER },
          { type: 'input_text', text: MCP_TEXT },
        ],
      }),
    ]) {
      const result = await loadToolSequence(sequence);
      assert.equal(result.kind, 'available');
      if (result.kind !== 'available')
        throw new Error('Expected native MCP evidence.');
      assert.deepEqual(result.warnings, []);
      const projection = createJudgeTranscriptProjection(
        parseAtifTrajectory(result.trajectory),
      );
      assert.ok(projection.transcriptJson.includes(MCP_TEXT));
      assert.ok(projection.transcriptJson.includes('mcp-call'));
    }
  });

  it('omits native image bytes explicitly while retaining all text and tool correlation', async () => {
    const result = await loadToolSequence(
      capturedMcp({
        result: {
          content: [
            { type: 'text', text: MCP_TEXT },
            { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
          ],
          isError: false,
        },
        output: [
          { type: 'input_text', text: MCP_HEADER },
          { type: 'input_text', text: MCP_TEXT },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${IMAGE_DATA}`,
            detail: 'high',
          },
        ],
      }),
    );
    assert.equal(result.kind, 'available');
    if (result.kind !== 'available')
      throw new Error('Expected partial native MCP evidence.');
    assert.deepEqual(
      result.warnings.map(({ code }) => code),
      ['value_omitted'],
    );
    assert.match(result.warnings[0]?.path ?? '', /\.output\[2\]$/);
    const trajectory = parseAtifTrajectory(result.trajectory);
    const projection = createJudgeTranscriptProjection(trajectory);
    for (const text of [
      JSON.stringify(trajectory),
      projection.transcriptJson,
    ]) {
      assert.ok(text.includes(MCP_TEXT));
      assert.ok(text.includes('mcp-call'));
      assert.ok(
        text.includes(
          'Codex image content retained only in the native artifact.',
        ),
      );
      assert.ok(!text.includes(IMAGE_DATA));
      assert.ok(!text.includes('data:image'));
    }
  });

  it('retains the CLI-rendered image decode failure as complete text evidence', async () => {
    const omission = 'image content omitted because it could not be processed';
    const result = await loadToolSequence(
      capturedMcp({
        result: {
          content: [
            { type: 'text', text: MCP_TEXT },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
          isError: false,
        },
        output: [
          { type: 'input_text', text: MCP_HEADER },
          { type: 'input_text', text: MCP_TEXT },
          { type: 'input_text', text: omission },
        ],
      }),
    );
    assert.equal(result.kind, 'available');
    if (result.kind !== 'available')
      throw new Error('Expected native text evidence.');
    assert.deepEqual(result.warnings, []);
    assert.ok(
      createJudgeTranscriptProjection(
        parseAtifTrajectory(result.trajectory),
      ).transcriptJson.includes(omission),
    );
  });

  it('retains tool-level and transport errors without inferring success from completion', async () => {
    for (const sequence of [
      capturedMcp({
        result: { content: [{ type: 'text', text: MCP_TEXT }], isError: true },
      }),
      capturedMcp({
        error: { message: 'Synthetic fixture transport failure.' },
      }),
    ]) {
      const result = await loadToolSequence(sequence);
      assert.equal(result.kind, 'available');
      if (result.kind !== 'available')
        throw new Error('Expected native failed-tool evidence.');
      const steps = JSON.parse(
        createJudgeTranscriptProjection(parseAtifTrajectory(result.trajectory))
          .transcriptJson,
      ) as Array<{
        observation?: {
          results: Array<{ source_call_id?: string; is_error?: boolean }>;
        };
      }>;
      assert.equal(
        steps
          .flatMap((step) => step.observation?.results ?? [])
          .find(({ source_call_id }) => source_call_id === 'mcp-call')
          ?.is_error,
        true,
      );
    }
  });

  it('retains image-only tool results as neutral marked observations, without fetching URLs', async () => {
    for (const type of ['function_call', 'custom_tool_call']) {
      for (const imageUrl of [
        `data:image/png;base64,${IMAGE_DATA}`,
        'https://images.example.test/fixture.png',
      ]) {
        const result = await loadToolSequence([
          capturedResponse({
            type,
            call_id: 'image-only',
            name: 'fixture',
            ...(type === 'function_call'
              ? { arguments: '{}' }
              : { input: 'fixture' }),
          }),
          capturedResponse({
            type: `${type}_output`,
            call_id: 'image-only',
            output: [{ type: 'input_image', image_url: imageUrl }],
          }),
        ]);
        assert.equal(result.kind, 'available');
        if (result.kind !== 'available')
          throw new Error('Expected partial image-only evidence.');
        assert.equal(result.warnings.length, 1);
        const projected = createJudgeTranscriptProjection(
          parseAtifTrajectory(result.trajectory),
        ).transcriptJson;
        assert.ok(projected.includes('image-only'));
        assert.ok(
          projected.includes(
            'Codex image content retained only in the native artifact.',
          ),
        );
        assert.ok(!projected.includes(imageUrl));
        assert.ok(!projected.includes(IMAGE_DATA));
      }
    }
  });

  it('fails closed for unsupported output blocks, object results, and malformed image shapes', async () => {
    for (const output of [
      { text: 'Not a supported native content array.' },
      [{ type: 'input_text', text: MCP_TEXT, unknown: 'unclassified content' }],
      [{ type: 'input_audio', data: 'unknown' }],
      [{ type: 'input_image', image_url: 'file:///outside/image.png' }],
      [{ type: 'input_image', image_url: 'data:text/plain;base64,AAAA' }],
      [{ type: 'input_image', image_url: 'data:image/png;base64,not base64' }],
      [
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${IMAGE_DATA}`,
          detail: 'unknown',
        },
      ],
    ]) {
      const result = await loadToolSequence([
        capturedResponse({
          type: 'function_call',
          call_id: 'call',
          name: 'fixture',
          arguments: '{}',
        }),
        capturedResponse({
          type: 'function_call_output',
          call_id: 'call',
          output,
        }),
      ]);
      assert.equal(result.kind, 'unavailable');
    }
  });

  it('rejects unknown or contradictory MCP metadata, identities, arguments, and rendered results', async () => {
    for (const mutate of [
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          server: 'other',
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          tool: 'other',
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          arguments: { different: true },
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          unknown: 'content',
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          status: 'failed',
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          result: {
            content: [{ type: 'text', text: MCP_TEXT }],
            isError: true,
          },
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.item = {
          ...(sequence[3]!.payload.item as object),
          error: { message: 'contradictory' },
        };
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[4]!.payload.output = `${MCP_HEADER}\n[{"type":"text","text":"Different output"}]`;
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[4]!.payload.is_error = true;
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[3]!.payload.turn_id = 'other-turn';
      },
      (sequence: ReturnType<typeof capturedMcp>) => {
        sequence[4]!.payload.internal_chat_message_metadata_passthrough = {
          turn_id: 'other-turn',
        };
      },
    ]) {
      for (const sequence of [
        capturedMcp(),
        capturedMcp({
          result: {
            content: [
              {
                type: 'text',
                text: MCP_TEXT,
                annotations: {},
                _meta: { fixture: 'value' },
              },
            ],
          },
        }),
      ]) {
        mutate(sequence);
        assert.equal((await loadToolSequence(sequence)).kind, 'unavailable');
      }
    }
  });

  it('rejects incomplete, duplicate, orphan, cross-type, and unknown discovery records', async () => {
    const valid = capturedMcp();
    const variants = [
      valid.filter((_, i) => i !== 0),
      valid.filter((_, i) => i !== 1),
      valid.filter((_, i) => i !== 2),
      valid.filter((_, i) => i !== 3),
      valid.filter((_, i) => i !== 4),
      [valid[0]!, ...valid],
      [...valid, valid[1]!],
      [...valid, valid[3]!],
      valid.map((entry, i) =>
        i === 1
          ? capturedResponse({
              ...entry.payload,
              type: 'function_call_output',
              output: 'wrong type',
            })
          : entry,
      ),
      valid.map((entry, i) =>
        i === 0
          ? capturedResponse({ ...entry.payload, status: 'in_progress' })
          : entry,
      ),
      valid.map((entry, i) =>
        i === 0
          ? capturedResponse({ ...entry.payload, execution: 'server' })
          : entry,
      ),
      valid.map((entry, i) =>
        i === 0
          ? capturedResponse({
              ...entry.payload,
              arguments: { query: 'fixture', unknown: true },
            })
          : entry,
      ),
      valid.map((entry, i) =>
        i === 1
          ? capturedResponse({
              ...entry.payload,
              tools: [{ type: 'unknown', content: 'unclassified' }],
            })
          : entry,
      ),
    ];
    for (const sequence of variants)
      assert.equal((await loadToolSequence(sequence)).kind, 'unavailable');
  });

  it('accepts captured message phase and custom-call completion metadata, rejecting contradictions', async () => {
    const records = capturedTurn();
    const event = records[4]!;
    event.payload.item = {
      ...(event.payload.item as object),
      phase: 'final_answer',
    };
    records[5]!.payload.phase = 'final_answer';
    records.splice(
      4,
      0,
      capturedResponse({
        type: 'custom_tool_call',
        id: 'patch-item',
        call_id: 'patch',
        name: 'apply_patch',
        input: 'fixture',
        status: 'completed',
      }),
      capturedResponse({
        type: 'custom_tool_call_output',
        call_id: 'patch',
        output: 'fixture tool failed',
        is_error: true,
      }),
    );
    const accepted = await load([METADATA, ...records]);
    assert.equal(accepted.kind, 'available');
    if (accepted.kind !== 'available')
      throw new Error('Expected native failed-tool evidence.');
    assert.deepEqual(
      parseAtifTrajectory(accepted.trajectory)
        .steps.flatMap((step) => step.observation?.results ?? [])
        .find(({ source_call_id }) => source_call_id === 'patch')?.extra,
      { is_error: true },
    );
    for (const change of ['phase', 'mirror', 'status']) {
      const changed = structuredClone(records);
      if (change === 'phase')
        changed[6]!.payload.item = {
          ...(changed[6]!.payload.item as object),
          phase: 'analysis',
        };
      if (change === 'mirror')
        changed[6]!.payload.item = {
          ...(changed[6]!.payload.item as object),
          phase: 'commentary',
        };
      if (change === 'status') changed[4]!.payload.status = 'in_progress';
      assert.equal((await load([METADATA, ...changed])).kind, 'unavailable');
    }
  });

  it('normalizes captured 0.149.0 first/resume shapes and reconciles both driver turns', async () => {
    const first = capturedTurn();
    first.splice(
      1,
      0,
      capturedResponse({
        type: 'message',
        id: 'developer',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'Rendered developer instructions.' },
        ],
      }),
      capturedResponse({
        type: 'message',
        id: 'context',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions for /workspace\n\nUse the test runner.',
          },
          {
            type: 'input_text',
            text: '<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>',
          },
        ],
      }),
      capturedWorldState(),
    );
    const evidence = await load([
      record('session_meta', {
        ...METADATA.payload,
        session_id: SESSION,
        originator: 'codex_exec',
        thread_source: 'user',
        model_provider: 'forge',
        history_mode: 'paginated',
        context_window: { window_id: OTHER_SESSION },
      }),
      ...first,
      capturedThreadSettings(),
      ...capturedTurn('Second prompt.', 'Second response.', 'turn-2'),
    ]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native Codex evidence.');
    assert.deepEqual(evidence.warnings, []);
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(trajectory.steps.length, 7);
    assert.deepEqual(
      trajectory.steps
        .filter(({ source }) => source !== 'system')
        .map(({ message: text }) => text),
      [
        'First prompt.',
        'First response.',
        'Second prompt.',
        'Second response.',
      ],
    );
    assert.equal(
      trajectoryCoversCompletedTurns(
        trajectory,
        [
          {
            user: 'First prompt.',
            assistant: 'First response.',
            toolCalls: [],
          },
          {
            user: 'Second prompt.',
            assistant: 'Second response.',
            toolCalls: [],
          },
        ],
        evidence.source,
      ),
      true,
    );
  });

  it('retains resumed plugin context changes from captured world-state merge patches', async () => {
    const first = capturedTurn();
    first.splice(1, 0, capturedWorldState());
    first.splice(5, 0, ...capturedMcp());
    const resumed = capturedTurn(
      'Second prompt.',
      'Second response.',
      'turn-2',
    );
    resumed.splice(
      1,
      0,
      capturedResponse(
        {
          type: 'message',
          id: 'updated-skills',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'Updated skills without the disabled plugin.',
            },
          ],
        },
        'turn-2',
      ),
      record('world_state', {
        full: false,
        state: {
          host_skills: { body: 'Updated skills without the disabled plugin.' },
          plugins_instructions: false,
        },
      }),
    );
    const records = [METADATA, ...first, capturedThreadSettings(), ...resumed];
    const original = jsonl(records);
    const evidence = await load(records);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected resumed native plugin evidence.');
    assert.deepEqual(evidence.warnings, []);
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(
      trajectory.steps.filter(
        ({ source, message }) =>
          source === 'system' &&
          message === 'Updated skills without the disabled plugin.',
      ).length,
      1,
    );
    assert.equal(
      trajectory.steps
        .flatMap((step) => step.tool_calls ?? [])
        .filter(({ function_name }) => function_name === 'mcp__fixture.probe')
        .length,
      1,
    );
    assert.equal(
      trajectoryCoversCompletedTurns(
        trajectory,
        [
          {
            user: 'First prompt.',
            assistant: 'First response.',
            toolCalls: [],
          },
          {
            user: 'Second prompt.',
            assistant: 'Second response.',
            toolCalls: [],
          },
        ],
        evidence.source,
      ),
      true,
    );
    assert.equal(jsonl(records), original);
  });

  it('validates merged world-state shape and rejects orphaned or unsafe context patches', async () => {
    for (const state of [
      { model: 'another-model' },
      { model: null },
      { host_skills: { body: 1 } },
      { host_skills: { future: 'unknown' } },
      { host_skills: { future: null } },
      { future: null },
      { realtime: { active: true } },
      { permissions: { approved_command_prefixes: ['unsafe'] } },
    ]) {
      const first = capturedTurn();
      first.splice(1, 0, capturedWorldState());
      const resumed = capturedTurn(
        'Second prompt.',
        'Second response.',
        'turn-2',
      );
      resumed.splice(1, 0, record('world_state', { full: false, state }));
      assert.equal(
        (await load([METADATA, ...first, capturedThreadSettings(), ...resumed]))
          .kind,
        'unavailable',
      );
    }
    const orphaned = capturedTurn();
    orphaned.splice(
      1,
      0,
      record('world_state', {
        full: false,
        state: { plugins_instructions: false },
      }),
    );
    assert.equal((await load([METADATA, ...orphaned])).kind, 'unavailable');
  });

  it('normalizes captured reasoning, add/update/delete patches, and command shapes once each', async () => {
    const records = capturedTurn();
    records.splice(4, 0, ...capturedTools());
    const evidence = await load([METADATA, ...records]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native Codex evidence.');
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.deepEqual(evidence.warnings, []);
    assert.deepEqual(
      trajectory.steps
        .filter(({ reasoning_content }) => reasoning_content)
        .map(({ reasoning_content }) => reasoning_content),
      ['Synthetic private reasoning.'],
    );
    const tools = trajectory.steps.flatMap((step) => step.tool_calls ?? []);
    assert.deepEqual(
      tools.map(({ tool_call_id }) => tool_call_id),
      ['call-add', 'call-update', 'call-delete', 'call-exec'],
    );
    assert.deepEqual(tools[3]?.arguments, {
      cmd: 'pwd',
      max_output_tokens: 1000,
    });
    assert.deepEqual(
      trajectory.steps
        .flatMap((step) => step.observation?.results ?? [])
        .map(({ source_call_id }) => source_call_id),
      ['call-add', 'call-update', 'call-delete', 'call-exec'],
    );
    assert.equal(
      trajectory.steps.filter(({ message: text }) => text === 'First response.')
        .length,
      1,
    );
  });

  it('accepts captured ls/cat/rg classifications and retains failed-command status', async () => {
    for (const parsed of [
      { type: 'list_files', cmd: 'ls .', path: '.' },
      {
        type: 'read',
        cmd: 'cat result.txt',
        name: 'result.txt',
        path: 'result.txt',
      },
      {
        type: 'search',
        cmd: 'rg offline result.txt',
        query: 'offline',
        path: 'result.txt',
      },
    ]) {
      const failed = parsed.type === 'search';
      const records = capturedTurn();
      records.splice(
        4,
        0,
        capturedResponse({
          type: 'function_call',
          id: 'command-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: parsed.cmd }),
          call_id: 'call-exec',
        }),
        capturedItem({
          type: 'CommandExecution',
          id: 'call-exec',
          process_id: '1234',
          command: ['/bin/sh', '-lc', parsed.cmd],
          cwd: 'file:///workspace',
          parsed_cmd: [parsed],
          source: 'unified_exec_startup',
          status: failed ? 'failed' : 'completed',
          stdout: '',
          stderr: '',
          aggregated_output: '',
          exit_code: failed ? 137 : 0,
          duration: { secs: 0, nanos: 1792 },
          formatted_output: '',
        }),
        capturedResponse({
          type: 'function_call_output',
          call_id: 'call-exec',
          output: `Process exited with code ${failed ? 137 : 0}`,
        }),
      );
      const evidence = await load([METADATA, ...records]);
      assert.equal(evidence.kind, 'available');
      if (evidence.kind !== 'available')
        throw new Error('Expected native Codex evidence.');
      const results = parseAtifTrajectory(evidence.trajectory).steps.flatMap(
        (step) => step.observation?.results ?? [],
      );
      assert.deepEqual(results[0]?.extra, { is_error: failed });
      assert.equal(
        results[0]?.content,
        `Process exited with code ${failed ? 137 : 0}`,
      );
    }
  });

  it('fails closed on stale completed-item identities, unknown snapshots, and unmirrored reasoning', async () => {
    const valid = capturedTurn();
    const agent = valid[4]!;
    const user = valid[3]!;
    const variants = [
      valid.map((entry) =>
        entry === agent
          ? record('event_msg', { ...agent.payload, thread_id: OTHER_SESSION })
          : entry,
      ),
      valid.map((entry) =>
        entry === user
          ? record('event_msg', { ...user.payload, turn_id: 'another-turn' })
          : entry,
      ),
      valid.map((entry) =>
        entry === agent
          ? capturedItem({
              type: 'AgentMessage',
              id: 'assistant-turn-1',
              content: [{ type: 'Text', text: 'Different response.' }],
            })
          : entry,
      ),
      valid.map((entry) =>
        entry === agent
          ? capturedItem({ type: 'FutureConversation', id: 'unknown' })
          : entry,
      ),
      [...valid.slice(0, 4), agent, ...valid.slice(4)],
      [
        ...valid.slice(0, 4),
        capturedItem({
          type: 'Reasoning',
          id: 'missing',
          summary_text: ['missing'],
          raw_content: [],
        }),
        ...valid.slice(4),
      ],
      [
        valid[0],
        record('world_state', {
          ...capturedWorldState().payload,
          conversation: 'unknown',
        }),
        ...valid.slice(1),
      ],
      [
        valid[0],
        record('world_state', { full: false, state: {} }),
        ...valid.slice(1),
      ],
      [
        ...valid,
        record('event_msg', {
          ...capturedThreadSettings().payload,
          conversation: 'unknown',
        }),
      ],
    ];
    for (const records of variants) {
      const result = await load([METADATA, ...records]);
      assert.equal(result.kind, 'unavailable');
    }
  });

  it('requires captured tool event/output correlation and known result shapes', async () => {
    for (const event of [
      capturedItem({
        type: 'CommandExecution',
        id: 'orphan',
        status: 'completed',
        stdout: '',
        stderr: '',
      }),
      capturedItem({
        type: 'FileChange',
        id: 'orphan',
        status: 'completed',
        changes: {},
        stdout: '',
        stderr: '',
      }),
    ]) {
      const records = capturedTurn();
      records.splice(4, 0, event);
      assert.equal((await load([METADATA, ...records])).kind, 'unavailable');
    }
    const records = capturedTurn();
    records.splice(
      4,
      0,
      ...capturedPatch('call-unknown', 'patch', {
        '/workspace/path': { type: 'future-change', text: 'unknown' },
      }),
    );
    assert.equal((await load([METADATA, ...records])).kind, 'unavailable');
  });

  it('retains raw source when only a later record contains invalid UTF-8', async () => {
    const raw = Buffer.concat([
      Buffer.from(jsonl([METADATA])),
      Buffer.from([0xff, 0xfe, 10]),
    ]);
    const home = createMemoryWorkspace({ [PATH]: raw }).readonly;
    assert.equal((await loadCodexEvidence(context(home))).kind, 'unavailable');
    assert.deepEqual(
      (await loadCodexNativeArtifact(context(home)))?.body,
      Uint8Array.from(raw),
    );
  });

  it('requires terminal and legacy assistant mirrors to match the current turn', async () => {
    const incomplete = turn('Do the task', 'Starting the task.');
    incomplete[incomplete.length - 1] = record('event_msg', {
      type: 'task_complete',
      turn_id: 'turn-1',
      last_agent_message: 'I could not complete the task.',
    });
    assert.equal((await load([METADATA, ...incomplete])).kind, 'unavailable');
    const second = turn('Continue', 'Second response', 'turn-2');
    second[4] = record('event_msg', {
      type: 'agent_message',
      message: 'First response',
    });
    assert.equal(
      (await load([METADATA, ...turn('Start', 'First response'), ...second]))
        .kind,
      'unavailable',
    );
  });

  it('rejects unknown message channels and content fields instead of exposing them to judges', async () => {
    for (const assistant of [
      record('response_item', {
        ...message('assistant', 'Private reasoning').payload,
        channel: 'analysis',
      }),
      record('response_item', {
        ...message('assistant', 'Done').payload,
        hidden_conversation: 'unknown',
      }),
      record('response_item', {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Done', private_reasoning: 'unknown' },
        ],
      }),
    ]) {
      const records = turn(
        'Do the task',
        Array.isArray(assistant.payload.content)
          ? String((assistant.payload.content[0] as { text: unknown }).text)
          : 'Done',
      );
      records[5] = assistant;
      const result = await load([METADATA, ...records]);
      assert.equal(result.kind, 'unavailable');
      if (result.kind === 'unavailable')
        assert.equal(result.reason.code, 'source_incomplete');
    }
  });

  it('selects the exact root session among unrelated and newer rollouts', async () => {
    const raw = jsonl([
      METADATA,
      ...turn(),
      ...turn('Continue', 'Finished', 'turn-2'),
    ]);
    const workspace = createMemoryWorkspace({
      [PATH]: raw,
      [`sessions/2026/09/23/rollout-2026-09-23T12-00-00-${OTHER_SESSION}.jsonl`]:
        'unrelated and malformed',
      [`archived_sessions/rollout-2026-09-22T12-00-00-${SESSION}.jsonl`]:
        'not a live run-owned rollout',
      'auth.json': 'never read this file',
    });
    const reads: string[] = [];
    const home: ReadonlyWorkspace = {
      ...workspace.readonly,
      async readFile(relative, options) {
        reads.push(relative);
        return workspace.readonly.readFile(relative, options);
      },
    };
    const evidence = await loadCodexEvidence(context(home));
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native Codex evidence.');
    assert.deepEqual(evidence.source, {
      kind: 'native_log',
      format: 'codex-rollout-jsonl',
      sessionId: SESSION,
    });
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.deepEqual(
      trajectory.steps.map(({ source, message: text }) => ({ source, text })),
      [
        { source: 'system', text: 'Base agent instructions.' },
        { source: 'user', text: 'Do the task' },
        { source: 'agent', text: 'Done' },
        { source: 'user', text: 'Continue' },
        { source: 'agent', text: 'Finished' },
      ],
    );
    assert.deepEqual(reads, [PATH]);
    assert.equal(trajectory.agent.version, VERSION);
    const artifact = await loadCodexNativeArtifact(context(home));
    assert.equal(Buffer.from(artifact?.body ?? []).toString(), raw);
    assert.equal(artifact?.sessionId, SESSION);
    assert.deepEqual(reads, [PATH, PATH]);
  });

  it('preserves developer and rendered startup context as system evidence', async () => {
    const instructions =
      '# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>Use the test runner.</INSTRUCTIONS>';
    const environment =
      '<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>';
    const evidence = await load([
      METADATA,
      message('developer', 'Developer instructions.'),
      message('user', instructions),
      message('user', environment),
      ...turn(),
    ]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native Codex evidence.');
    const steps = parseAtifTrajectory(evidence.trajectory).steps;
    assert.deepEqual(
      steps
        .filter(({ source }) => source === 'user')
        .map(({ message: text }) => text),
      ['Do the task'],
    );
    assert.deepEqual(
      steps
        .filter(({ source }) => source === 'system')
        .map(({ message: text }) => text),
      [
        'Base agent instructions.',
        'Developer instructions.',
        instructions,
        environment,
      ],
    );
  });

  it('keeps a real driver prompt which resembles injected context user-visible', async () => {
    const prompt =
      '# AGENTS.md instructions for /workspace\n\nReview these instructions.';
    const evidence = await load([METADATA, ...turn(prompt)]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native Codex evidence.');
    assert.equal(
      parseAtifTrajectory(evidence.trajectory).steps[1]?.source,
      'user',
    );
  });

  it('retains function/custom calls, exact outputs, and private reasoning', async () => {
    const records = turn();
    records.splice(
      4,
      0,
      record('response_item', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Private plan' }],
        encrypted_content: 'ciphertext',
      }),
      record('response_item', {
        type: 'function_call',
        call_id: 'call-1',
        namespace: 'functions',
        name: 'exec_command',
        arguments: JSON.stringify({
          command: 'pwd',
          reasoning_content: 'opaque tool argument',
        }),
      }),
      record('response_item', {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '/workspace\n',
      }),
      record('response_item', {
        type: 'custom_tool_call',
        call_id: 'call-2',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
      }),
      record('response_item', {
        type: 'custom_tool_call_output',
        call_id: 'call-2',
        output: 'Patch failed',
        is_error: true,
      }),
    );
    const evidence = await load([METADATA, ...records]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available')
      throw new Error('Expected native Codex evidence.');
    const steps = parseAtifTrajectory(evidence.trajectory).steps;
    assert.equal(steps[2]?.reasoning_content, 'Private plan');
    const command = steps[3];
    assert.deepEqual(command?.tool_calls, [
      {
        tool_call_id: 'call-1',
        function_name: 'functions.exec_command',
        arguments: {
          command: 'pwd',
          reasoning_content: 'opaque tool argument',
        },
      },
    ]);
    assert.deepEqual(command?.observation?.results, [
      { source_call_id: 'call-1', content: '/workspace\n' },
    ]);
    assert.deepEqual(steps[4]?.observation?.results, [
      {
        source_call_id: 'call-2',
        content: 'Patch failed',
        extra: { is_error: true },
      },
    ]);
    assert.equal(evidence.warnings[0]?.code, 'value_omitted');
  });

  it('rejects ambiguous matching paths rather than selecting a newest session', async () => {
    const home = createMemoryWorkspace({
      [PATH]: jsonl([METADATA, ...turn()]),
      [`sessions/2026/09/23/rollout-2026-09-23T12-00-00-${SESSION}.jsonl`]:
        jsonl([METADATA, ...turn()]),
    }).readonly;
    const evidence = await loadCodexEvidence(context(home));
    assert.deepEqual(evidence.kind, 'unavailable');
    assert.equal(await loadCodexNativeArtifact(context(home)), undefined);
  });

  it('rejects native version, model, and turn contradictions while retaining the exact root source', async () => {
    const records = capturedTurn();
    for (const [description, candidate] of [
      [
        'different CLI version',
        [
          record('session_meta', { ...METADATA.payload, cli_version: '0.0.0' }),
          ...records,
        ],
      ],
      [
        'different model',
        [
          METADATA,
          ...records.map((entry, index) =>
            index === 1
              ? record('turn_context', {
                  ...entry.payload,
                  model: 'other-model',
                })
              : entry,
          ),
        ],
      ],
      [
        'different turn',
        [
          METADATA,
          ...records.map((entry, index) =>
            index === 1
              ? record('turn_context', {
                  ...entry.payload,
                  turn_id: 'other-turn',
                })
              : entry,
          ),
        ],
      ],
      [
        'repeated session metadata',
        [METADATA, records[0], METADATA, ...records.slice(1)],
      ],
    ] as const) {
      const raw = jsonl(candidate);
      const home = createMemoryWorkspace({ [PATH]: raw }).readonly;
      const evidence = await loadCodexEvidence(context(home));
      assert.equal(evidence.kind, 'unavailable', description);
      if (evidence.kind !== 'unavailable')
        throw new Error(`Expected invalid ${description} evidence.`);
      assert.equal(evidence.reason.code, 'source_invalid', description);
      assert.equal(
        Buffer.from(
          (await loadCodexNativeArtifact(context(home)))!.body,
        ).toString(),
        raw,
      );
    }
  });

  it('normalizes primary terminal sessions only when explicitly selected', async () => {
    const raw = jsonl([
      record('session_meta', { ...METADATA.payload, source: 'cli' }),
      ...turn(),
    ]);
    const home = createMemoryWorkspace({ [PATH]: raw }).readonly;
    const input = { ...context(home), sessionSource: 'cli' as const };
    assert.equal((await loadCodexEvidence(input)).kind, 'available');
    assert.equal(
      Buffer.from((await loadCodexNativeArtifact(input))!.body).toString(),
      raw,
    );
    assert.equal((await loadCodexEvidence(context(home))).kind, 'unavailable');
  });

  it('requires the exact primary session when terminal sessions are selected', async () => {
    const metadata = { ...METADATA.payload, source: 'cli' };
    for (const invalid of [
      { ...metadata, source: 'exec' },
      { ...metadata, id: OTHER_SESSION },
      { ...metadata, parent_thread_id: OTHER_SESSION },
      { ...metadata, forked_from_id: OTHER_SESSION },
    ]) {
      const home = createMemoryWorkspace({
        [PATH]: jsonl([record('session_meta', invalid), ...turn()]),
      }).readonly;
      const input = { ...context(home), sessionSource: 'cli' as const };
      assert.equal((await loadCodexEvidence(input)).kind, 'unavailable');
      assert.equal(await loadCodexNativeArtifact(input), undefined);
    }
  });

  for (const [description, metadata] of [
    ['different session', { ...METADATA.payload, id: OTHER_SESSION }],
    ['TUI session', { ...METADATA.payload, source: 'cli' }],
    ['subagent', { ...METADATA.payload, source: { subagent: 'review' } }],
    ['parent thread', { ...METADATA.payload, parent_thread_id: OTHER_SESSION }],
    ['forked thread', { ...METADATA.payload, forked_from_id: OTHER_SESSION }],
    [
      'conflicting legacy ID',
      { ...METADATA.payload, session_id: OTHER_SESSION },
    ],
  ] as const) {
    it(`rejects ${description} metadata despite an exact matching filename`, async () => {
      const home = createMemoryWorkspace({
        [PATH]: jsonl([record('session_meta', metadata), ...turn()]),
      }).readonly;
      assert.equal(
        (await loadCodexEvidence(context(home))).kind,
        'unavailable',
      );
      assert.equal(await loadCodexNativeArtifact(context(home)), undefined);
    });
  }

  it('never follows a selected file or parent symlink', async () => {
    const memory = createMemoryWorkspace({
      [PATH]: jsonl([METADATA, ...turn()]),
    }).readonly;
    for (const unsafe of [PATH, 'sessions/2026/09']) {
      let reads = 0;
      const home: ReadonlyWorkspace = {
        ...memory,
        async inspect(relative) {
          return relative === unsafe
            ? { path: relative, kind: 'symlink' }
            : memory.inspect(relative);
        },
        async readFile() {
          reads += 1;
          throw new Error('A symlink must not be read.');
        },
      };
      assert.equal(
        (await loadCodexEvidence(context(home))).kind,
        'unavailable',
      );
      assert.equal(reads, 0);
    }
  });

  it('does not find matching files outside the prescribed bounded date tree', async () => {
    for (const target of [
      `sessions/rollout-2026-09-22T12-00-00-${SESSION}.jsonl`,
      `sessions/2026/09/22/subagents/rollout-2026-09-22T12-00-00-${SESSION}.jsonl`,
    ]) {
      const evidence = await loadCodexEvidence(
        context(
          createMemoryWorkspace({ [target]: jsonl([METADATA, ...turn()]) })
            .readonly,
        ),
      );
      assert.equal(evidence.kind, 'unavailable');
    }
  });

  it('retains exact native bytes when later records are malformed or compacted', async () => {
    for (const tail of [
      'not-json\n',
      jsonl([record('compacted', { message: 'summary' })]),
    ]) {
      const raw = `${jsonl([METADATA])}${tail}`;
      const home = createMemoryWorkspace({ [PATH]: raw }).readonly;
      assert.equal(
        (await loadCodexEvidence(context(home))).kind,
        'unavailable',
      );
      assert.equal(
        Buffer.from(
          (await loadCodexNativeArtifact(context(home)))?.body ?? [],
        ).toString(),
        raw,
      );
    }
  });

  it('classifies unknown conversation shapes, media, and unfinished turns as incomplete', async () => {
    const variants = [
      [METADATA, ...turn().slice(0, -1)],
      [
        METADATA,
        record('future_record', { content: 'conversation' }),
        ...turn(),
      ],
      [
        METADATA,
        ...turn(),
        record('event_msg', { type: 'future_event', message: 'conversation' }),
      ],
      [
        METADATA,
        ...turn(),
        record('response_item', {
          type: 'future_item',
          content: 'conversation',
        }),
      ],
      [METADATA, ...turn(), record('event_msg', { type: 'turn_aborted' })],
      [
        METADATA,
        message('user', 'Unclassified additional user content'),
        ...turn(),
      ],
      [
        METADATA,
        message('developer', 'context'),
        ...turn().map((entry) =>
          entry.type === 'event_msg' && entry.payload.type === 'user_message'
            ? record('event_msg', { ...entry.payload, images: ['image'] })
            : entry,
        ),
      ],
    ];
    for (const records of variants) {
      const result = await load(records);
      assert.equal(result.kind, 'unavailable');
      if (result.kind === 'unavailable')
        assert.equal(result.reason.code, 'source_incomplete');
    }
  });

  it('rejects orphan/duplicate outputs and incomplete tool calls', async () => {
    for (const calls of [
      [
        record('response_item', {
          type: 'function_call_output',
          call_id: 'unknown',
          output: 'unclaimed',
        }),
      ],
      [
        record('response_item', {
          type: 'function_call',
          call_id: 'c',
          name: 'tool',
          arguments: '{}',
        }),
      ],
      [
        record('response_item', {
          type: 'function_call',
          call_id: 'c',
          name: 'tool',
          arguments: '{}',
        }),
        record('response_item', {
          type: 'function_call_output',
          call_id: 'c',
          output: 'first',
        }),
        record('response_item', {
          type: 'function_call_output',
          call_id: 'c',
          output: 'second',
        }),
      ],
    ]) {
      const records = turn();
      records.splice(4, 0, ...calls);
      assert.equal((await load([METADATA, ...records])).kind, 'unavailable');
    }
  });

  it('bounds traversal, source bytes, line bytes, and nested JSON before normalization', async () => {
    const memory = createMemoryWorkspace({
      [PATH]: jsonl([METADATA, ...turn()]),
    }).readonly;
    const tooMany: ReadonlyWorkspace = {
      ...memory,
      async listFiles(options) {
        assert.equal(options?.under, 'sessions');
        assert.equal(options?.maxEntries, 10_000);
        return Array.from({ length: 10_001 }, (_, i) => ({
          path: `sessions/${i}`,
          kind: 'file' as const,
        }));
      },
    };
    assert.equal(
      (await loadCodexEvidence(context(tooMany))).kind,
      'unavailable',
    );
    let reads = 0;
    const tooLarge: ReadonlyWorkspace = {
      ...memory,
      async inspect(relative) {
        return relative === PATH
          ? { path: relative, kind: 'file', size: 16 * 1024 * 1024 + 1 }
          : memory.inspect(relative);
      },
      async readFile() {
        reads += 1;
        return new Uint8Array();
      },
    };
    assert.equal(
      (await loadCodexEvidence(context(tooLarge))).kind,
      'unavailable',
    );
    assert.equal(reads, 0);
    assert.equal(
      (await load([METADATA, ...turn('x'.repeat(1024 * 1024 + 1))])).kind,
      'unavailable',
    );
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    assert.equal(
      (
        await load([
          record('session_meta', { ...METADATA.payload, nested }),
          ...turn(),
        ])
      ).kind,
      'unavailable',
    );
  });

  it('checks actual read bytes and cumulative line and JSON budgets', async () => {
    const valid = jsonl([METADATA, ...turn()]);
    const memory = createMemoryWorkspace({ [PATH]: valid }).readonly;
    const overflow = new Uint8Array(16 * 1024 * 1024 + 1).fill(10);
    overflow.set(Buffer.from(valid));
    const oversized: ReadonlyWorkspace = {
      ...memory,
      async readFile(relative, options) {
        assert.equal(relative, PATH);
        assert.equal(options?.maxBytes, 16 * 1024 * 1024);
        return overflow;
      },
    };
    const evidence = await loadCodexEvidence(context(oversized));
    assert.equal(evidence.kind, 'unavailable');
    if (evidence.kind !== 'unavailable')
      throw new Error('Expected incomplete oversized evidence.');
    assert.equal(evidence.reason.code, 'source_incomplete');
    assert.equal(await loadCodexNativeArtifact(context(oversized)), undefined);

    const nodes = record('event_msg', {
      type: 'token_count',
      info: { values: Array.from({ length: 60_000 }, () => 0) },
    });
    const single = turn();
    single.splice(4, 0, nodes);
    assert.equal((await load([METADATA, ...single])).kind, 'available');
    const aggregate = turn();
    aggregate.splice(4, 0, nodes, nodes);
    for (const raw of [
      valid + '\n'.repeat(100_001),
      jsonl([METADATA, ...aggregate]),
    ]) {
      const home = createMemoryWorkspace({ [PATH]: raw }).readonly;
      const bounded = await loadCodexEvidence(context(home));
      assert.equal(bounded.kind, 'unavailable');
      if (bounded.kind !== 'unavailable')
        throw new Error('Expected incomplete aggregate evidence.');
      assert.equal(bounded.reason.code, 'source_incomplete');
      assert.equal(
        Buffer.from(
          (await loadCodexNativeArtifact(context(home)))!.body,
        ).toString(),
        raw,
      );
    }
  });

  it('does not hide cancellation as a missing-source fallback', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled test');
    const memory = createMemoryWorkspace({
      [PATH]: jsonl([METADATA, ...turn()]),
    }).readonly;
    const home: ReadonlyWorkspace = {
      ...memory,
      async listFiles() {
        controller.abort(reason);
        throw reason;
      },
    };
    await assert.rejects(
      loadCodexEvidence(context(home, controller.signal)),
      reason,
    );
    await assert.rejects(
      loadCodexNativeArtifact(context(home, controller.signal)),
      reason,
    );
  });
});
