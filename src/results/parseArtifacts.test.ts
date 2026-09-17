import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
} from '../evaluation/judgeTranscript.js';
import {parseInteractionArtifact, parseJudgeEvidence} from './parse.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('canonical interaction and judge evidence parsing', () => {
  it('strictly parses one-shot and multi-turn interaction audits', () => {
    assert.deepEqual(
      parseInteractionArtifact({
        schema_version: 1,
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 1, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
      }),
      {
        schema_version: 1,
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 1, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
      },
    );

    assert.doesNotThrow(() =>
      parseInteractionArtifact({
        schema_version: 1,
        mode: 'multi_turn',
        stop_reason: 'role_player_error',
        turns: [],
        role_player: {
          model: {provider: 'anthropic', model: 'claude-sonnet-4-6'},
          prompt_version: '1',
          needs: null,
          decisions: [
            {
              sequence: 1,
              after_agent_turn: null,
              message: '',
              stop: true,
              remaining_need_ids: null,
              focus_need_id: null,
              coding_agent_invoked: false,
              source: 'generated',
              error: {
                status: 'role_player_error',
                error_type: 'request_error',
                attempts: 3,
                explanation: 'Ava request failed after 3 attempts.',
              },
            },
          ],
        },
        failure: {
          status: 'role_player_error',
          error_type: 'request_error',
          attempts: 3,
          explanation: 'Ava request failed after 3 attempts.',
        },
      }),
    );
  });

  it('rejects unknown fields and inconsistent interaction ordering', () => {
    assert.throws(() =>
      parseInteractionArtifact({
        schema_version: 1,
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 2, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
      }),
    );
    assert.throws(() =>
      parseInteractionArtifact({
        schema_version: 1,
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 1, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
        extra: true,
      }),
    );
  });

  it('strictly parses bounded judge evidence', () => {
    const evidence = {
      schema_version: 1,
      prompt_version: '1',
      trajectory_sha256: DIGEST,
      transcript: {
        source: 'trajectory.json',
        projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
        projection_version: JUDGE_TRANSCRIPT_PROJECTION_VERSION,
        excluded_fields: JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
        sha256: DIGEST,
      },
      workspace: {
        entries: [
          {path: 'answer.txt', content: 'done', truncated: false},
        ],
        complete: true,
        warnings: [],
      },
    };
    assert.deepEqual(parseJudgeEvidence(evidence), evidence);
    assert.throws(() =>
      parseJudgeEvidence({...evidence, trajectory_sha256: 'sha256:invalid'}),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, source: 'interaction.json'},
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, projection_id: 'unknown'},
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, projection_version: 2},
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          excluded_fields: ['reasoning_effort', 'reasoning_content'],
        },
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, sha256: 'sha256:invalid'},
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, unknown: true},
      }),
    );
    assert.throws(() => parseJudgeEvidence({...evidence, unknown: true}));
  });
});
