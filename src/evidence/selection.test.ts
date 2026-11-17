import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type {
  AgentAdapter,
  AgentNativeEvidenceResult,
  AgentToolCall,
} from '../contracts/agent.ts';
import { createSecretRedactor } from '../security/redaction.ts';
import {
  type CompletedEvidenceTurn,
  parseAgentEvidenceIdentity,
  selectAgentEvidence,
  trajectoryCoversCompletedTurns,
} from './selection.ts';

const SESSION_ID = 'session-1';
const agent = {
  id: 'test-agent',
  version: 'adapter-1',
} as AgentAdapter;
const identity = { name: 'test-agent-binary', version: '2.0.0' };
const UNAVAILABLE = {
  code: 'source_unavailable' as const,
  message: 'No native source.',
};

describe('selectAgentEvidence', () => {
  it('keeps bounded argument text and correlated tool output with visible truncation', () => {
    const selected = select(
      completeNativeSteps(),
      {
        kind: 'unavailable',
        reason: { code: 'source_invalid', message: 'No native source.' },
      },
      [
        {
          id: 'read',
          name: 'Read',
          input: { command: `START${'x'.repeat(10_000)}` },
          result: { content: `OUTPUT${'x'.repeat(20_000)}`, isError: true },
        },
      ],
    );
    const step = selected.trajectory.steps[1]!;
    assert.equal(step.source, 'agent');
    const argumentsText =
      step.tool_calls?.[0]?.arguments.forge_truncated_arguments;
    assert.equal(typeof argumentsText, 'string');
    assert.match(String(argumentsText), /START/);
    assert.match(String(argumentsText), /Forge truncated/);
    assert.ok(String(argumentsText).length <= 4096);
    const result = step.observation?.results[0];
    assert.equal(result?.source_call_id, 'read');
    assert.equal(result?.extra?.is_error, true);
    assert.match(String(result?.content), /^OUTPUT.*Forge truncated/s);
    assert.ok(String(result?.content).length <= 8192);
    assert.ok(selected.warnings.some(({ code }) => code === 'value_omitted'));
  });
  it('prefers structurally complete native detail despite lossy projection differences', () => {
    const selected = select([
      { step_id: 1, source: 'user', message: 'First prompt' },
      {
        step_id: 2,
        source: 'agent',
        message: 'Persisted intermediate response',
        tool_calls: [
          {
            tool_call_id: 'native-call',
            function_name: 'NativeWrite',
            arguments: { path: 'native.txt' },
          },
        ],
      },
      { step_id: 3, source: 'user', message: 'Second prompt' },
      {
        step_id: 4,
        source: 'agent',
        message: '',
        reasoning_content: 'thinking',
      },
      { step_id: 5, source: 'agent', message: 'Persisted final response' },
    ]);

    assert.equal(selected.completeness, 'complete');
    assert.equal(selected.provenance.source.kind, 'native_log');
    assert.equal(selected.trajectory.steps.length, 5);
  });

  it('accepts tool activity as response evidence without requiring byte parity', () => {
    const selected = select([
      { step_id: 1, source: 'user', message: 'First prompt' },
      {
        step_id: 2,
        source: 'agent',
        message: '',
        tool_calls: [
          {
            tool_call_id: 'native-call',
            function_name: 'DifferentProjection',
            arguments: {},
          },
        ],
      },
      { step_id: 3, source: 'user', message: 'Second prompt' },
      { step_id: 4, source: 'agent', message: 'Native response' },
    ]);

    assert.equal(selected.completeness, 'complete');
    assert.equal(selected.provenance.source.kind, 'native_log');
  });

  it('preserves harmless native-detail warnings only after coverage succeeds', () => {
    const selected = select(completeNativeSteps(), {
      kind: 'available',
      trajectory: trajectory(completeNativeSteps()),
      source: nativeSource(),
      warnings: [
        {
          code: 'value_omitted',
          message: 'An invalid timestamp was omitted.',
        },
      ],
    });

    assert.equal(selected.completeness, 'partial');
    assert.equal(selected.warnings[0]?.code, 'value_omitted');
  });

  for (const [description, steps] of [
    [
      'missing final turn',
      [
        { step_id: 1, source: 'user', message: 'First prompt' },
        { step_id: 2, source: 'agent', message: 'First native response' },
      ],
    ],
    [
      'extra native turn',
      [
        ...completeNativeSteps(),
        { step_id: 5, source: 'user', message: 'Unexpected prompt' },
        { step_id: 6, source: 'agent', message: 'Unexpected response' },
      ],
    ],
    [
      'reordered prompts',
      [
        { step_id: 1, source: 'user', message: 'Second prompt' },
        { step_id: 2, source: 'agent', message: 'First native response' },
        { step_id: 3, source: 'user', message: 'First prompt' },
        { step_id: 4, source: 'agent', message: 'Second native response' },
      ],
    ],
  ] as const) {
    it(`uses the complete driver ledger for ${description}`, () => {
      const selected = select(steps);

      assert.equal(selected.completeness, 'fallback');
      assert.equal(selected.provenance.source.kind, 'driver_fallback');
      assert.deepEqual(
        selected.trajectory.steps.map(({ source, message }) => ({
          source,
          message,
        })),
        [
          { source: 'user', message: 'First prompt' },
          { source: 'agent', message: 'First driver response' },
          { source: 'user', message: 'Second prompt' },
          { source: 'agent', message: 'Second driver response' },
        ],
      );
      assert.deepEqual(
        selected.warnings.map(({ code }) => code),
        ['source_incomplete', 'fallback_used'],
      );
    });
  }

  it('does not count reasoning-only native output as response evidence', () => {
    const selected = select([
      { step_id: 1, source: 'user', message: 'First prompt' },
      {
        step_id: 2,
        source: 'agent',
        message: '',
        reasoning_content: 'thinking',
      },
      { step_id: 3, source: 'user', message: 'Second prompt' },
      { step_id: 4, source: 'agent', message: 'Second native response' },
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('does not count an empty text content part as response evidence', () => {
    const selected = select([
      { step_id: 1, source: 'user', message: 'First prompt' },
      {
        step_id: 2,
        source: 'agent',
        message: [{ type: 'text', text: '' }],
      },
      { step_id: 3, source: 'user', message: 'Second prompt' },
      { step_id: 4, source: 'agent', message: 'Second native response' },
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('turns an adapter-unavailable result into explicit whole-trajectory fallback', () => {
    const selected = select(completeNativeSteps(), {
      kind: 'unavailable',
      reason: {
        code: 'source_invalid',
        message: 'The exact native session could not be parsed.',
      },
    });

    assert.equal(selected.completeness, 'fallback');
    assert.deepEqual(
      selected.warnings.map(({ code }) => code),
      ['source_invalid', 'fallback_used'],
    );
  });

  it('assigns unique deterministic IDs when driver tool-call IDs collide', () => {
    const selected = select(
      completeNativeSteps(),
      {
        kind: 'unavailable',
        reason: {
          code: 'source_unavailable',
          message: 'The exact native session is unavailable.',
        },
      },
      [
        { id: 'duplicate', name: 'First', input: {} },
        { id: 'duplicate', name: 'Second', input: {} },
        { id: 'driver-call-2-3', name: 'Third', input: {} },
        { name: 'Fourth', input: {} },
      ],
    );

    const firstAgentStep = selected.trajectory.steps[1];
    assert.equal(firstAgentStep?.source, 'agent');
    assert.deepEqual(
      firstAgentStep?.tool_calls?.map(({ tool_call_id }) => tool_call_id),
      ['duplicate', 'driver-call-2-2-1', 'driver-call-2-3', 'driver-call-2-4'],
    );
  });

  it('bounds lossy fallback detail while retaining every logical turn', () => {
    const longAssistant = 'x'.repeat(5 * 1024 * 1024);
    const toolCalls = Array.from({ length: 300 }, (_, index) => ({
      id: `call-${index}`,
      name: 'Tool',
      input: index === 0 ? { value: 'x'.repeat(300) } : { index },
    }));
    const selected = select(
      completeNativeSteps(),
      {
        kind: 'unavailable',
        reason: {
          code: 'source_unavailable',
          message: 'The exact native session is unavailable.',
        },
      },
      toolCalls,
      longAssistant,
    );

    const firstAgentStep = selected.trajectory.steps[1];
    assert.equal(firstAgentStep?.source, 'agent');
    assert.ok(
      typeof firstAgentStep?.message === 'string' &&
        firstAgentStep.message.length > 0 &&
        firstAgentStep.message.length < longAssistant.length,
    );
    assert.equal(firstAgentStep?.tool_calls?.length, 256);
    assert.deepEqual(firstAgentStep?.tool_calls?.[0]?.arguments, {
      value: 'x'.repeat(300),
    });
    assert.deepEqual(
      selected.warnings.map(({ code }) => code),
      ['source_unavailable', 'value_omitted', 'fallback_used'],
    );
    assert.deepEqual(
      selected.trajectory.steps
        .filter(({ source }) => source === 'user')
        .map(({ message }) => message),
      ['First prompt', 'Second prompt'],
    );
  });

  it('reserves fallback tool activity for every turn at the ledger limit', () => {
    const completedTurns = Array.from({ length: 100 }, (_, turn) => ({
      user: `Prompt ${turn}`,
      assistant: '',
      toolCalls: Array.from({ length: 4 }, (_, call) => ({
        id: `turn-${turn}-call-${call}`,
        name: 'Tool',
        input: { turn, call },
      })),
    }));
    const selected = selectAgentEvidence({
      agent,
      identity,
      model: 'test-model',
      sessionId: SESSION_ID,
      completedTurns,
      collected: {
        kind: 'unavailable',
        reason: { code: 'source_unavailable', message: 'No native source.' },
      },
    });

    assert.equal(selected.trajectory.steps.length, 200);
    const agentSteps = selected.trajectory.steps.filter(
      ({ source }) => source === 'agent',
    );
    assert.equal(
      agentSteps.reduce(
        (total, step) => total + (step.tool_calls?.length ?? 0),
        0,
      ),
      256,
    );
    for (const [turn, step] of agentSteps.entries()) {
      assert.equal(step.tool_calls?.[0]?.tool_call_id, `turn-${turn}-call-0`);
    }
    assert.equal(
      trajectoryCoversCompletedTurns(
        selected.trajectory,
        completedTurns,
        selected.provenance.source,
      ),
      true,
    );
    assert.deepEqual(
      selected.warnings.map(({ code }) => code),
      ['source_unavailable', 'value_omitted', 'fallback_used'],
    );

    for (const turns of [[], [...completedTurns, completedTurns[0]!]]) {
      assert.throws(
        () =>
          selectAgentEvidence({
            agent,
            identity,
            model: 'test-model',
            sessionId: SESSION_ID,
            completedTurns: turns,
            collected: {
              kind: 'unavailable',
              reason: { code: 'source_unavailable', message: 'No source.' },
            },
          }),
        /between 1 and 100 completed turns/,
      );
    }
  });

  it('preserves safe fallback arguments and explicitly omits unsafe tool input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep = Array.from({ length: 17 }).reduce<unknown>(
      (value) => ({ value }),
      null,
    );
    const omittedArguments = {
      forge_omitted_arguments: '[Forge omitted unavailable tool arguments.]',
    };
    const cases: readonly {
      input: unknown;
      expected: Record<string, unknown>;
      omitted: boolean;
    }[] = [
      { input: undefined, expected: {}, omitted: false },
      {
        input: { path: 'safe.txt', options: [true, null, 3] },
        expected: { path: 'safe.txt', options: [true, null, 3] },
        omitted: false,
      },
      { input: 'argument', expected: { value: 'argument' }, omitted: false },
      { input: [1, 2], expected: { value: [1, 2] }, omitted: false },
      { input: cyclic, expected: omittedArguments, omitted: true },
      {
        input: { value: Number.POSITIVE_INFINITY },
        expected: omittedArguments,
        omitted: true,
      },
      { input: { value: 1n }, expected: omittedArguments, omitted: true },
      {
        input: { value: undefined },
        expected: omittedArguments,
        omitted: true,
      },
      {
        input: { value: new Map([['key', 'value']]) },
        expected: omittedArguments,
        omitted: true,
      },
      {
        input: JSON.parse('{"__proto__":{"polluted":true},"path":"safe.txt"}'),
        expected: omittedArguments,
        omitted: true,
      },
      {
        input: deep,
        expected: {
          forge_truncated_arguments: `${JSON.stringify(deep)}\n[Forge truncated driver evidence.]`,
        },
        omitted: true,
      },
    ];

    for (const [index, { input, expected, omitted }] of cases.entries()) {
      const selected = select(
        completeNativeSteps(),
        {
          kind: 'unavailable',
          reason: { code: 'source_unavailable', message: 'No native source.' },
        },
        [{ name: 'Tool', input }],
      );
      assert.deepEqual(
        selected.trajectory.steps[1]?.tool_calls?.[0]?.arguments,
        expected,
        `input ${index}`,
      );
      assert.equal(
        selected.warnings.some(({ code }) => code === 'value_omitted'),
        omitted,
        `input ${index}`,
      );
      assert.equal(selected.completeness, 'fallback');
    }
  });

  it('ignores system and copied context but requires an agent step for an empty completed response', () => {
    const completedTurns = [{ user: 'Prompt', assistant: '', toolCalls: [] }];
    const steps = [
      { step_id: 1, source: 'system', message: 'Runtime context' },
      {
        step_id: 2,
        source: 'user',
        message: 'Old prompt',
        is_copied_context: true,
      },
      {
        step_id: 3,
        source: 'agent',
        message: 'Old response',
        is_copied_context: true,
      },
      { step_id: 4, source: 'user', message: 'Prompt' },
      { step_id: 5, source: 'agent', message: '' },
    ];
    assert.equal(
      selectCodex(steps, completedTurns, 'claude-code-jsonl').completeness,
      'complete',
    );
    assert.equal(
      selectCodex(steps.slice(0, -1), completedTurns, 'claude-code-jsonl')
        .completeness,
      'fallback',
    );
    assert.equal(
      selectCodex(
        [
          { step_id: 1, source: 'agent', message: 'Unattributed response' },
          { step_id: 2, source: 'user', message: 'Prompt' },
          { step_id: 3, source: 'agent', message: '' },
        ],
        completedTurns,
        'claude-code-jsonl',
      ).completeness,
      'fallback',
    );
  });

  it('rejects an available candidate which contradicts the selected session', () => {
    for (const [trajectorySession, sourceSession] of [
      ['other', SESSION_ID],
      [SESSION_ID, 'other'],
    ]) {
      assert.throws(
        () =>
          select(completeNativeSteps(), {
            kind: 'available',
            trajectory: {
              ...trajectory(completeNativeSteps()),
              session_id: trajectorySession,
            },
            source: { ...nativeSource(), sessionId: sourceSession! },
            warnings: [],
          }),
        /selected agent session/,
      );
    }
  });

  it('rejects source-state warnings on an available native candidate', () => {
    assert.throws(
      () =>
        select(completeNativeSteps(), {
          kind: 'available',
          trajectory: trajectory(completeNativeSteps()),
          source: nativeSource(),
          warnings: [
            {
              code: 'source_incomplete',
              message: 'This must use the unavailable result variant.',
            },
          ],
        } as unknown as AgentNativeEvidenceResult),
      /source-state or fallback warning/,
    );
  });
});

describe('Codex native completed-turn coverage', () => {
  it('accepts genuine no-tool turns without requiring assistant text byte parity', () => {
    const selected = selectCodex(codexSteps([]), [
      {
        user: 'Prompt',
        assistant: 'Live final answer',
        toolCalls: [],
      },
    ]);

    assert.equal(selected.completeness, 'complete');
    assert.deepEqual(selected.warnings, []);
  });

  it('accepts comparable tool categories despite native IDs, arguments, and extra polling calls', () => {
    const selected = selectCodex(
      codexSteps([
        'functions.exec_command',
        'functions.write_stdin',
        'apply_patch',
        'functions.update_plan',
        'mcp__docs.search',
        'mcp__docs__lookup',
        'web_search',
      ]),
      [
        {
          user: 'Prompt',
          assistant: 'Live final answer',
          toolCalls: [
            {
              id: 'live-command',
              name: 'command_execution',
              input: { command: 'pwd' },
            },
            { name: 'file_change', input: { changes: [] } },
            { name: 'todo_list', input: { items: [] } },
            { name: 'mcp__docs__search', input: { query: 'example' } },
            { name: 'mcp__docs__lookup', input: { id: 1 } },
            { name: 'web_search', input: { query: 'example' } },
          ],
        },
      ],
    );

    assert.equal(selected.completeness, 'complete');
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 7);
  });

  for (const [nativeName, liveName] of [
    ['mcp__my__server.probe', 'mcp__my__server__probe'],
    ['mcp__my__server__probe', 'mcp__my__server__probe'],
    ['mcp__my__server.probe.v1', 'mcp__my__server__probe.v1'],
  ] as const) {
    it(`accepts MCP server names containing __ in ${nativeName}`, () => {
      const selected = selectCodex(codexSteps([nativeName]), [
        {
          user: 'Prompt',
          assistant: 'Live final answer',
          toolCalls: [{ name: liveName }],
        },
      ]);

      assert.equal(selected.completeness, 'complete');
      assert.deepEqual(selected.warnings, []);
    });
  }

  for (const [description, names] of [
    ['an entire missing tool pair', []],
    [
      'native-only discovery masking the missing execution',
      ['tool_search', 'functions.tool_search'],
    ],
    [
      'a different tool category masking the missing execution',
      ['apply_patch'],
    ],
    ['an unrecognized execution alias', ['shell']],
    ['a differently cased execution name', ['Exec_Command']],
    [
      'an unrelated namespace using the same tool basename',
      ['custom.exec_command'],
    ],
  ] as const) {
    it(`falls back for ${description} even when the assistant answer remains`, () => {
      const selected = selectCodex(codexSteps(names));

      assert.equal(selected.completeness, 'fallback');
      assert.deepEqual(
        selected.warnings.map(({ code }) => code),
        ['source_incomplete', 'fallback_used'],
      );
      assert.equal(
        selected.trajectory.steps[1]?.tool_calls?.[0]?.function_name,
        'command_execution',
      );
    });
  }

  it('requires at least the live count in each comparable category', () => {
    const selected = selectCodex(codexSteps(['exec_command', 'tool_search']), [
      {
        user: 'Prompt',
        assistant: 'Live final answer',
        toolCalls: [
          { id: 'live-first', name: 'command_execution' },
          { id: 'live-second', name: 'command_execution' },
        ],
      },
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('preserves exact MCP tool-name case instead of treating other MCP activity as coverage', () => {
    const selected = selectCodex(
      codexSteps(['mcp__docs.Search', 'mcp__docs.lookup']),
      [
        {
          user: 'Prompt',
          assistant: 'Live final answer',
          toolCalls: [{ name: 'mcp__docs__search' }],
        },
      ],
    );

    assert.equal(selected.completeness, 'fallback');
  });

  it('fails coverage for an unmapped live tool instead of counting arbitrary native calls', () => {
    const selected = selectCodex(codexSteps(['unknown_tool']), [
      {
        user: 'Prompt',
        assistant: 'Live final answer',
        toolCalls: [{ name: 'unknown_tool' }],
      },
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  for (const message of ['', [{ type: 'text', text: '' }]] as const) {
    it(`requires separate visible assistant text when live text exists (${JSON.stringify(message)})`, () => {
      const steps = codexSteps(['exec_command'], message);
      steps[1] = {
        ...steps[1],
        reasoning_content: 'Only private reasoning remains.',
      };
      assert.equal(selectCodex(steps).completeness, 'fallback');
    });
  }

  it('does not require assistant text for a genuinely tool-only live turn', () => {
    const selected = selectCodex(codexSteps(['exec_command'], ''), [
      {
        user: 'Prompt',
        assistant: '',
        toolCalls: [{ name: 'command_execution' }],
      },
    ]);

    assert.equal(selected.completeness, 'complete');
  });

  it('accepts visible assistant text content parts alongside native tool activity', () => {
    const selected = selectCodex(
      codexSteps(
        ['exec_command'],
        [
          { type: 'text', text: '' },
          { type: 'text', text: 'Native answer' },
        ],
      ),
    );

    assert.equal(selected.completeness, 'complete');
  });

  it('does not let a later turn compensate for an earlier missing tool pair', () => {
    const selected = selectCodex(
      [
        ...codexSteps([]),
        { step_id: 3, source: 'user', message: 'Next prompt' },
        { ...codexSteps(['exec_command', 'write_stdin'])[1], step_id: 4 },
      ],
      [
        {
          user: 'Prompt',
          assistant: 'First answer',
          toolCalls: [{ name: 'command_execution' }],
        },
        {
          user: 'Next prompt',
          assistant: 'Second answer',
          toolCalls: [{ name: 'command_execution' }],
        },
      ],
    );

    assert.equal(selected.completeness, 'fallback');
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 1);
    assert.equal(selected.trajectory.steps[3]?.tool_calls?.length, 1);
  });

  it('does not let later text compensate for an earlier missing assistant answer', () => {
    const selected = selectCodex(
      [
        ...codexSteps(['exec_command'], ''),
        { step_id: 3, source: 'user', message: 'Next prompt' },
        {
          step_id: 4,
          source: 'agent',
          message: 'First answer\n\nSecond answer',
        },
      ],
      [
        {
          user: 'Prompt',
          assistant: 'First answer',
          toolCalls: [{ name: 'command_execution' }],
        },
        { user: 'Next prompt', assistant: 'Second answer', toolCalls: [] },
      ],
    );

    assert.equal(selected.completeness, 'fallback');
  });

  it('does not count copied tool calls as current-run coverage', () => {
    const selected = selectCodex([
      ...codexSteps([]),
      {
        ...codexSteps(['exec_command'])[1],
        step_id: 3,
        is_copied_context: true,
      },
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('keeps Claude native structural policy unchanged', () => {
    const selected = selectCodex(
      codexSteps([]),
      undefined,
      'claude-code-jsonl',
    );
    assert.equal(selected.completeness, 'complete');
  });

  it('keeps source-aware verification structural for bounded, lossy driver fallback', () => {
    const completedTurns = [
      {
        user: 'Prompt',
        assistant: 'Live final answer',
        toolCalls: Array.from({ length: 300 }, (_, index) => ({
          id: `live-${index}`,
          name: 'command_execution',
          input: { command: 'x'.repeat(300) },
        })),
      },
    ];
    const selected = selectCodex(codexSteps([]), completedTurns);

    assert.equal(selected.completeness, 'fallback');
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 256);
    assert.ok(selected.warnings.some(({ code }) => code === 'value_omitted'));
    assert.equal(
      trajectoryCoversCompletedTurns(
        selected.trajectory,
        completedTurns,
        selected.provenance.source,
      ),
      true,
    );
  });
});

describe('driver fallback redaction', () => {
  const secret = 'synthetic-private-token';

  function fallback(toolCalls: readonly AgentToolCall[], assistant = 'Done.') {
    const redactor = createSecretRedactor([secret]);
    const selected = selectAgentEvidence({
      agent,
      identity,
      model: 'test-model',
      sessionId: SESSION_ID,
      completedTurns: [{ user: 'Prompt', assistant, toolCalls }],
      redactor,
      collected: { kind: 'unavailable', reason: UNAVAILABLE },
    });
    return { selected, redactor };
  }

  it('redacts values before cutting them and counts only what is emitted', () => {
    const { selected, redactor } = fallback(
      [
        {
          id: 'call',
          name: 'Tool',
          input: { query: `${'q'.repeat(4000)}${secret}${'q'.repeat(500)}` },
          result: { content: `${'r'.repeat(8180)}${secret}${'r'.repeat(50)}` },
        },
      ],
      `${'a'.repeat(8 * 1024 * 1024 - 5)}${secret}`,
    );
    const text = JSON.stringify(selected.trajectory);
    assert.equal(text.includes('synthetic-private'), false);
    assert.equal(text.includes('private-token'), false);
    assert.equal(redactor.replacements, 3);
  });

  it('does not count secrets in tool calls that the call budget drops', () => {
    const calls = Array.from({ length: 300 }, (_, index) => ({
      id: `call-${index}`,
      name: 'Tool',
      input: { value: index === 0 || index === 299 ? secret : 'plain' },
    }));
    const { selected, redactor } = fallback(calls);
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 256);
    assert.equal(redactor.replacements, 1);
  });

  it('marks non-JSON input omitted instead of failing redaction', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { selected, redactor } = fallback([
      { name: 'Tool', input: cyclic },
      { name: 'Tool', input: { value: 1n } },
    ]);
    const omitted = {
      forge_omitted_arguments: '[Forge omitted unavailable tool arguments.]',
    };
    assert.deepEqual(
      selected.trajectory.steps[1]?.tool_calls?.map((call) => call.arguments),
      [omitted, omitted],
    );
    assert.equal(redactor.replacements, 0);
  });
});

describe('driver fallback tool results', () => {
  const cut = '\n[Forge truncated driver evidence.]';
  const resultsOf = (calls: readonly AgentToolCall[]) => {
    const { selected } = fallbackOf(calls);
    const step = selected.trajectory.steps[1];
    return step?.source === 'agent' ? step.observation?.results : undefined;
  };

  function fallbackOf(toolCalls: readonly AgentToolCall[]) {
    const selected = selectAgentEvidence({
      agent,
      identity,
      model: 'test-model',
      sessionId: SESSION_ID,
      completedTurns: [{ user: 'Prompt', assistant: 'Done.', toolCalls }],
      collected: { kind: 'unavailable', reason: UNAVAILABLE },
    });
    return { selected };
  }

  it('renders each Forge marker once from the reported omission, without an error claim', () => {
    const results = resultsOf([
      { id: 'a', name: 'T', result: { omission: 'not_completed' } },
      { id: 'b', name: 'T', result: { omission: 'output_unavailable' } },
      {
        id: 'c',
        name: 'T',
        result: { content: 'text', omission: 'non_text_content' },
      },
      { id: 'd', name: 'T', result: { content: 'cut', truncated: true } },
      { id: 'e', name: 'T', result: { content: 'out', isError: false } },
      { id: 'f', name: 'T', result: { content: '' } },
    ]);
    assert.deepEqual(
      results?.map(({ content }) => content),
      [
        '[Forge tool result unavailable: the call did not complete.]',
        '[Forge tool result unavailable: the call reported no output.]',
        'text\n[Forge omitted non-text tool result content.]',
        'cut\n[Forge truncated the tool result.]',
        'out',
        '',
      ],
    );
    assert.deepEqual(
      results?.map(({ extra }) => extra),
      [
        undefined,
        undefined,
        undefined,
        undefined,
        { is_error: false },
        undefined,
      ],
    );
  });

  it('keeps the marker when a long result is cut', () => {
    const results = resultsOf([
      {
        id: 'a',
        name: 'T',
        result: { content: 'x'.repeat(9000), truncated: true },
      },
    ]);
    const content = String(results?.[0]?.content ?? '');
    assert.ok(content.endsWith(`${cut}\n[Forge truncated the tool result.]`));
    assert.ok(content.length <= 8192);
  });

  it('never splits a surrogate pair at the argument or result cut', () => {
    const argumentEnd = 4096 - cut.length;
    const argumentPrefix = '{"v":"';
    const argumentBody = 'x'.repeat(argumentEnd - 1 - argumentPrefix.length);
    const resultEnd = 8192 - cut.length;
    const { selected } = fallbackOf([
      {
        id: 'a',
        name: 'T',
        input: { v: `${argumentBody}😀${'y'.repeat(300)}` },
        result: { content: `${'x'.repeat(resultEnd - 1)}😀${'y'.repeat(300)}` },
      },
    ]);
    const step = selected.trajectory.steps[1];
    assert.ok(step?.source === 'agent');
    const toolArguments = step.tool_calls?.[0]?.arguments as
      | Record<string, string>
      | undefined;
    assert.equal(
      toolArguments?.forge_truncated_arguments,
      `${argumentPrefix}${argumentBody}${cut}`,
    );
    assert.equal(
      step.observation?.results[0]?.content,
      `${'x'.repeat(resultEnd - 1)}${cut}`,
    );
  });

  it('truncates a shallow argument object with more than 128 values', () => {
    const input = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`k${index}`, index]),
    );
    const { selected } = fallbackOf([{ name: 'T', input }]);
    const step = selected.trajectory.steps[1];
    assert.ok(step?.source === 'agent');
    assert.deepEqual(Object.keys(step.tool_calls?.[0]?.arguments ?? {}), [
      'forge_truncated_arguments',
    ]);
  });

  it('marks the assistant message when tool calls are dropped', () => {
    const calls = Array.from({ length: 300 }, (_, index) => ({
      name: 'T',
      input: { index },
    }));
    const { selected } = fallbackOf(calls);
    const step = selected.trajectory.steps[1];
    assert.ok(step?.source === 'agent');
    assert.equal(
      step.message,
      'Done.\n[Forge omitted additional tool calls and results.]',
    );
  });
});

describe('parseAgentEvidenceIdentity', () => {
  it('freezes a detached identity snapshot', () => {
    const input = { ...identity };
    const parsed = parseAgentEvidenceIdentity(input);
    input.name = 'Changed after validation';

    assert.deepEqual(parsed, identity);
    assert.equal(Object.isFrozen(parsed), true);
    assert.notEqual(parsed, input);
  });

  it('rejects malformed and unsafe identities at the pure declaration boundary', () => {
    for (const input of [
      null,
      [],
      new Map(),
      Object.create(identity),
      { name: identity.name },
      { ...identity, extra: true },
      { ...identity, name: '' },
      { ...identity, name: 123 },
      { ...identity, name: 'line\nbreak' },
      { ...identity, version: 'nul\u0000byte' },
      { ...identity, version: 'delete\u007fbyte' },
      { ...identity, name: 'x'.repeat(4_097) },
    ]) {
      assert.throws(() => parseAgentEvidenceIdentity(input), TypeError);
    }
    assert.equal(
      parseAgentEvidenceIdentity({ ...identity, name: 'x'.repeat(4_096) }).name
        .length,
      4_096,
    );
    assert.deepEqual(
      parseAgentEvidenceIdentity(Object.assign(Object.create(null), identity)),
      identity,
    );
  });
});

function selectCodex(
  steps: readonly Record<string, unknown>[],
  completedTurns: readonly CompletedEvidenceTurn[] = [
    {
      user: 'Prompt',
      assistant: 'Live final answer',
      toolCalls: [
        {
          id: 'live-call',
          name: 'command_execution',
          input: { command: 'pwd' },
        },
      ],
    },
  ],
  format = 'codex-rollout-jsonl',
) {
  return selectAgentEvidence({
    agent,
    identity,
    model: 'test-model',
    sessionId: SESSION_ID,
    completedTurns,
    collected: {
      kind: 'available',
      trajectory: trajectory(steps),
      source: { ...nativeSource(), format },
      warnings: [],
    },
  });
}

function codexSteps(
  toolNames: readonly string[],
  message: unknown = 'Native final answer, not byte-identical to the live projection.',
): Record<string, unknown>[] {
  return [
    { step_id: 1, source: 'user', message: 'Prompt' },
    {
      step_id: 2,
      source: 'agent',
      message,
      ...(toolNames.length === 0
        ? {}
        : {
            tool_calls: toolNames.map((function_name, index) => ({
              tool_call_id: `native-${index}`,
              function_name,
              arguments: { native: true },
            })),
            observation: {
              results: toolNames.map((_, index) => ({
                source_call_id: `native-${index}`,
                content: 'Native result',
              })),
            },
          }),
    },
  ];
}

function select(
  steps: readonly Record<string, unknown>[],
  collected: AgentNativeEvidenceResult = {
    kind: 'available',
    trajectory: trajectory(steps),
    source: nativeSource(),
    warnings: [],
  },
  firstTurnToolCalls: readonly AgentToolCall[] = [
    { id: 'driver-call', name: 'DriverWrite', input: { path: 'driver.txt' } },
  ],
  firstTurnAssistant = 'First driver response',
) {
  return selectAgentEvidence({
    agent,
    identity,
    model: 'test-model',
    sessionId: SESSION_ID,
    completedTurns: [
      {
        user: 'First prompt',
        assistant: firstTurnAssistant,
        toolCalls: firstTurnToolCalls,
      },
      {
        user: 'Second prompt',
        assistant: 'Second driver response',
        toolCalls: [],
      },
    ],
    collected,
  });
}

function trajectory(steps: readonly Record<string, unknown>[]) {
  return {
    schema_version: 'ATIF-v1.8',
    session_id: SESSION_ID,
    agent: {
      name: 'test-agent-binary',
      version: '2.0.0',
      model_name: 'test-model',
    },
    steps,
  };
}

function nativeSource() {
  return {
    kind: 'native_log' as const,
    format: 'test-jsonl',
    sessionId: SESSION_ID,
  };
}

function completeNativeSteps() {
  return [
    { step_id: 1, source: 'user', message: 'First prompt' },
    { step_id: 2, source: 'agent', message: 'First native response' },
    { step_id: 3, source: 'user', message: 'Second prompt' },
    { step_id: 4, source: 'agent', message: 'Second native response' },
  ] as const;
}
