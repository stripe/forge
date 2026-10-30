import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { type AtifTrajectoryV1_8, AtifValidationError } from '../atif/index.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  createJudgeTranscriptProjection,
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  type JudgeTranscriptProjectionV1,
  type JudgeVisibleStepV1,
  parseJudgeTranscriptProjection,
} from './judgeTranscript.ts';

describe('createJudgeTranscriptProjection', () => {
  it('constructs only judge-visible root steps and fields', () => {
    const trajectory = richTrajectory();
    const before = structuredClone(trajectory);

    const projection = createJudgeTranscriptProjection(trajectory);

    assert.deepEqual(trajectory, before, 'the ATIF input must not be mutated');
    assert.deepEqual(metadataOf(projection), expectedMetadata());
    assert.deepEqual(JSON.parse(projection.transcriptJson), [
      {
        step_id: 3,
        source: 'user',
        message: [
          { type: 'text', text: 'Inspect the result.' },
          {
            type: 'image',
            source: { media_type: 'image/png', path: 'expected.png' },
          },
        ],
      },
      {
        step_id: 4,
        source: 'agent',
        message: [
          { type: 'text', text: 'I used the tool.' },
          {
            type: 'audio',
            source: {
              media_type: 'audio/mpeg',
              path: 'explanation.mp3',
              duration_sec: 1.5,
            },
          },
        ],
        tool_calls: [
          {
            tool_call_id: 'call-1',
            function_name: 'inspect',
            arguments: {
              reasoning_content: 'observable input',
              nested: { reasoning_effort: 7 },
            },
          },
          {
            tool_call_id: 'call-2',
            function_name: 'read',
            arguments: { path: 'result.txt' },
          },
        ],
        observation: {
          results: [
            {
              source_call_id: 'call-1',
              content: 'Result text mentioning reasoning_content.',
              is_error: false,
            },
            {
              source_call_id: 'call-2',
              content: [{ type: 'text', text: 'read failed' }],
              is_error: true,
            },
            {
              content: 'Observable result without a provider call ID.',
              is_error: false,
            },
          ],
        },
      },
    ] satisfies JudgeVisibleStepV1[]);

    assert.doesNotMatch(projection.transcriptJson, /system instructions/);
    assert.doesNotMatch(projection.transcriptJson, /copied prior request/);
    assert.doesNotMatch(projection.transcriptJson, /private chain of thought/);
    assert.doesNotMatch(
      projection.transcriptJson,
      /reasoning without a visible response/,
    );
    assert.doesNotMatch(projection.transcriptJson, /child private output/);
    assert.doesNotMatch(projection.transcriptJson, /provider-private/);
    assert.doesNotMatch(projection.transcriptJson, /subagent_trajectory_ref/);
    assert.doesNotMatch(projection.transcriptJson, /timestamp/);
    assert.doesNotMatch(projection.transcriptJson, /metrics/);
  });

  it('omits null, empty, and dropped-only optional structures', () => {
    const trajectory: AtifTrajectoryV1_8 = {
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [
        { step_id: 1, source: 'user', message: 'Do it.' },
        {
          step_id: 2,
          source: 'agent',
          message: 'Done.',
          tool_calls: [],
          observation: {
            results: [
              { source_call_id: null, content: null },
              {
                subagent_trajectory_ref: [{ trajectory_id: 'child' }],
                extra: {
                  provider_note: 'not evidence',
                  is_error: 'true',
                },
              },
              {
                content: 'uncorrelated visible result',
                extra: { is_error: false },
              },
            ],
          },
        },
      ],
      subagent_trajectories: [
        {
          schema_version: 'ATIF-v1.8',
          trajectory_id: 'child',
          agent: { name: 'child', version: '1' },
          steps: [{ step_id: 1, source: 'agent', message: 'hidden' }],
        },
      ],
    };

    assert.deepEqual(
      JSON.parse(createJudgeTranscriptProjection(trajectory).transcriptJson),
      [
        { step_id: 1, source: 'user', message: 'Do it.' },
        {
          step_id: 2,
          source: 'agent',
          message: 'Done.',
          observation: {
            results: [
              { content: 'uncorrelated visible result', is_error: false },
            ],
          },
        },
      ],
    );
  });

  it('preserves order and IDs while filtering creates gaps', () => {
    const trajectory: AtifTrajectoryV1_8 = {
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [
        { step_id: 1, source: 'system', message: 'hidden' },
        { step_id: 2, source: 'user', message: 'first' },
        {
          step_id: 3,
          source: 'agent',
          message: 'copied',
          is_copied_context: true,
        },
        { step_id: 4, source: 'agent', message: 'second' },
      ],
    };

    assert.deepEqual(
      JSON.parse(createJudgeTranscriptProjection(trajectory).transcriptJson),
      [
        { step_id: 2, source: 'user', message: 'first' },
        { step_id: 4, source: 'agent', message: 'second' },
      ],
    );
  });

  it('retains tool behavior when an agent message has no visible text', () => {
    const trajectory: AtifTrajectoryV1_8 = {
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [
        { step_id: 1, source: 'user', message: 'Read the file.' },
        {
          step_id: 2,
          source: 'agent',
          message: '',
          tool_calls: [
            {
              tool_call_id: 'call-1',
              function_name: 'read',
              arguments: { path: 'answer.txt' },
            },
          ],
        },
      ],
    };

    assert.deepEqual(
      JSON.parse(createJudgeTranscriptProjection(trajectory).transcriptJson),
      [
        { step_id: 1, source: 'user', message: 'Read the file.' },
        {
          step_id: 2,
          source: 'agent',
          message: '',
          tool_calls: [
            {
              tool_call_id: 'call-1',
              function_name: 'read',
              arguments: { path: 'answer.txt' },
            },
          ],
        },
      ],
    );
  });

  it('returns immutable metadata and deterministic canonical bytes', () => {
    const trajectory = richTrajectory();
    const first = createJudgeTranscriptProjection(trajectory);
    const second = createJudgeTranscriptProjection(structuredClone(trajectory));
    const decoded = JSON.parse(first.transcriptJson) as JudgeVisibleStepV1[];

    assert.equal(first.transcriptJson, serializeCanonicalJson(decoded));
    assert.equal(first.transcriptJson.endsWith('\n'), true);
    assert.equal(second.transcriptJson, first.transcriptJson);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.includedStepSources), true);
    assert.equal(Object.isFrozen(first.includedFields), true);
  });

  it('serializes an empty array when every root step is excluded', () => {
    const trajectory: AtifTrajectoryV1_8 = {
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [
        { step_id: 1, source: 'system', message: 'system' },
        {
          step_id: 2,
          source: 'user',
          message: 'copied',
          is_copied_context: true,
        },
      ],
    };

    assert.equal(
      createJudgeTranscriptProjection(trajectory).transcriptJson,
      '[]\n',
    );
  });

  it('validates ATIF before producing judge-visible bytes', () => {
    const invalid = {
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          message: 'Visible response.',
          undeclared_private_reasoning: 'must not pass through',
        },
      ],
    } as unknown as AtifTrajectoryV1_8;

    assert.throws(
      () => createJudgeTranscriptProjection(invalid),
      AtifValidationError,
    );
  });
});

