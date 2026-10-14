import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AtifValidationError} from '../atif/parser.js';
import {FORGE_VERSION} from '../version.js';
import {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  MAX_JUDGE_TRANSCRIPT_BYTES,
} from '../evaluation/judgeTranscript.js';
import {
  parseEvaluationResult,
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseSetupArtifact,
  parseWorkspaceEvidence,
} from './parse.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTEXT = {forgeVersion: FORGE_VERSION};

describe('canonical interaction and judge evidence parsing', () => {
  it('requires compatible parent release context before parsing companion payloads', () => {
    for (const parser of [
      parseSetupArtifact,
      parseInteractionArtifact,
      parseWorkspaceEvidence,
      parseJudgeEvidence,
    ]) {
      assert.throws(() => parser({}, undefined as never));
      assert.throws(() => parser({}, {forgeVersion: '99.0.0'}), /incompatible with installed Forge/);
      assert.throws(() => parser({}, {forgeVersion: FORGE_VERSION, unknown: true} as never));
    }
    assert.deepEqual(parseSetupArtifact({steps: []}, CONTEXT), {steps: []});
    if (FORGE_VERSION.includes('-dev.')) {
      assert.deepEqual(parseSetupArtifact({steps: []}, {forgeVersion: '0.0.0-dev.42'}), {steps: []});
    } else {
      assert.throws(() => parseSetupArtifact({steps: []}, {forgeVersion: '0.0.0-dev.42'}), /incompatible with installed Forge/);
    }
  });

  it('strictly parses ordered setup resolutions', () => {
    const artifact = {
      steps: [
        {index: 0, uses: 'forge/write'},
        {
          index: 1,
          uses: 'acme/resolve',
          resolution: {commit: 'a'.repeat(40)},
        },
      ],
    };
    assert.deepEqual(parseSetupArtifact(artifact, CONTEXT), artifact);
    assert.throws(() =>
      parseSetupArtifact({
        ...artifact,
        steps: [{index: 1, uses: 'forge/write'}],
      }, CONTEXT),
    );
    assert.throws(() => parseSetupArtifact({...artifact, unknown: true}, CONTEXT));
    assert.throws(() => parseSetupArtifact({...artifact, schema_version: 2}, CONTEXT));
    assert.throws(() => parseSetupArtifact({...artifact, schema_version: 1}, CONTEXT));
  });

  it('parses evaluation snapshots and rejects contradictory criterion totals', () => {
    const evaluation = {
      score: 0.5,
      status: 'partial',
      judging_criteria_passed: 1,
      judging_criteria_total: 2,
      judging_criteria: [
        {criterion: 'Complete the task.', passed: true, explanation: 'Done.'},
        {criterion: 'Explain the result.', passed: false, explanation: 'Missing.'},
      ],
      checks: [{name: 'file_exists: answer.txt', passed: true}],
    };
    const parsed = parseEvaluationResult(evaluation);
    assert.deepEqual(parsed, evaluation);
    for (const [former, current] of [
      ['guidelines', 'judging_criteria'],
      ['guidelines_passed', 'judging_criteria_passed'],
      ['guidelines_total', 'judging_criteria_total'],
    ] as const) {
      assert.throws(() => parseEvaluationResult({...evaluation, [former]: evaluation[current]}));
      const {[current]: removed, ...remaining} = evaluation;
      assert.throws(() => parseEvaluationResult({...remaining, [former]: removed}));
    }
    assert.throws(() => parseEvaluationResult({...evaluation, judging_criteria: [
      {guideline: 'Complete the task.', passed: true, explanation: 'Done.'},
      evaluation.judging_criteria[1],
    ]}));
    assert.throws(() => parseEvaluationResult({...evaluation, schema_version: 1}));
    evaluation.judging_criteria[0]!.explanation = 'changed after parsing';
    assert.equal(parsed.judging_criteria[0]?.explanation, 'Done.');
    assert.throws(() => parseEvaluationResult({...evaluation, judging_criteria_total: 1}), /Criterion totals do not match/);
    assert.throws(() => parseEvaluationResult({...evaluation, judging_criteria_passed: 2}), /Criterion totals do not match/);
    assert.throws(() => parseEvaluationResult({...evaluation, score: Infinity}));
    assert.throws(() => parseEvaluationResult({...evaluation, unknown: true}));
  });

  it('validates scoring totals against included criteria and retains labels', () => {
    const evaluation = {
      score: 1, status: 'passed', judging_criteria_passed: 1, judging_criteria_total: 1,
      judging_criteria: [
        {criterion: 'Correct answer', label: 'correctness', passed: true, explanation: '', include_in_score: true},
        {criterion: 'Read docs', label: 'source', passed: false, explanation: '', include_in_score: false},
      ], checks: [],
    };
    assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    assert.throws(() => parseEvaluationResult({...evaluation, judging_criteria_total: 2}), /Criterion totals/);
    for (const changed of [{label: 'bad-label'}, {include_in_score: 'false'}]) {
      assert.throws(() => parseEvaluationResult({...evaluation, judging_criteria: [evaluation.judging_criteria[0], {...evaluation.judging_criteria[1], ...changed}]}));
    }
  });

  it('strictly parses one-shot and multi-turn interaction audits', () => {
    assert.deepEqual(
      parseInteractionArtifact({
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 1, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
      }, CONTEXT),
      {
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
        mode: 'multi_turn',
        stop_reason: 'role_player_error',
        turns: [],
        role_player: {
          model: {provider: 'anthropic', model: 'claude-sonnet-4-6'},
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
      }, CONTEXT),
    );
  });

  it('rejects unknown fields and inconsistent interaction ordering', () => {
    assert.throws(() => parseInteractionArtifact({
      schema_version: 1,
      mode: 'one_shot',
      stop_reason: 'task_complete',
      turns: [{turn: 1, user: 'do it', assistant: 'done', tool_calls: []}],
      failure: null,
    }, CONTEXT));
    assert.throws(() =>
      parseInteractionArtifact({
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 2, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
      }, CONTEXT),
    );
    assert.throws(() =>
      parseInteractionArtifact({
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [
          {turn: 1, user: 'do it', assistant: 'done', tool_calls: []},
        ],
        failure: null,
        extra: true,
      }, CONTEXT),
    );
  });

  it('binds multi-turn audit decisions to completed turns and failure state', () => {
    const interaction = {
      mode: 'multi_turn',
      stop_reason: 'task_complete',
      turns: [{turn: 1, user: 'do it', assistant: 'done', tool_calls: []}],
      role_player: {
        model: {provider: 'test-provider', model: 'role-model'},
        needs: null,
        decisions: [{
          sequence: 1, after_agent_turn: null, message: 'do it', stop: false,
          remaining_need_ids: null, focus_need_id: null, coding_agent_invoked: true,
          source: 'configured_initial_prompt',
        }],
      },
      failure: null,
    };
    assert.deepEqual(parseInteractionArtifact(interaction, CONTEXT), interaction);
    assert.throws(() => parseInteractionArtifact({
      ...interaction, role_player: {...interaction.role_player, prompt_version: '1'},
    }, CONTEXT));
    const {role_player, ...withoutAudit} = interaction;
    assert.throws(() => parseInteractionArtifact(withoutAudit, CONTEXT), /require role-player audit state/);
    assert.throws(() => parseInteractionArtifact({
      ...interaction, mode: 'one_shot',
    }, CONTEXT), /cannot contain role-player state/);
    assert.throws(() => parseInteractionArtifact({
      ...interaction, role_player: {...role_player, decisions: [{...role_player.decisions[0], sequence: 2}]},
    }, CONTEXT), /Ava decisions must be contiguous/);
    assert.throws(() => parseInteractionArtifact({
      ...interaction, role_player: {...role_player, decisions: [{...role_player.decisions[0], coding_agent_invoked: false}]},
    }, CONTEXT), /invocation decisions must match completed agent turns/);
    assert.throws(() => parseInteractionArtifact({
      ...interaction, stop_reason: 'role_player_error',
    }, CONTEXT), /Interaction failure must match its stop reason/);
  });

  it('preserves configured opening prompts while retaining generated message bounds', () => {
    const interaction = (message: string, source: string) => ({
      mode: 'multi_turn',
      stop_reason: 'task_complete',
      turns: [{turn: 1, user: message, assistant: 'done', tool_calls: []}],
      role_player: {
        model: {provider: 'test-provider', model: 'role-model'},
        needs: null,
        decisions: [{
          sequence: 1, after_agent_turn: null, message, stop: false,
          remaining_need_ids: null, focus_need_id: null, coding_agent_invoked: true,
          source,
        }],
      },
      failure: null,
    });
    const openingPrompt = 'x'.repeat(747);
    const configured = interaction(openingPrompt, 'configured_initial_prompt');
    assert.deepEqual(parseInteractionArtifact(configured, CONTEXT), configured);
    const generated = interaction('x'.repeat(500), 'generated');
    assert.deepEqual(parseInteractionArtifact(generated, CONTEXT), generated);
    assert.throws(() => parseInteractionArtifact(interaction('x'.repeat(501), 'generated'), CONTEXT));
    const oversizedDecision = interaction('x'.repeat(16 * 1024 * 1024 + 1), 'configured_initial_prompt');
    oversizedDecision.turns[0]!.user = 'short opening';
    assert.throws(() => parseInteractionArtifact(oversizedDecision, CONTEXT));
  });

  it('strictly parses judge evidence and its projection declaration', () => {
    const evidence = {
      transcript: {
        source: 'trajectory.json',
        projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
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
    assert.deepEqual(parseJudgeEvidence(evidence, CONTEXT), evidence);
    assert.throws(() => parseJudgeEvidence({...evidence, prompt_version: '1'}, CONTEXT));
    assert.throws(() =>
      parseJudgeEvidence({...evidence, trajectory_sha256: DIGEST}, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, source: 'interaction.json'},
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, projection_id: 'unknown'},
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, projection_version: 1},
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          trajectory_scope: 'root-and-subagents',
        },
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          included_step_sources: ['agent', 'user'],
        },
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, copied_context: 'included'},
      }, CONTEXT),
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
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          excluded_fields: ['reasoning_content', 'reasoning_effort'],
        },
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, sha256: DIGEST},
      }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({
        ...evidence,
        transcript: {...evidence.transcript, unknown: true},
      }, CONTEXT),
    );
    assert.throws(() => parseJudgeEvidence({...evidence, unknown: true}, CONTEXT));
  });

  it('requires and snapshots the visible judge steps', () => {
    const step = {step_id: 1, source: 'agent', message: 'done'};
    const evidence = judgeEvidenceWithSteps([step]);
    const parsed = parseJudgeEvidence(evidence, CONTEXT);
    assert.deepEqual(parsed, evidence);
    step.message = 'changed after parsing';
    assert.ok(!('schema_version' in parsed));
    assert.equal(parsed.transcript.steps[0]?.message, 'done');
    assert.deepEqual(
      parseJudgeEvidence(judgeEvidenceWithSteps([]), CONTEXT),
      judgeEvidenceWithSteps([]),
    );

    const {steps: _steps, ...policy} = evidence.transcript;
    assert.throws(() => parseJudgeEvidence({...evidence, transcript: policy}, CONTEXT));
    assert.throws(() => parseJudgeEvidence({...evidence, schema_version: 2}, CONTEXT));
  });

  it('rejects private or unbounded content in embedded judge steps', () => {
    assert.throws(() => parseJudgeEvidence(judgeEvidenceWithSteps([
      {step_id: 1, source: 'system', message: 'private instructions'},
    ]), CONTEXT));
    assert.throws(() => parseJudgeEvidence(judgeEvidenceWithSteps([
      {
        step_id: 1,
        source: 'agent',
        message: 'done',
        reasoning_content: 'private reasoning',
      },
    ]), CONTEXT));
    assert.throws(() => parseJudgeEvidence(judgeEvidenceWithSteps([
      {step_id: 1, source: 'agent', message: 'x'.repeat(MAX_JUDGE_TRANSCRIPT_BYTES)},
    ]), CONTEXT), /Judge transcript projection exceeds the .*byte limit/);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(
      () => parseJudgeEvidence(judgeEvidenceWithSteps([cycle]), CONTEXT),
      AtifValidationError,
    );
    let nested: unknown = {};
    for (let depth = 0; depth < 70; depth += 1) nested = {child: nested};
    assert.throws(
      () => parseJudgeEvidence(judgeEvidenceWithSteps([nested]), CONTEXT),
      AtifValidationError,
    );
  });
});

function judgeEvidenceWithSteps(steps: readonly unknown[]) {
  return {
    transcript: {
      source: 'trajectory.json',
      projection_id: JUDGE_TRANSCRIPT_PROJECTION_ID,
      trajectory_scope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
      included_step_sources: JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
      copied_context: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
      included_fields: JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
      steps,
    },
    workspace: {entries: [], complete: true, warnings: []},
  };
}
