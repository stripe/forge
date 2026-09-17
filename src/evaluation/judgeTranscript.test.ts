import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  AtifValidationError,
  type AtifStep,
  type AtifTrajectoryV1_8,
} from '../atif/index.js';
import {sha256Digest} from '../model/hashes.js';
import {serializeCanonicalJson} from '../serialization.js';
import {
  JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_SOURCE,
  createJudgeTranscriptProjection,
} from './judgeTranscript.js';

describe('createJudgeTranscriptProjection', () => {
  it('removes only typed root-step reasoning fields and preserves opaque data', () => {
    const trajectory: AtifTrajectoryV1_8 = {
      schema_version: 'ATIF-v1.8',
      session_id: 'session-1',
      agent: {name: 'test-agent', version: '1'},
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: 'Keep the text reasoning_content and reasoning_effort.',
          reasoning_content: null,
          reasoning_effort: null,
          extra: {
            reasoning_content: 'user-extra-content',
            reasoning_effort: 'user-extra-effort',
          },
        },
        {
          step_id: 2,
          source: 'agent',
          message: [
            {type: 'text', text: 'Visible response mentioning reasoning_content.'},
            {type: 'image', source: {media_type: 'image/png', path: 'result.png'}},
          ],
          reasoning_content: 'private chain of thought',
          reasoning_effort: 'high',
          tool_calls: [
            {
              tool_call_id: 'call-1',
              function_name: 'record',
              arguments: {
                reasoning_content: 'tool-input-content',
                nested: {reasoning_effort: 7},
              },
              extra: {reasoning_effort: 'tool-extra-effort'},
            },
          ],
          observation: {
            results: [
              {
                source_call_id: 'call-1',
                content: 'Visible tool result containing reasoning_effort.',
                extra: {reasoning_content: 'observation-extra-content'},
              },
            ],
          },
          extra: {
            reasoning_content: 'step-extra-content',
            reasoning_effort: 'step-extra-effort',
          },
        },
        {
          step_id: 3,
          source: 'system',
          message: 'Visible system event.',
          reasoning_content: null,
          reasoning_effort: null,
        },
      ],
      notes: 'Root metadata is not part of the judge transcript.',
      subagent_trajectories: [
        {
          schema_version: 'ATIF-v1.8',
          trajectory_id: 'child-1',
          agent: {name: 'child-agent', version: '1'},
          steps: [
            {
              step_id: 1,
              source: 'agent',
              message: 'Child output is outside the root-step projection.',
              reasoning_content: 'child private reasoning',
            },
          ],
        },
      ],
    };
    const before = structuredClone(trajectory);

    const projection = createJudgeTranscriptProjection(trajectory);

    assert.deepEqual(trajectory, before);
    assert.equal(Object.isFrozen(trajectory), false);
    assert.equal(Object.isFrozen(trajectory.steps), false);
    assert.equal(Object.isFrozen(trajectory.steps[1]?.extra), false);
    assert.equal(projection.source, JUDGE_TRANSCRIPT_SOURCE);
    assert.equal(projection.projectionId, JUDGE_TRANSCRIPT_PROJECTION_ID);
    assert.equal(
      projection.projectionVersion,
      JUDGE_TRANSCRIPT_PROJECTION_VERSION,
    );
    assert.equal(
      projection.excludedFields,
      JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
    );
    const projectedSteps = JSON.parse(projection.transcriptJson) as AtifStep[];
    assert.equal(projectedSteps.length, trajectory.steps.length);
    for (const step of projectedSteps) {
      assert.equal(Object.hasOwn(step, 'reasoning_content'), false);
      assert.equal(Object.hasOwn(step, 'reasoning_effort'), false);
    }

    const projectedAgent = projectedSteps[1];
    assert.equal(projectedAgent?.source, 'agent');
    assert.deepEqual(projectedAgent?.extra, {
      reasoning_content: 'step-extra-content',
      reasoning_effort: 'step-extra-effort',
    });
    assert.deepEqual(projectedAgent?.tool_calls?.[0]?.arguments, {
      reasoning_content: 'tool-input-content',
      nested: {reasoning_effort: 7},
    });
    assert.deepEqual(projectedAgent?.observation?.results[0]?.extra, {
      reasoning_content: 'observation-extra-content',
    });
    assert.match(projection.transcriptJson, /Visible response mentioning reasoning_content/);
    assert.doesNotMatch(projection.transcriptJson, /private chain of thought/);
    assert.doesNotMatch(projection.transcriptJson, /child private reasoning/);
    assert.equal(JSON.parse(projection.transcriptJson).length, 3);
  });

  it('returns immutable metadata and hashes exact canonical JSON bytes', () => {
    const trajectory: AtifTrajectoryV1_8 = {
      schema_version: 'ATIF-v1.8',
      agent: {name: 'test-agent', version: '1'},
      steps: [
        {step_id: 1, source: 'user', message: 'Do the task.'},
        {
          step_id: 2,
          source: 'agent',
          message: 'Done.',
          reasoning_content: 'Think privately.',
          tool_calls: [
            {
              tool_call_id: 'call-1',
              function_name: 'write',
              arguments: {z: 1, a: {value: true}},
            },
          ],
        },
      ],
    };

    const first = createJudgeTranscriptProjection(trajectory);
    const second = createJudgeTranscriptProjection(structuredClone(trajectory));
    const expected = serializeCanonicalJson([
      {step_id: 1, source: 'user', message: 'Do the task.'},
      {
        step_id: 2,
        source: 'agent',
        message: 'Done.',
        tool_calls: [
          {
            tool_call_id: 'call-1',
            function_name: 'write',
            arguments: {z: 1, a: {value: true}},
          },
        ],
      },
    ]);

    assert.equal(first.transcriptJson, expected);
    assert.equal(first.transcriptJson.endsWith('\n'), true);
    assert.equal(first.transcriptSha256, sha256Digest(expected));
    assert.equal(second.transcriptJson, first.transcriptJson);
    assert.equal(second.transcriptSha256, first.transcriptSha256);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.excludedFields), true);
  });

  it('validates a casted trajectory before producing judge-visible bytes', () => {
    const invalid = {
      schema_version: 'ATIF-v1.8',
      agent: {name: 'test-agent', version: '1'},
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
