import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  ATIF_NORMALIZATION_VERSION,
  ATIF_SCHEMA_VERSION,
  AtifValidationError,
  createNormalizedTrajectory,
  NormalizedTrajectoryValidationError,
  parseAtifTrajectory,
  parseNormalizedTrajectory,
  serializeAtifTrajectory,
  type AtifTrajectoryV1_8,
} from './index.js';

function minimalTrajectory(): AtifTrajectoryV1_8 {
  return {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: {name: 'test-agent', version: '1.0.0'},
    steps: [{step_id: 1, source: 'user', message: 'hello'}],
  };
}

function expectInvalid(
  input: unknown,
  messageFragment?: string,
): AtifValidationError {
  let captured: AtifValidationError | undefined;
  assert.throws(
    () => parseAtifTrajectory(input),
    (error) => {
      assert.ok(error instanceof AtifValidationError);
      captured = error;
      if (messageFragment !== undefined) {
        assert.ok(
          error.issues.some((issue) =>
            issue.message.includes(messageFragment),
          ),
          `expected an issue containing ${JSON.stringify(messageFragment)}`,
        );
      }
      return true;
    },
  );
  return captured!;
}

describe('parseAtifTrajectory', () => {
  it('parses the exact ATIF-v1.8 discriminator', () => {
    assert.deepEqual(parseAtifTrajectory(minimalTrajectory()),
      minimalTrajectory());

    expectInvalid(
      {...minimalTrajectory(), schema_version: 'ATIF-v1.7'},
      'Invalid literal value',
    );
    const withoutVersion = {...minimalTrajectory()} as Record<string, unknown>;
    delete withoutVersion.schema_version;
    const missingVersion = expectInvalid(withoutVersion);
    assert.ok(
      missingVersion.issues.some(
        (issue) => issue.path[0] === 'schema_version',
      ),
    );
  });

  it('rejects undeclared fields while preserving explicit extra objects', () => {
    expectInvalid({...minimalTrajectory(), private_field: true});

    const parsed = parseAtifTrajectory({
      ...minimalTrajectory(),
      extra: {vendor: {enabled: true}},
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: 'hello',
          extra: {native_event: 7},
        },
      ],
    });
    assert.deepEqual(parsed.extra, {vendor: {enabled: true}});
    assert.deepEqual(parsed.steps[0]?.extra, {native_event: 7});
  });

  it('validates and canonicalizes ATIF-v1.8 content parts', () => {
    const parsed = parseAtifTrajectory({
      ...minimalTrajectory(),
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: [
            {type: 'text', text: 'listen'},
            {
              type: 'audio',
              source: {
                media_type: ' Audio/MP3 ',
                path: 'media/prompt.mp3',
                duration_sec: 1.25,
              },
            },
            {
              type: 'image',
              source: {media_type: 'image/png', path: 'media/prompt.png'},
            },
          ],
        },
      ],
    });
    const message = parsed.steps[0]?.message;
    assert.ok(Array.isArray(message));
    const audio = message[1];
    assert.equal(audio?.type, 'audio');
    if (audio?.type === 'audio') {
      assert.equal(audio.source.media_type, 'audio/mpeg');
    }

    expectInvalid({
      ...minimalTrajectory(),
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: [{type: 'audio', source: {media_type: 'image/png', path: 'x'}}],
        },
      ],
    });
    expectInvalid({
      ...minimalTrajectory(),
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: [{type: 'text', text: 'x', source: {media_type: 'image/png', path: 'x'}}],
        },
      ],
    });
  });

  it('accepts and preserves explicit nulls permitted by ATIF-v1.8', () => {
    const parsed = parseAtifTrajectory({
      ...minimalTrajectory(),
      session_id: null,
      agent: {
        name: 'test-agent',
        version: '1.0.0',
        model_name: null,
        tool_definitions: null,
        extra: null,
      },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          timestamp: null,
          model_name: null,
          reasoning_effort: null,
          message: '',
          reasoning_content: null,
          tool_calls: null,
          observation: {
            results: [
              {
                source_call_id: null,
                content: null,
                subagent_trajectory_ref: [
                  {trajectory_id: 'child-1', trajectory_path: null},
                ],
              },
            ],
          },
          metrics: null,
          is_copied_context: null,
          llm_call_count: null,
          extra: null,
        },
      ],
      notes: null,
      final_metrics: null,
      continued_trajectory_ref: null,
      extra: null,
      subagent_trajectories: [
        {
          ...minimalTrajectory(),
          trajectory_id: 'child-1',
          session_id: null,
        },
      ],
    });

    assert.equal(parsed.steps[0]?.llm_call_count, null);
    assert.equal(
      parsed.steps[0]?.observation?.results[0]?.source_call_id,
      null,
    );
    assert.equal(
      parsed.steps[0]?.observation?.results[0]?.subagent_trajectory_ref?.[0]
        ?.trajectory_path,
      null,
    );
    assert.match(serializeAtifTrajectory(parsed), /"trajectory_path": null/);
  });

  it('validates timestamp calendar and offset components strictly', () => {
    assert.equal(
      parseAtifTrajectory({
        ...minimalTrajectory(),
        steps: [
          {
            step_id: 1,
            source: 'user',
            message: 'hello',
            timestamp: '2024-02-29T23:59:59.123+2359',
          },
        ],
      }).steps[0]?.timestamp,
      '2024-02-29T23:59:59.123+2359',
    );

    for (const timestamp of [
      '2025-02-29T00:00:00Z',
      '2025-02-30T00:00:00Z',
      '2025-04-31T00:00:00Z',
      '2025-01-01T24:00:00Z',
      '2025-01-01T00:00:00+24:00',
    ]) {
      expectInvalid(
        {
          ...minimalTrajectory(),
          steps: [
            {step_id: 1, source: 'user', message: 'hello', timestamp},
          ],
        },
        'ISO 8601',
      );
    }
  });

  it('enforces source-specific step fields and deterministic dispatch rules', () => {
    expectInvalid(
      {
        ...minimalTrajectory(),
        steps: [
          {
            step_id: 1,
            source: 'user',
            message: 'hello',
            model_name: 'model',
          },
        ],
      },
      'only valid on an agent step',
    );
    expectInvalid(
      {
        ...minimalTrajectory(),
        steps: [
          {
            step_id: 1,
            source: 'agent',
            message: '',
            llm_call_count: 0,
            reasoning_content: 'not permitted',
          },
        ],
      },
      'must be absent when llm_call_count is 0',
    );
  });

  it('enforces ordered steps and same-step tool result references', () => {
    expectInvalid(
      {
        ...minimalTrajectory(),
        steps: [{step_id: 2, source: 'user', message: 'hello'}],
      },
      'sequential from 1',
    );

    expectInvalid(
      {
        ...minimalTrajectory(),
        steps: [
          {
            step_id: 1,
            source: 'agent',
            message: 'done',
            tool_calls: [
              {tool_call_id: 'call-1', function_name: 'shell', arguments: {}},
            ],
            observation: {
              results: [{source_call_id: 'call-2', content: 'missing'}],
            },
          },
        ],
      },
      'same step',
    );
  });

  it('validates embedded subagents and their resolution keys', () => {
    const child = {
      ...minimalTrajectory(),
      trajectory_id: 'child-1',
    };
    const parent = {
      ...minimalTrajectory(),
      steps: [
        {
          step_id: 1,
          source: 'agent',
          message: 'delegated',
          observation: {
            results: [
              {
                subagent_trajectory_ref: [{trajectory_id: 'child-1'}],
              },
            ],
          },
        },
      ],
      subagent_trajectories: [child],
    };
    assert.equal(
      parseAtifTrajectory(parent).subagent_trajectories?.[0]?.trajectory_id,
      'child-1',
    );

    expectInvalid({
      ...parent,
      subagent_trajectories: [{...minimalTrajectory()}],
    }, 'required on an embedded subagent');
    expectInvalid({
      ...parent,
      subagent_trajectories: [child, {...child}],
    }, 'unique within subagent_trajectories');
    expectInvalid({
      ...parent,
      subagent_trajectories: [],
    }, 'must resolve to subagent_trajectories');
    expectInvalid({
      ...parent,
      steps: [
        {
          step_id: 1,
          source: 'agent',
          message: 'delegated',
          observation: {
            results: [
              {subagent_trajectory_ref: [{session_id: 'informational'}]},
            ],
          },
        },
      ],
    }, 'session_id is informational only');
  });

  it('requires a note when aggregate total_steps differs', () => {
    expectInvalid(
      {...minimalTrajectory(), final_metrics: {total_steps: 2}},
      'must be explained in notes',
    );
    assert.equal(
      parseAtifTrajectory({
        ...minimalTrajectory(),
        final_metrics: {total_steps: 2},
        notes: 'The aggregate includes one omitted initialization step.',
      }).final_metrics?.total_steps,
      2,
    );
  });

  it('rejects non-JSON and cyclic values before recursive schema parsing', () => {
    const cyclic: Record<string, unknown> = minimalTrajectory() as unknown as Record<
      string,
      unknown
    >;
    cyclic.self = cyclic;
    const error = expectInvalid(cyclic, 'cyclic');
    assert.equal(error.issues[0]?.code, 'invalid_json_value');

    expectInvalid({...minimalTrajectory(), extra: {missing: undefined}});
    expectInvalid({...minimalTrajectory(), extra: {bad: Number.NaN}});

    const sparse = {...minimalTrajectory(), steps: new Array(1)};
    expectInvalid(sparse, 'arrays must be dense');

    const unsafeKey = JSON.parse(
      '{"schema_version":"ATIF-v1.8","agent":{"name":"a","version":"1"},"steps":[{"step_id":1,"source":"user","message":"x"}],"extra":{"__proto__":{"polluted":true}}}',
    ) as unknown;
    expectInvalid(unsafeKey, '__proto__');
  });

  it('rejects oversized arrays before enumerating their keys', () => {
    const oversized = new Proxy(new Array(100_001), {
      ownKeys() {
        throw new Error('oversized array keys must not be enumerated');
      },
    });
    const error = expectInvalid({...minimalTrajectory(), steps: oversized});
    assert.equal(error.issues[0]?.code, 'input_limit_exceeded');
  });
});

