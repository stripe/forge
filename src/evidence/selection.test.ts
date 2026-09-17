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

describe('parseAgentEvidenceIdentity', () => {
  it('strictly snapshots a safe identity', () => {
    assert.deepEqual(parseAgentEvidenceIdentity(identity), identity);
    assert.throws(
      () => parseAgentEvidenceIdentity({...identity, extra: true}),
      /safe name and version/,
    );
  });
});

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