describe('parseJudgeTranscriptProjection', () => {
  it('accepts a factory projection and returns a fresh frozen value', () => {
    const created = createJudgeTranscriptProjection(richTrajectory());
    const parsed = parseJudgeTranscriptProjection(structuredClone(created));

    assert.notEqual(parsed, created);
    assert.deepEqual(parsed, created);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(parsed.includedFields, JUDGE_TRANSCRIPT_INCLUDED_FIELDS);
    assert.equal(
      parsed.includedStepSources,
      JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
    );
  });

  it('rejects raw ATIF, unknown projection properties, and changed policy metadata', () => {
    const valid = createJudgeTranscriptProjection(richTrajectory());
    const rawAtif = richTrajectory();

    assert.throws(() => parseJudgeTranscriptProjection(rawAtif));
    assert.throws(() =>
      parseJudgeTranscriptProjection({ ...valid, unexpected: true }),
    );
    const cyclic = { ...valid } as Record<string, unknown>;
    cyclic.self = cyclic;
    assert.throws(
      () => parseJudgeTranscriptProjection(cyclic),
      /metadata is not bounded JSON/,
    );
    for (const changed of [
      { ...valid, source: 'interaction.json' },
      { ...valid, projectionId: 'another-projection' },
      { ...valid, projectionVersion: 1 },
      { ...valid, trajectoryScope: 'all' },
      { ...valid, includedStepSources: ['agent', 'user'] },
      { ...valid, copiedContext: 'included' },
      { ...valid, includedFields: [...valid.includedFields].reverse() },
    ]) {
      assert.throws(() => parseJudgeTranscriptProjection(changed));
    }
  });

  it('rejects invalid or noncanonical transcript bytes', () => {
    const valid = createJudgeTranscriptProjection(richTrajectory());

    assert.throws(
      () => parseJudgeTranscriptProjection({ ...valid, transcriptJson: '{' }),
      /not valid JSON/,
    );
    assert.throws(
      () =>
        parseJudgeTranscriptProjection({
          ...valid,
          transcriptJson: valid.transcriptJson.trimEnd(),
        }),
      /canonical JSON with a final LF/,
    );
    assert.throws(
      () =>
        parseJudgeTranscriptProjection({
          ...valid,
          transcriptJson: '[ {"source":"user","message":"x","step_id":1} ]\n',
        }),
      /canonical JSON with a final LF/,
    );
  });

  it('retains large projections and bounds decoded JSON complexity', () => {
    const valid = createJudgeTranscriptProjection(richTrajectory());
    const large = createJudgeTranscriptProjection({
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [{ step_id: 1, source: 'user', message: 'x'.repeat(1024 * 1024) }],
    });
    assert.ok(Buffer.byteLength(large.transcriptJson) > 1024 * 1024);
    assert.deepEqual(parseJudgeTranscriptProjection(large), large);

    const deeplyNested = `${'{"nested":'.repeat(65)}null${'}'.repeat(65)}`;
    assert.throws(
      () =>
        parseJudgeTranscriptProjection({
          ...valid,
          transcriptJson: `[{"message":"","source":"agent","step_id":1,"tool_calls":[{"arguments":${deeplyNested},"function_name":"tool","tool_call_id":"call"}]}]\n`,
        }),
      /transcript is not bounded JSON/,
    );

    const tooManyNodes = serializeCanonicalJson([
      {
        step_id: 1,
        source: 'agent',
        message: '',
        tool_calls: [
          {
            tool_call_id: 'call',
            function_name: 'tool',
            arguments: { values: new Array(100_001).fill(null) },
          },
        ],
      },
    ]);
    assert.throws(
      () =>
        parseJudgeTranscriptProjection({
          ...valid,
          transcriptJson: tooManyNodes,
        }),
      /transcript is not bounded JSON/,
    );
  });

  it('strictly rejects every non-allowlisted step field and source', () => {
    const valid = createJudgeTranscriptProjection(richTrajectory());
    const invalidSteps = [
      [{ step_id: 1, source: 'system', message: 'hidden' }],
      [
        {
          step_id: 1,
          source: 'agent',
          message: 'answer',
          reasoning_content: 'private',
        },
      ],
      [
        {
          step_id: 1,
          source: 'agent',
          message: 'answer',
          is_copied_context: true,
        },
      ],
      [
        {
          step_id: 1,
          source: 'agent',
          message: 'answer',
          tool_calls: [
            {
              tool_call_id: 'call-1',
              function_name: 'read',
              arguments: {},
              extra: { provider: 'secret' },
            },
          ],
        },
      ],
      [
        {
          step_id: 1,
          source: 'agent',
          message: 'answer',
          observation: { results: [{ extra: { is_error: true } }] },
        },
      ],
    ];

    for (const steps of invalidSteps) {
      assert.throws(() =>
        parseJudgeTranscriptProjection({
          ...valid,
          transcriptJson: serializeCanonicalJson(steps),
        }),
      );
    }
  });

  it('rejects empty optional structures and broken ordering or correlation', () => {
    const valid = createJudgeTranscriptProjection(richTrajectory());
    const invalidSteps = [
      [{ step_id: 1, source: 'agent', message: '' }],
      [
        {
          step_id: 1,
          source: 'agent',
          message: [{ type: 'text', text: '' }],
        },
      ],
      [{ step_id: 1, source: 'agent', message: 'x', tool_calls: [] }],
      [
        {
          step_id: 1,
          source: 'agent',
          message: 'x',
          observation: { results: [] },
        },
      ],
      [
        { step_id: 2, source: 'user', message: 'first' },
        { step_id: 1, source: 'agent', message: 'second' },
      ],
      [
        {
          step_id: 1,
          source: 'agent',
          message: 'x',
          observation: {
            results: [{ source_call_id: 'missing', content: 'result' }],
          },
        },
      ],
    ];

    for (const steps of invalidSteps) {
      assert.throws(() =>
        parseJudgeTranscriptProjection({
          ...valid,
          transcriptJson: serializeCanonicalJson(steps),
        }),
      );
    }
  });
});

