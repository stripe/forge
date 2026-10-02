import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AtifValidationError} from '../atif/parser.js';
import {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  MAX_JUDGE_TRANSCRIPT_BYTES,
} from '../evaluation/judgeTranscript.js';
import {
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseSetupArtifact,
} from './parse.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('canonical interaction and judge evidence parsing', () => {
  it('strictly parses ordered setup resolutions', () => {
    const artifact = {
      schema_version: 2,
      steps: [
        {index: 0, uses: 'forge/write'},
        {
          index: 1,
          uses: 'acme/resolve',
          resolution: {commit: 'a'.repeat(40)},
        },
      ],
    };
    assert.deepEqual(parseSetupArtifact(artifact), artifact);
    assert.throws(() =>
      parseSetupArtifact({
        ...artifact,
        steps: [{index: 1, uses: 'forge/write'}],
      }),
    );
    assert.throws(() => parseSetupArtifact({...artifact, unknown: true}));
    assert.throws(() => parseSetupArtifact({...artifact, schema_version: 1}));
  });

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

  it('strictly parses judge evidence and its projection declaration', () => {
    const evidence = {
      schema_version: 1,
      prompt_version: '1',
      transcript: {
        source: 'trajectory.json',
        projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
        projection_version: JUDGE_TRANSCRIPT_PROJECTION_VERSION,
        trajectory_scope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
        included_step_sources: JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
        copied_context: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
        included_fields: JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
        steps: [
          {step_id: 1, source: 'user', message: 'do it'},
          {step_id: 2, source: 'agent', message: 'done'},
        ],
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
      parseJudgeEvidence({...evidence, trajectory_sha256: DIGEST}),
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
          trajectory_scope: 'root-and-subagents',
        },
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          included_step_sources: ['agent', 'user'],
        },
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, copied_context: 'included'},
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          included_fields: [
            ...evidence.transcript.included_fields.slice(0, -1),
          ],
        },
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          excluded_fields: ['reasoning_content', 'reasoning_effort'],
        },
      }),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, sha256: DIGEST},
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

  it('requires and snapshots the visible judge steps', () => {
    const step = {step_id: 1, source: 'agent', message: 'done'};
    const evidence = judgeEvidenceWithSteps([step]);
    const parsed = parseJudgeEvidence(evidence);
    assert.deepEqual(parsed, evidence);
    step.message = 'changed after parsing';
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.transcript.steps[0]?.message, 'done');
    assert.deepEqual(
      parseJudgeEvidence(judgeEvidenceWithSteps([])),
      judgeEvidenceWithSteps([]),
    );

    const {steps: _steps, ...policy} = evidence.transcript;
    assert.throws(() => parseJudgeEvidence({...evidence, transcript: policy}));
    assert.throws(() => parseJudgeEvidence({...evidence, schema_version: 2}));
    assert.throws(() => parseJudgeEvidence({...evidence, schema_version: 3}));
    assert.throws(() => parseJudgeEvidence({...evidence, unknown: true}));
    assert.throws(() => parseJudgeEvidence({
      ...evidence,
      transcript: {...evidence.transcript, unknown: true},
    }));
  });

  it('rejects private or unbounded content in embedded judge steps', () => {
    assert.throws(() => parseJudgeEvidence(judgeEvidenceWithSteps([
      {step_id: 1, source: 'system', message: 'private instructions'},
    ])));
    assert.throws(() => parseJudgeEvidence(judgeEvidenceWithSteps([
      {
        step_id: 1,
        source: 'agent',
        message: 'done',
        reasoning_content: 'private reasoning',
      },
    ])));
    assert.throws(() => parseJudgeEvidence(judgeEvidenceWithSteps([
      {step_id: 1, source: 'agent', message: 'x'.repeat(MAX_JUDGE_TRANSCRIPT_BYTES)},
    ])), /Judge transcript projection exceeds the .*byte limit/);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(
      () => parseJudgeEvidence(judgeEvidenceWithSteps([cycle])),
      AtifValidationError,
    );
    let nested: unknown = {};
    for (let depth = 0; depth < 70; depth += 1) nested = {child: nested};
    assert.throws(
      () => parseJudgeEvidence(judgeEvidenceWithSteps([nested])),
      AtifValidationError,
    );
  });
});

function judgeEvidenceWithSteps(steps: readonly unknown[]) {
  return {
    schema_version: 1,
    prompt_version: '1',
    transcript: {
      source: 'trajectory.json',
      projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
      projection_version: JUDGE_TRANSCRIPT_PROJECTION_VERSION,
      trajectory_scope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
      included_step_sources: JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
      copied_context: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
      included_fields: JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
      steps,
    },
    workspace: {entries: [], complete: true, warnings: []},
  };
}
