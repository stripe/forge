import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
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

    const toolCall = {
      tool_call_id: 'call-1', function_name: 'shell', arguments: {},
    };
    const duplicate = expectInvalid({
      ...minimalTrajectory(),
      steps: [{
        step_id: 1,
        source: 'agent',
        message: '',
        tool_calls: [toolCall, {...toolCall}],
      }],
    }, 'unique within a step');
    assert.deepEqual(duplicate.issues[0]?.path,
      ['steps', 0, 'tool_calls', 1, 'tool_call_id']);

    assert.equal(parseAtifTrajectory({
      ...minimalTrajectory(),
      steps: [1, 2].map((step_id) => ({
        step_id,
        source: 'agent',
        message: '',
        tool_calls: [toolCall],
        observation: {results: [{source_call_id: 'call-1', content: 'ok'}]},
      })),
    }).steps.length, 2);
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

  it('rejects exotic objects and property descriptors without invoking accessors', () => {
    let accessorCalls = 0;
    const accessor = () => {
      accessorCalls += 1;
      throw new Error('JSON parsing must not invoke accessors');
    };
    const objectAccessor = Object.defineProperty({}, 'value', {
      enumerable: true, get: accessor,
    });
    const arrayAccessor = Object.defineProperty([null], '0', {
      enumerable: true, get: accessor,
    });
    const hidden = Object.defineProperty({}, 'hidden', {value: true});
    const namedArray = Object.assign([null], {label: 'named'});
    const cases = [
      {value: new Date(0), path: ['extra', 'value'], message: 'plain JSON objects'},
      {value: objectAccessor, path: ['extra', 'value', 'value'], message: 'plain data values'},
      {value: arrayAccessor, path: ['extra', 'value', 0], message: 'plain data values'},
      {value: hidden, path: ['extra', 'value', 'hidden'], message: 'enumerable'},
      {value: {[Symbol('private')]: true}, path: ['extra', 'value'], message: 'symbol keys'},
      {value: namedArray, path: ['extra', 'value'], message: 'named properties'},
    ];

    for (const {value, path, message} of cases) {
      const error = expectInvalid({...minimalTrajectory(), extra: {value}}, message);
      assert.equal(error.issues[0]?.code, 'invalid_json_value');
      assert.deepEqual(error.issues[0]?.path, path);
    }
    assert.equal(accessorCalls, 0);
  });

  it('bounds nesting while accepting shared acyclic objects as fresh projections', () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 62; depth += 1) nested = {value: nested};
    const atLimit = {...minimalTrajectory(), extra: {value: nested}};
    assert.deepEqual(parseAtifTrajectory(atLimit), atLimit);
    const tooDeep = expectInvalid({
      ...minimalTrajectory(), extra: {value: {value: nested}},
    }, 'maximum depth');
    assert.equal(tooDeep.issues[0]?.code, 'input_limit_exceeded');
    assert.equal(tooDeep.issues[0]?.path.length, 65);

    const shared = Object.assign(Object.create(null) as {value: string[]}, {
      value: ['original'],
    });
    const input = {...minimalTrajectory(), extra: {left: shared, right: shared}};
    const parsed = parseAtifTrajectory(input);
    assert.deepEqual(parsed.extra, {
      left: {value: ['original']}, right: {value: ['original']},
    });
    const left = parsed.extra?.left as {value: string[]};
    const right = parsed.extra?.right as {value: string[]};
    left.value.push('changed');
    assert.deepEqual(right.value, ['original']);
    assert.deepEqual(shared.value, ['original']);
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

  it('revalidates typed inputs and canonicalizes audio without mutating content order', () => {
    const input = {
      ...minimalTrajectory(),
      steps: [{
        step_id: 1,
        source: 'user',
        message: [
          {type: 'text', text: 'first'},
          {type: 'audio', source: {media_type: ' Audio/X-WAV ', path: 'sound.wav'}},
          {type: 'text', text: 'last'},
        ],
      }],
    };
    const before = structuredClone(input);
    const serialized = serializeAtifTrajectory(input as AtifTrajectoryV1_8);
    assert.deepEqual(JSON.parse(serialized).steps[0].message, [
      {type: 'text', text: 'first'},
      {type: 'audio', source: {media_type: 'audio/wav', path: 'sound.wav'}},
      {type: 'text', text: 'last'},
    ]);
    assert.deepEqual(input, before);
    assert.throws(() => serializeAtifTrajectory({
      ...minimalTrajectory(), schema_version: 'ATIF-v1.7',
    } as unknown as AtifTrajectoryV1_8), AtifValidationError);
  });
});

