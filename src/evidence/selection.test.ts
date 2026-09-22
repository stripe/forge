import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {
  AgentAdapter,
  AgentNativeEvidenceResult,
  AgentToolCall,
} from '../contracts/agent.js';
import {
  parseAgentEvidenceIdentity,
  selectAgentEvidence,
  trajectoryCoversCompletedTurns,
  type CompletedEvidenceTurn,
} from './selection.js';

const SESSION_ID = 'session-1';
const agent = {
  id: 'test-agent',
  version: 'adapter-1',
} as AgentAdapter;
const identity = {name: 'test-agent-binary', version: '2.0.0'};

describe('selectAgentEvidence', () => {
  it('prefers structurally complete native detail despite lossy projection differences', () => {
    const selected = select([
      {step_id: 1, source: 'user', message: 'First prompt'},
      {
        step_id: 2,
        source: 'agent',
        message: 'Persisted intermediate response',
        tool_calls: [
          {
            tool_call_id: 'native-call',
            function_name: 'NativeWrite',
            arguments: {path: 'native.txt'},
          },
        ],
      },
      {step_id: 3, source: 'user', message: 'Second prompt'},
      {step_id: 4, source: 'agent', message: '', reasoning_content: 'thinking'},
      {step_id: 5, source: 'agent', message: 'Persisted final response'},
    ]);

    assert.equal(selected.completeness, 'complete');
    assert.equal(selected.provenance.source.kind, 'native_log');
    assert.equal(selected.trajectory.steps.length, 5);
  });

  it('accepts tool activity as response evidence without requiring byte parity', () => {
    const selected = select([
      {step_id: 1, source: 'user', message: 'First prompt'},
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
      {step_id: 3, source: 'user', message: 'Second prompt'},
      {step_id: 4, source: 'agent', message: 'Native response'},
    ]);

    assert.equal(selected.completeness, 'complete');
    assert.equal(selected.provenance.source.kind, 'native_log');
  });

  it('preserves harmless native-detail warnings only after coverage succeeds', () => {
    const selected = select(
      completeNativeSteps(),
      {
        kind: 'available',
        trajectory: trajectory(completeNativeSteps()),
        source: nativeSource(),
        warnings: [
          {
            code: 'value_omitted',
            message: 'An invalid timestamp was omitted.',
          },
        ],
      },
    );

    assert.equal(selected.completeness, 'partial');
    assert.equal(selected.warnings[0]?.code, 'value_omitted');
  });

  for (const [description, steps] of [
    [
      'missing final turn',
      [
        {step_id: 1, source: 'user', message: 'First prompt'},
        {step_id: 2, source: 'agent', message: 'First native response'},
      ],
    ],
    [
      'extra native turn',
      [
        ...completeNativeSteps(),
        {step_id: 5, source: 'user', message: 'Unexpected prompt'},
        {step_id: 6, source: 'agent', message: 'Unexpected response'},
      ],
    ],
    [
      'reordered prompts',
      [
        {step_id: 1, source: 'user', message: 'Second prompt'},
        {step_id: 2, source: 'agent', message: 'First native response'},
        {step_id: 3, source: 'user', message: 'First prompt'},
        {step_id: 4, source: 'agent', message: 'Second native response'},
      ],
    ],
  ] as const) {
    it(`uses the complete driver ledger for ${description}`, () => {
      const selected = select(steps);

      assert.equal(selected.completeness, 'fallback');
      assert.equal(selected.provenance.source.kind, 'driver_fallback');
      assert.deepEqual(
        selected.trajectory.steps.map(({source, message}) => ({source, message})),
        [
          {source: 'user', message: 'First prompt'},
          {source: 'agent', message: 'First driver response'},
          {source: 'user', message: 'Second prompt'},
          {source: 'agent', message: 'Second driver response'},
        ],
      );
      assert.deepEqual(
        selected.warnings.map(({code}) => code),
        ['source_incomplete', 'fallback_used'],
      );
    });
  }

  it('does not count reasoning-only native output as response evidence', () => {
    const selected = select([
      {step_id: 1, source: 'user', message: 'First prompt'},
      {step_id: 2, source: 'agent', message: '', reasoning_content: 'thinking'},
      {step_id: 3, source: 'user', message: 'Second prompt'},
      {step_id: 4, source: 'agent', message: 'Second native response'},
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('does not count an empty text content part as response evidence', () => {
    const selected = select([
      {step_id: 1, source: 'user', message: 'First prompt'},
      {
        step_id: 2,
        source: 'agent',
        message: [{type: 'text', text: ''}],
      },
      {step_id: 3, source: 'user', message: 'Second prompt'},
      {step_id: 4, source: 'agent', message: 'Second native response'},
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
      selected.warnings.map(({code}) => code),
      ['source_invalid', 'fallback_used'],
    );
  });

  it('assigns unique deterministic IDs when driver tool-call IDs collide', () => {
    const selected = select(completeNativeSteps(), {
      kind: 'unavailable',
      reason: {
        code: 'source_unavailable',
        message: 'The exact native session is unavailable.',
      },
    }, [
      {id: 'duplicate', name: 'First', input: {}},
      {id: 'duplicate', name: 'Second', input: {}},
      {id: 'driver-call-2-3', name: 'Third', input: {}},
      {name: 'Fourth', input: {}},
    ]);

    const firstAgentStep = selected.trajectory.steps[1];
    assert.equal(firstAgentStep?.source, 'agent');
    assert.deepEqual(
      firstAgentStep?.tool_calls?.map(({tool_call_id}) => tool_call_id),
      [
        'duplicate',
        'driver-call-2-2-1',
        'driver-call-2-3',
        'driver-call-2-4',
      ],
    );
  });

  it('bounds lossy fallback detail while retaining every logical turn', () => {
    const longAssistant = 'x'.repeat(5 * 1024 * 1024);
    const toolCalls = Array.from({length: 300}, (_, index) => ({
      id: `call-${index}`,
      name: 'Tool',
      input: index === 0 ? {value: 'x'.repeat(300)} : {index},
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
    assert.deepEqual(firstAgentStep?.tool_calls?.[0]?.arguments, {});
    assert.deepEqual(
      selected.warnings.map(({code}) => code),
      ['source_unavailable', 'value_omitted', 'fallback_used'],
    );
    assert.deepEqual(
      selected.trajectory.steps
        .filter(({source}) => source === 'user')
        .map(({message}) => message),
      ['First prompt', 'Second prompt'],
    );
  });

  it('rejects an available candidate which contradicts the selected session', () => {
    assert.throws(
      () =>
        select(completeNativeSteps(), {
          kind: 'available',
          trajectory: {...trajectory(completeNativeSteps()), session_id: 'other'},
          source: nativeSource(),
          warnings: [],
        }),
      /selected agent session/,
    );
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
    const selected = selectCodex(codexSteps([]), [{
      user: 'Prompt', assistant: 'Live final answer', toolCalls: [],
    }]);

    assert.equal(selected.completeness, 'complete');
    assert.deepEqual(selected.warnings, []);
  });

  it('accepts comparable tool categories despite native IDs, arguments, and extra polling calls', () => {
    const selected = selectCodex(codexSteps([
      'functions.exec_command', 'functions.write_stdin', 'apply_patch',
      'functions.update_plan', 'mcp__docs.search', 'mcp__docs__lookup', 'web_search',
    ]), [{
      user: 'Prompt', assistant: 'Live final answer', toolCalls: [
        {id: 'live-command', name: 'command_execution', input: {command: 'pwd'}},
        {name: 'file_change', input: {changes: []}},
        {name: 'todo_list', input: {items: []}},
        {name: 'mcp__docs__search', input: {query: 'example'}},
        {name: 'mcp__docs__lookup', input: {id: 1}},
        {name: 'web_search', input: {query: 'example'}},
      ],
    }]);

    assert.equal(selected.completeness, 'complete');
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 7);
  });

  for (const [nativeName, liveName] of [
    ['mcp__my__server.probe', 'mcp__my__server__probe'],
    ['mcp__my__server__probe', 'mcp__my__server__probe'],
    ['mcp__my__server.probe.v1', 'mcp__my__server__probe.v1'],
  ] as const) {
    it(`accepts MCP server names containing __ in ${nativeName}`, () => {
      const selected = selectCodex(codexSteps([nativeName]), [{
        user: 'Prompt', assistant: 'Live final answer',
        toolCalls: [{name: liveName}],
      }]);

      assert.equal(selected.completeness, 'complete');
      assert.deepEqual(selected.warnings, []);
    });
  }

  for (const [description, names] of [
    ['an entire missing tool pair', []],
    ['native-only discovery masking the missing execution', ['tool_search', 'functions.tool_search']],
    ['a different tool category masking the missing execution', ['apply_patch']],
    ['an unrecognized execution alias', ['shell']],
    ['a differently cased execution name', ['Exec_Command']],
    ['an unrelated namespace using the same tool basename', ['custom.exec_command']],
  ] as const) {
    it(`falls back for ${description} even when the assistant answer remains`, () => {
      const selected = selectCodex(codexSteps(names));

      assert.equal(selected.completeness, 'fallback');
      assert.deepEqual(selected.warnings.map(({code}) => code), ['source_incomplete', 'fallback_used']);
      assert.equal(selected.trajectory.steps[1]?.tool_calls?.[0]?.function_name, 'command_execution');
    });
  }

  it('requires at least the live count in each comparable category', () => {
    const selected = selectCodex(codexSteps(['exec_command', 'tool_search']), [{
      user: 'Prompt', assistant: 'Live final answer', toolCalls: [
        {id: 'live-first', name: 'command_execution'},
        {id: 'live-second', name: 'command_execution'},
      ],
    }]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('preserves exact MCP tool-name case instead of treating other MCP activity as coverage', () => {
    const selected = selectCodex(codexSteps(['mcp__docs.Search', 'mcp__docs.lookup']), [{
      user: 'Prompt', assistant: 'Live final answer', toolCalls: [
        {name: 'mcp__docs__search'},
      ],
    }]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('fails coverage for an unmapped live tool instead of counting arbitrary native calls', () => {
    const selected = selectCodex(codexSteps(['unknown_tool']), [{
      user: 'Prompt', assistant: 'Live final answer', toolCalls: [{name: 'unknown_tool'}],
    }]);

    assert.equal(selected.completeness, 'fallback');
  });

  for (const message of ['', [{type: 'text', text: ''}]] as const) {
    it(`requires separate visible assistant text when live text exists (${JSON.stringify(message)})`, () => {
      const steps = codexSteps(['exec_command'], message);
      steps[1] = {...steps[1], reasoning_content: 'Only private reasoning remains.'};
      assert.equal(selectCodex(steps).completeness, 'fallback');
    });
  }

  it('does not require assistant text for a genuinely tool-only live turn', () => {
    const selected = selectCodex(codexSteps(['exec_command'], ''), [{
      user: 'Prompt', assistant: '', toolCalls: [{name: 'command_execution'}],
    }]);

    assert.equal(selected.completeness, 'complete');
  });

  it('does not let a later turn compensate for an earlier missing tool pair', () => {
    const selected = selectCodex([
      ...codexSteps([]),
      {step_id: 3, source: 'user', message: 'Next prompt'},
      {...codexSteps(['exec_command', 'write_stdin'])[1], step_id: 4},
    ], [
      {user: 'Prompt', assistant: 'First answer', toolCalls: [{name: 'command_execution'}]},
      {user: 'Next prompt', assistant: 'Second answer', toolCalls: [{name: 'command_execution'}]},
    ]);

    assert.equal(selected.completeness, 'fallback');
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 1);
    assert.equal(selected.trajectory.steps[3]?.tool_calls?.length, 1);
  });

  it('does not let later text compensate for an earlier missing assistant answer', () => {
    const selected = selectCodex([
      ...codexSteps(['exec_command'], ''),
      {step_id: 3, source: 'user', message: 'Next prompt'},
      {step_id: 4, source: 'agent', message: 'First answer\n\nSecond answer'},
    ], [
      {user: 'Prompt', assistant: 'First answer', toolCalls: [{name: 'command_execution'}]},
      {user: 'Next prompt', assistant: 'Second answer', toolCalls: []},
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('does not count copied tool calls as current-run coverage', () => {
    const selected = selectCodex([
      ...codexSteps([]),
      {...codexSteps(['exec_command'])[1], step_id: 3, is_copied_context: true},
    ]);

    assert.equal(selected.completeness, 'fallback');
  });

  it('keeps Claude native structural policy unchanged', () => {
    const selected = selectCodex(codexSteps([]), undefined, 'claude-code-jsonl');
    assert.equal(selected.completeness, 'complete');
  });

  it('keeps source-aware verification structural for bounded, lossy driver fallback', () => {
    const completedTurns = [{
      user: 'Prompt', assistant: 'Live final answer',
      toolCalls: Array.from({length: 300}, (_, index) => ({
        id: `live-${index}`, name: 'command_execution', input: {command: 'x'.repeat(300)},
      })),
    }];
    const selected = selectCodex(codexSteps([]), completedTurns);

    assert.equal(selected.completeness, 'fallback');
    assert.equal(selected.trajectory.steps[1]?.tool_calls?.length, 256);
    assert.ok(selected.warnings.some(({code}) => code === 'value_omitted'));
    assert.equal(trajectoryCoversCompletedTurns(
      selected.trajectory, completedTurns, selected.provenance.source,
    ), true);
  });
});

describe('parseAgentEvidenceIdentity', () => {
  it('strictly snapshots a safe identity', () => {
    assert.deepEqual(parseAgentEvidenceIdentity(identity), identity);
    assert.throws(
      () => parseAgentEvidenceIdentity({...identity, extra: true}),
      /safe name and version/,
    );
  });
});

function selectCodex(
  steps: readonly Record<string, unknown>[],
  completedTurns: readonly CompletedEvidenceTurn[] = [{
    user: 'Prompt', assistant: 'Live final answer',
    toolCalls: [{id: 'live-call', name: 'command_execution', input: {command: 'pwd'}}],
  }],
  format = 'codex-rollout-jsonl',
) {
  return selectAgentEvidence({
    agent, identity, model: 'test-model', sessionId: SESSION_ID, completedTurns,
    collected: {
      kind: 'available', trajectory: trajectory(steps),
      source: {...nativeSource(), format}, warnings: [],
    },
  });
}

function codexSteps(
  toolNames: readonly string[],
  message: unknown = 'Native final answer, not byte-identical to the live projection.',
): Record<string, unknown>[] {
  return [
    {step_id: 1, source: 'user', message: 'Prompt'},
    {
      step_id: 2, source: 'agent', message,
      ...(toolNames.length === 0 ? {} : {
        tool_calls: toolNames.map((function_name, index) => ({
          tool_call_id: `native-${index}`, function_name, arguments: {native: true},
        })),
        observation: {results: toolNames.map((_, index) => ({
          source_call_id: `native-${index}`, content: 'Native result',
        }))},
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
    {id: 'driver-call', name: 'DriverWrite', input: {path: 'driver.txt'}},
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
    {step_id: 1, source: 'user', message: 'First prompt'},
    {step_id: 2, source: 'agent', message: 'First native response'},
    {step_id: 3, source: 'user', message: 'Second prompt'},
    {step_id: 4, source: 'agent', message: 'Second native response'},
  ] as const;
}