describe('serializeAtifTrajectory', () => {
  it('sorts every object key and appends exactly one newline', () => {
    assert.equal(
      serializeAtifTrajectory(minimalTrajectory()),
      `{
  "agent": {
    "name": "test-agent",
    "version": "1.0.0"
  },
  "schema_version": "ATIF-v1.8",
  "steps": [
    {
      "message": "hello",
      "source": "user",
      "step_id": 1
    }
  ]
}
`,
    );
  });

  it('is invariant to input object insertion order', () => {
    const left = {
      ...minimalTrajectory(),
      extra: {z: 1, nested: {z: false, a: true}, a: 2},
    };
    const right = {
      steps: minimalTrajectory().steps,
      extra: {a: 2, nested: {a: true, z: false}, z: 1},
      agent: minimalTrajectory().agent,
      schema_version: ATIF_SCHEMA_VERSION,
    };
    assert.equal(
      serializeAtifTrajectory(left),
      serializeAtifTrajectory(right),
    );
  });
});

describe('createNormalizedTrajectory', () => {
  it('records format and normalization versions outside the ATIF document', () => {
    const normalized = createNormalizedTrajectory({
      trajectory: minimalTrajectory(),
      provenance: {
        source: {
          kind: 'native_log',
          format: 'claude-code-jsonl',
          sessionId: 'native-session',
        },
        adapter: {id: 'claude-code', version: '1'},
      },
      completeness: 'partial',
      warnings: [
        {
          code: 'source_incomplete',
          message: 'The final event was truncated.',
        },
      ],
    });

    assert.equal(normalized.schemaVersion, ATIF_SCHEMA_VERSION);
    assert.equal(
      normalized.normalizationVersion,
      ATIF_NORMALIZATION_VERSION,
    );
    assert.equal(normalized.format, 'atif');
    assert.equal(normalized.completeness, 'partial');
    assert.equal(normalized.warnings[0]?.code, 'source_incomplete');
  });

  it('validates the complete normalization envelope', () => {
    const normalized = createNormalizedTrajectory({
      trajectory: minimalTrajectory(),
      provenance: {
        source: {kind: 'native_log', format: 'test-jsonl'},
        adapter: {id: 'test-agent', version: '1'},
      },
      completeness: 'complete',
    });

    assert.throws(
      () =>
        parseNormalizedTrajectory({
          ...normalized,
          provenance: {
            source: {kind: 'bogus', format: 3},
            adapter: {id: '', version: ''},
          },
          completeness: 'bogus',
        }),
      NormalizedTrajectoryValidationError,
    );
    assert.throws(
      () =>
        parseNormalizedTrajectory({
          ...normalized,
          provenance: {
            ...normalized.provenance,
            source: {
              kind: 'driver_fallback',
              format: 'forge-driver-turns',
            },
          },
        }),
      (error) =>
        error instanceof NormalizedTrajectoryValidationError &&
        error.issues.some((issue) =>
          issue.message.includes(
            'driver_fallback provenance and fallback completeness',
          ),
        ),
    );
    assert.throws(
      () =>
        parseNormalizedTrajectory({
          ...normalized,
          completeness: 'partial',
        }),
      (error) =>
        error instanceof NormalizedTrajectoryValidationError &&
        error.issues.some((issue) =>
          issue.message.includes('partial evidence requires'),
        ),
    );
  });
});