describe('createNormalizedTrajectory', () => {
  it('records the ATIF format and source provenance outside the trajectory', () => {
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

    assert.equal(normalized.trajectory.schema_version, ATIF_SCHEMA_VERSION);
    assert.equal(Object.hasOwn(normalized, 'schemaVersion'), false);
    assert.equal(Object.hasOwn(normalized, 'normalizationVersion'), false);
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
    for (const [field, value] of [
      ['schemaVersion', ATIF_SCHEMA_VERSION],
      ['normalizationVersion', 1],
      ['undeclared', true],
    ] as const) {
      assert.throws(
        () => parseNormalizedTrajectory({...normalized, [field]: value}),
        NormalizedTrajectoryValidationError,
      );
    }
    assert.throws(
      () => parseNormalizedTrajectory({...normalized, trajectory: {}}),
      AtifValidationError,
    );
    assert.throws(
      () => parseNormalizedTrajectory({
        ...normalized,
        trajectory: {...normalized.trajectory, schema_version: 'ATIF-v1.7'},
      }),
      AtifValidationError,
    );
  });

  it('requires completeness, provenance, and warnings to agree', () => {
    const normalized = createNormalizedTrajectory({
      trajectory: minimalTrajectory(),
      provenance: {
        source: {kind: 'native_log', format: 'test-jsonl'},
        adapter: {id: 'test-agent', version: '1'},
      },
      completeness: 'complete',
    });
    const incomplete = {code: 'source_incomplete', message: 'Truncated event.'};
    const fallback = {code: 'fallback_used', message: 'Using driver turns.'};
    const fallbackProvenance = {
      ...normalized.provenance,
      source: {kind: 'driver_fallback', format: 'forge-driver-turns'},
    };
    const cases = [
      {change: {warnings: [incomplete]}, path: ['warnings'], message: 'complete evidence cannot'},
      {change: {completeness: 'partial'}, path: ['warnings'], message: 'partial evidence requires'},
      {change: {provenance: fallbackProvenance}, path: ['completeness'], message: 'fallback provenance and fallback completeness'},
      {change: {completeness: 'fallback', warnings: [fallback]}, path: ['completeness'], message: 'fallback provenance and fallback completeness'},
      {change: {provenance: fallbackProvenance, completeness: 'fallback', warnings: [incomplete]}, path: ['warnings'], message: 'requires a fallback_used warning'},
      {change: {completeness: 'partial', warnings: [fallback]}, path: ['warnings'], message: 'valid only for fallback evidence'},
    ];
    for (const {change, path, message} of cases) {
      assert.throws(() => parseNormalizedTrajectory({...normalized, ...change}),
        (error) => {
          assert.ok(error instanceof NormalizedTrajectoryValidationError);
          assert.equal(error.code, 'invalid_normalized_trajectory');
          const issue = error.issues.find((item) => item.message.includes(message));
          assert.ok(issue, message);
          assert.deepEqual(issue.path, path);
          return true;
        });
    }

    assert.equal(parseNormalizedTrajectory({
      ...normalized,
      provenance: fallbackProvenance,
      completeness: 'fallback',
      warnings: [fallback],
    }).completeness, 'fallback');
  });

  it('preserves source ATIF provenance and clones adapter-owned metadata', () => {
    const input = {
      trajectory: minimalTrajectory(),
      provenance: {
        source: {kind: 'atif' as const, format: 'atif' as const,
          schemaVersion: 'ATIF-v1.7', sessionId: 'source-session'},
        adapter: {id: 'test-agent', version: '1'},
      },
      completeness: 'partial' as const,
      warnings: [{code: 'value_omitted' as const, message: 'Omitted private value.', path: 'steps.0.extra'}],
    };
    const before = structuredClone(input);
    const normalized = createNormalizedTrajectory(input);
    assert.deepEqual(normalized.provenance, input.provenance);
    normalized.provenance.adapter.id = 'changed';
    normalized.warnings[0]!.message = 'changed';
    normalized.trajectory.steps[0]!.message = 'changed';
    assert.deepEqual(input, before);
  });
});