function richTrajectory(): AtifTrajectoryV1_8 {
  return {
    schema_version: 'ATIF-v1.8',
    session_id: 'session-1',
    agent: {
      name: 'test-agent',
      version: '1',
      model_name: 'provider-model',
      extra: { provider_private: true },
    },
    steps: [
      {
        step_id: 1,
        source: 'system',
        message: 'system instructions',
        timestamp: '2026-09-16T12:00:00Z',
        extra: { provider: 'provider-private' },
      },
      {
        step_id: 2,
        source: 'user',
        message: 'copied prior request',
        is_copied_context: true,
      },
      {
        step_id: 3,
        source: 'user',
        message: [
          { type: 'text', text: 'Inspect the result.' },
          {
            type: 'image',
            source: { media_type: 'image/png', path: 'expected.png' },
          },
        ],
        timestamp: '2026-09-16T12:00:01Z',
        llm_call_count: 0,
        extra: { provider: 'provider-private' },
      },
      {
        step_id: 4,
        source: 'agent',
        message: [
          { type: 'text', text: 'I used the tool.' },
          {
            type: 'audio',
            source: {
              media_type: 'audio/mpeg',
              path: 'explanation.mp3',
              duration_sec: 1.5,
            },
          },
        ],
        timestamp: '2026-09-16T12:00:02Z',
        model_name: 'provider-model',
        reasoning_content: 'private chain of thought',
        reasoning_effort: 'high',
        llm_call_count: 1,
        metrics: {
          prompt_tokens: 10,
          completion_tokens: 20,
          prompt_token_ids: [1, 2],
          extra: { provider: 'provider-private' },
        },
        tool_calls: [
          {
            tool_call_id: 'call-1',
            function_name: 'inspect',
            arguments: {
              reasoning_content: 'observable input',
              nested: { reasoning_effort: 7 },
            },
            extra: { provider: 'provider-private' },
          },
          {
            tool_call_id: 'call-2',
            function_name: 'read',
            arguments: { path: 'result.txt' },
          },
        ],
        observation: {
          results: [
            {
              source_call_id: 'call-1',
              content: 'Result text mentioning reasoning_content.',
              extra: {
                is_error: false,
                provider: 'provider-private',
                reasoning_content: 'dropped result metadata',
              },
            },
            {
              source_call_id: 'call-2',
              content: [{ type: 'text', text: 'read failed' }],
              extra: { is_error: true },
            },
            {
              content: 'Observable result without a provider call ID.',
              extra: { is_error: false },
            },
            {
              subagent_trajectory_ref: [
                {
                  trajectory_id: 'child-1',
                  session_id: 'child-session',
                  extra: { provider: 'provider-private' },
                },
              ],
            },
          ],
        },
        extra: { provider: 'provider-private' },
      },
      {
        step_id: 5,
        source: 'agent',
        message: '',
        reasoning_content: 'reasoning without a visible response',
      },
      {
        step_id: 6,
        source: 'system',
        message: 'system event',
      },
    ],
    notes: 'root metadata',
    final_metrics: { total_steps: 6, total_cost_usd: 0.5 },
    extra: { provider: 'provider-private' },
    subagent_trajectories: [
      {
        schema_version: 'ATIF-v1.8',
        trajectory_id: 'child-1',
        agent: { name: 'child-agent', version: '1' },
        steps: [
          {
            step_id: 1,
            source: 'agent',
            message: 'child private output',
          },
        ],
      },
    ],
  };
}

function metadataOf(
  projection: JudgeTranscriptProjectionV1,
): Omit<JudgeTranscriptProjectionV1, 'transcriptJson'> {
  const { transcriptJson: _, ...metadata } = projection;
  return metadata;
}

function expectedMetadata(): Omit<
  JudgeTranscriptProjectionV1,
  'transcriptJson'
> {
  return {
    source: JUDGE_TRANSCRIPT_SOURCE,
    projectionId: JUDGE_TRANSCRIPT_PROJECTION_ID,
    trajectoryScope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
    includedStepSources: JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
    copiedContext: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
    includedFields: JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  };
}
