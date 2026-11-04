import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { AtifValidationError } from '../atif/parser.ts';
import {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
} from '../evaluation/judgeTranscript.ts';
import { FORGE_VERSION } from '../version.ts';
import {
  parseEvaluationResult,
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseSetupArtifact,
  parseWorkspaceEvidence,
} from './parse.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTEXT = { forgeVersion: FORGE_VERSION };

describe('canonical interaction and judge evidence parsing', () => {
  it('requires compatible parent release context before parsing companion payloads', () => {
    for (const parser of [
      parseSetupArtifact,
      parseInteractionArtifact,
      parseWorkspaceEvidence,
      parseJudgeEvidence,
    ]) {
      assert.throws(() => parser({}, undefined as never));
      assert.throws(
        () => parser({}, { forgeVersion: '99.0.0' }),
        /incompatible with installed Forge/,
      );
      assert.throws(() =>
        parser({}, { forgeVersion: FORGE_VERSION, unknown: true } as never),
      );
    }
    assert.deepEqual(parseSetupArtifact({ steps: [] }, CONTEXT), { steps: [] });
    if (FORGE_VERSION.includes('-dev.')) {
      assert.deepEqual(
        parseSetupArtifact({ steps: [] }, { forgeVersion: '0.0.0-dev.42' }),
        { steps: [] },
      );
    } else {
      assert.throws(
        () =>
          parseSetupArtifact({ steps: [] }, { forgeVersion: '0.0.0-dev.42' }),
        /incompatible with installed Forge/,
      );
    }
  });

  it('strictly parses ordered setup resolutions', () => {
    const artifact = {
      steps: [
        { index: 0, uses: 'forge/write' },
        {
          index: 1,
          uses: 'acme/resolve',
          resolution: { commit: 'a'.repeat(40) },
        },
      ],
    };
    assert.deepEqual(parseSetupArtifact(artifact, CONTEXT), artifact);
    assert.throws(() =>
      parseSetupArtifact(
        {
          ...artifact,
          steps: [{ index: 1, uses: 'forge/write' }],
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseSetupArtifact({ ...artifact, unknown: true }, CONTEXT),
    );
    assert.throws(() =>
      parseSetupArtifact({ ...artifact, schema_version: 2 }, CONTEXT),
    );
    assert.throws(() =>
      parseSetupArtifact({ ...artifact, schema_version: 1 }, CONTEXT),
    );
  });

  it('parses check metadata and tool call evidence', () => {
    const base = {
      score: 0,
      status: 'passed',
      judging_criteria_passed: 0,
      judging_criteria_total: 0,
      judging_criteria_errored: 0,
      judging_criteria: [],
    };
    const toolCalls = {
      matched_count: 1,
      calls: [
        { step_id: 2, tool_call_id: 'a', function_name: 'stripe__create' },
      ],
    };
    const parsed = parseEvaluationResult({
      ...base,
      checks: [
        {
          name: 'tool_called: stripe__create',
          label: 'api',
          requirement_level: 'MUST',
          passed: true,
          tool_calls: toolCalls,
        },
        { name: 'file_created: a.txt', passed: true },
        {
          name: 'tool_called: other',
          requirement_level: 'OPTIONAL',
          passed: false,
          tool_calls: { matched_count: 0, calls: [] },
        },
      ],
    });
    assert.equal(parsed.checks[0]?.tool_calls?.calls[0]?.step_id, 2);
    assert.equal(parsed.checks[1]?.requirement_level, undefined);
    for (const [passed, matched_count] of [
      [true, 0],
      [false, 1],
    ] as const) {
      assert.throws(() =>
        parseEvaluationResult({
          ...base,
          checks: [
            {
              name: 'tool_called: x',
              passed,
              tool_calls: { matched_count, calls: [] },
            },
          ],
        }),
      );
    }
    assert.throws(() =>
      parseEvaluationResult({
        ...base,
        checks: [
          {
            name: 'tool_called: x',
            passed: true,
            tool_calls: { matched_count: 0, calls: toolCalls.calls },
          },
        ],
      }),
    );
    assert.throws(() =>
      parseEvaluationResult({
        ...base,
        checks: [
          {
            name: 'tool_called: x',
            passed: true,
            tool_calls: { ...toolCalls, arguments: { secret: 1 } },
          },
        ],
      }),
    );
  });

  it('parses evaluation snapshots and rejects contradictory criterion totals', () => {
    const evaluation = {
      score: 0.5,
      status: 'partial',
      judging_criteria_passed: 1,
      judging_criteria_total: 2,
      judging_criteria_errored: 0,
      judging_criteria: [
        {
          criterion: 'Complete the task.',
          passed: true,
          explanation: 'Done.',
        },
        {
          criterion: 'Explain the result.',
          passed: false,
          explanation: 'Missing.',
        },
      ],
      checks: [
        {
          name: 'file_exists: answer.txt',
          requirement_level: 'SHOULD',
          passed: true,
        },
      ],
    };
    const parsed = parseEvaluationResult(evaluation);
    assert.deepEqual(parsed, {
      ...evaluation,
      judging_criteria: evaluation.judging_criteria.map((criterion) => ({
        ...criterion,
        requirement_level: 'SHOULD',
      })),
    });
    assert.equal(
      Object.hasOwn(evaluation.judging_criteria[0]!, 'requirement_level'),
      false,
    );
    for (const [former, current] of [
      ['guidelines', 'judging_criteria'],
      ['guidelines_passed', 'judging_criteria_passed'],
      ['guidelines_total', 'judging_criteria_total'],
    ] as const) {
      assert.throws(() =>
        parseEvaluationResult({ ...evaluation, [former]: evaluation[current] }),
      );
      const { [current]: removed, ...remaining } = evaluation;
      assert.throws(() =>
        parseEvaluationResult({ ...remaining, [former]: removed }),
      );
    }
    assert.throws(() =>
      parseEvaluationResult({
        ...evaluation,
        judging_criteria: [
          {
            guideline: 'Complete the task.',
            passed: true,
            explanation: 'Done.',
          },
          evaluation.judging_criteria[1],
        ],
      }),
    );
    assert.throws(() =>
      parseEvaluationResult({ ...evaluation, schema_version: 1 }),
    );
    evaluation.judging_criteria[0]!.explanation = 'changed after parsing';
    assert.equal(parsed.judging_criteria[0]?.explanation, 'Done.');
    assert.throws(
      () => parseEvaluationResult({ ...evaluation, judging_criteria_total: 1 }),
      /Criterion totals do not match/,
    );
    assert.throws(
      () =>
        parseEvaluationResult({ ...evaluation, judging_criteria_passed: 2 }),
      /Criterion totals do not match/,
    );
    assert.throws(() =>
      parseEvaluationResult({ ...evaluation, score: Infinity }),
    );
    assert.throws(() =>
      parseEvaluationResult({ ...evaluation, unknown: true }),
    );
  });

  it('validates scoring totals against included criteria and retains labels', () => {
    const evaluation = {
      score: 1,
      status: 'passed',
      judging_criteria_passed: 1,
      judging_criteria_total: 1,
      judging_criteria_errored: 0,
      judging_criteria: [
        {
          criterion: 'Correct answer',
          label: 'correctness',
          passed: true,
          explanation: '',
          requirement_level: 'SHOULD' as const,
        },
        {
          criterion: 'Read docs',
          label: 'source',
          passed: false,
          explanation: '',
          requirement_level: 'OPTIONAL' as const,
        },
      ],
      checks: [],
    };
    assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    assert.throws(
      () => parseEvaluationResult({ ...evaluation, judging_criteria_total: 2 }),
      /Criterion totals/,
    );
    const observationalError = {
      ...evaluation,
      judging_criteria: [
        evaluation.judging_criteria[0],
        {
          ...evaluation.judging_criteria[1],
          passed: null,
          error: {
            type: 'request_error',
            attempts: 3,
            message: 'Service unavailable.',
          },
        },
      ],
    };
    assert.deepEqual(
      parseEvaluationResult(observationalError),
      observationalError,
    );
    for (const changed of [
      { label: 'bad-label' },
      { requirement_level: 'INVALID' },
      { include_in_score: false },
      { requirement_level: 'MAY' },
      { criteria_requirement: 'SHOULD' },
    ]) {
      assert.throws(() =>
        parseEvaluationResult({
          ...evaluation,
          judging_criteria: [
            evaluation.judging_criteria[0],
            { ...evaluation.judging_criteria[1], ...changed },
          ],
        }),
      );
    }
    assert.throws(
      () =>
        parseEvaluationResult({
          ...evaluation,
          judging_criteria: [
            { ...evaluation.judging_criteria[0], requirement_level: 'MUST' },
            evaluation.judging_criteria[1],
          ],
        }),
      /MUST criteria must use the uppercase RFC keyword MUST/,
    );
  });

  it('validates judge errors, their score denominator, and incomplete evaluation status', () => {
    const evaluation = {
      score: 1,
      status: 'judge_error',
      judging_criteria_passed: 1,
      judging_criteria_total: 2,
      judging_criteria_errored: 1,
      judging_criteria: [
        {
          criterion: 'valid',
          requirement_level: 'SHOULD',
          passed: true,
          explanation: 'Done.',
        },
        {
          criterion: 'unavailable',
          requirement_level: 'SHOULD',
          passed: null,
          error: { type: 'parse_error', attempts: 3, message: 'Invalid JSON.' },
          explanation: 'Invalid output.',
        },
      ],
      checks: [],
    };
    assert.deepEqual(parseEvaluationResult(evaluation), evaluation);
    for (const changed of [
      { ...evaluation, judging_criteria_errored: 0 },
      { ...evaluation, judging_criteria_passed: 2 },
      { ...evaluation, score: 0.5 },
      { ...evaluation, score: null },
      { ...evaluation, status: 'passed' },
      {
        ...evaluation,
        judging_criteria: [
          { ...evaluation.judging_criteria[1], passed: false },
        ],
      },
      {
        ...evaluation,
        judging_criteria: [
          { criterion: 'unavailable', passed: null, explanation: 'No error.' },
        ],
      },
      {
        ...evaluation,
        judging_criteria: [
          {
            ...evaluation.judging_criteria[1],
            error: { type: 'parse_error', attempts: 4 },
          },
        ],
      },
      ...[undefined, '', ' ', 'x'.repeat(4097)].map((message) => ({
        ...evaluation,
        judging_criteria: [
          evaluation.judging_criteria[0],
          {
            ...evaluation.judging_criteria[1],
            error: { type: 'parse_error', attempts: 3, message },
          },
        ],
      })),
    ])
      assert.throws(() => parseEvaluationResult(changed));
    const onlyErrors = {
      ...evaluation,
      score: null,
      judging_criteria_passed: 0,
      judging_criteria_total: 1,
      judging_criteria: [evaluation.judging_criteria[1]],
    };
    assert.deepEqual(parseEvaluationResult(onlyErrors), onlyErrors);
    assert.throws(() => parseEvaluationResult({ ...onlyErrors, score: 0 }));
  });

  it('strictly parses one-shot and multi-turn interaction audits', () => {
    assert.deepEqual(
      parseInteractionArtifact(
        {
          mode: 'one_shot',
          stop_reason: 'task_complete',
          turns: [
            { turn: 1, user: 'do it', assistant: 'done', tool_calls: [] },
          ],
          failure: null,
        },
        CONTEXT,
      ),
      {
        mode: 'one_shot',
        stop_reason: 'task_complete',
        turns: [{ turn: 1, user: 'do it', assistant: 'done', tool_calls: [] }],
        failure: null,
      },
    );

    assert.doesNotThrow(() =>
      parseInteractionArtifact(
        {
          mode: 'multi_turn',
          stop_reason: 'role_player_error',
          turns: [],
          role_player: {
            model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
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
        },
        CONTEXT,
      ),
    );
  });

  it('rejects unknown fields and inconsistent interaction ordering', () => {
    assert.throws(() =>
      parseInteractionArtifact(
        {
          schema_version: 1,
          mode: 'one_shot',
          stop_reason: 'task_complete',
          turns: [
            { turn: 1, user: 'do it', assistant: 'done', tool_calls: [] },
          ],
          failure: null,
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseInteractionArtifact(
        {
          mode: 'one_shot',
          stop_reason: 'task_complete',
          turns: [
            { turn: 2, user: 'do it', assistant: 'done', tool_calls: [] },
          ],
          failure: null,
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseInteractionArtifact(
        {
          mode: 'one_shot',
          stop_reason: 'task_complete',
          turns: [
            { turn: 1, user: 'do it', assistant: 'done', tool_calls: [] },
          ],
          failure: null,
          extra: true,
        },
        CONTEXT,
      ),
    );
  });

  it('binds multi-turn audit decisions to completed turns and failure state', () => {
    const interaction = {
      mode: 'multi_turn',
      stop_reason: 'task_complete',
      turns: [{ turn: 1, user: 'do it', assistant: 'done', tool_calls: [] }],
      role_player: {
        model: { provider: 'test-provider', model: 'role-model' },
        needs: null,
        decisions: [
          {
            sequence: 1,
            after_agent_turn: null,
            message: 'do it',
            stop: false,
            remaining_need_ids: null,
            focus_need_id: null,
            coding_agent_invoked: true,
            source: 'configured_initial_prompt',
          },
        ],
      },
      failure: null,
    };
    assert.deepEqual(
      parseInteractionArtifact(interaction, CONTEXT),
      interaction,
    );
    assert.throws(() =>
      parseInteractionArtifact(
        {
          ...interaction,
          role_player: { ...interaction.role_player, prompt_version: '1' },
        },
        CONTEXT,
      ),
    );
    const { role_player, ...withoutAudit } = interaction;
    assert.throws(
      () => parseInteractionArtifact(withoutAudit, CONTEXT),
      /require role-player audit state/,
    );
    assert.throws(
      () =>
        parseInteractionArtifact(
          {
            ...interaction,
            mode: 'one_shot',
          },
          CONTEXT,
        ),
      /cannot contain role-player state/,
    );
    assert.throws(
      () =>
        parseInteractionArtifact(
          {
            ...interaction,
            role_player: {
              ...role_player,
              decisions: [{ ...role_player.decisions[0], sequence: 2 }],
            },
          },
          CONTEXT,
        ),
      /Ava decisions must be contiguous/,
    );
    assert.throws(
      () =>
        parseInteractionArtifact(
          {
            ...interaction,
            role_player: {
              ...role_player,
              decisions: [
                { ...role_player.decisions[0], coding_agent_invoked: false },
              ],
            },
          },
          CONTEXT,
        ),
      /invocation decisions must match completed agent turns/,
    );
    assert.throws(
      () =>
        parseInteractionArtifact(
          {
            ...interaction,
            stop_reason: 'role_player_error',
          },
          CONTEXT,
        ),
      /Interaction failure must match its stop reason/,
    );
  });

  it('preserves configured opening prompts while retaining generated message bounds', () => {
    const interaction = (message: string, source: string) => ({
      mode: 'multi_turn',
      stop_reason: 'task_complete',
      turns: [{ turn: 1, user: message, assistant: 'done', tool_calls: [] }],
      role_player: {
        model: { provider: 'test-provider', model: 'role-model' },
        needs: null,
        decisions: [
          {
            sequence: 1,
            after_agent_turn: null,
            message,
            stop: false,
            remaining_need_ids: null,
            focus_need_id: null,
            coding_agent_invoked: true,
            source,
          },
        ],
      },
      failure: null,
    });
    const openingPrompt = 'x'.repeat(747);
    const configured = interaction(openingPrompt, 'configured_initial_prompt');
    assert.deepEqual(parseInteractionArtifact(configured, CONTEXT), configured);
    const generated = interaction('x'.repeat(500), 'generated');
    assert.deepEqual(parseInteractionArtifact(generated, CONTEXT), generated);
    assert.throws(() =>
      parseInteractionArtifact(
        interaction('x'.repeat(501), 'generated'),
        CONTEXT,
      ),
    );
    const oversizedDecision = interaction(
      'x'.repeat(16 * 1024 * 1024 + 1),
      'configured_initial_prompt',
    );
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
          { step_id: 1, source: 'user', message: 'do it' },
          { step_id: 2, source: 'agent', message: 'done' },
        ],
      },
      workspace: {
        entries: [{ path: 'answer.txt', content: 'done', truncated: false }],
        complete: true,
        warnings: [],
      },
    };
    assert.deepEqual(parseJudgeEvidence(evidence, CONTEXT), evidence);
    assert.throws(() =>
      parseJudgeEvidence({ ...evidence, prompt_version: '1' }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({ ...evidence, trajectory_sha256: DIGEST }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: { ...evidence.transcript, source: 'interaction.json' },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: { ...evidence.transcript, projection_id: 'unknown' },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: { ...evidence.transcript, projection_version: 1 },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: {
            ...evidence.transcript,
            trajectory_scope: 'root-and-subagents',
          },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: {
            ...evidence.transcript,
            included_step_sources: ['agent', 'user'],
          },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: { ...evidence.transcript, copied_context: 'included' },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: {
            ...evidence.transcript,
            included_fields: [
              ...evidence.transcript.included_fields.slice(0, -1),
            ],
          },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: {
            ...evidence.transcript,
            excluded_fields: ['reasoning_content', 'reasoning_effort'],
          },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: { ...evidence.transcript, sha256: DIGEST },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        {
          ...evidence,
          transcript: { ...evidence.transcript, unknown: true },
        },
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence({ ...evidence, unknown: true }, CONTEXT),
    );
  });

  it('requires and snapshots the visible judge steps', () => {
    const step = { step_id: 1, source: 'agent', message: 'done' };
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

    const { steps: _steps, ...policy } = evidence.transcript;
    assert.throws(() =>
      parseJudgeEvidence({ ...evidence, transcript: policy }, CONTEXT),
    );
    assert.throws(() =>
      parseJudgeEvidence({ ...evidence, schema_version: 2 }, CONTEXT),
    );
  });

  it('rejects private or unbounded content in embedded judge steps', () => {
    assert.throws(() =>
      parseJudgeEvidence(
        judgeEvidenceWithSteps([
          { step_id: 1, source: 'system', message: 'private instructions' },
        ]),
        CONTEXT,
      ),
    );
    assert.throws(() =>
      parseJudgeEvidence(
        judgeEvidenceWithSteps([
          {
            step_id: 1,
            source: 'agent',
            message: 'done',
            reasoning_content: 'private reasoning',
          },
        ]),
        CONTEXT,
      ),
    );
    const large = judgeEvidenceWithSteps([
      { step_id: 1, source: 'agent', message: 'x'.repeat(1024 * 1024) },
    ]);
    assert.deepEqual(parseJudgeEvidence(large, CONTEXT), large);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(
      () => parseJudgeEvidence(judgeEvidenceWithSteps([cycle]), CONTEXT),
      AtifValidationError,
    );
    let nested: unknown = {};
    for (let depth = 0; depth < 70; depth += 1) nested = { child: nested };
    assert.throws(
      () => parseJudgeEvidence(judgeEvidenceWithSteps([nested]), CONTEXT),
      AtifValidationError,
    );
  });

  it('accepts only an explicit budget omission with empty transcript steps', () => {
    const evidence = judgeEvidenceWithSteps([]);
    const omitted = {
      ...evidence,
      transcript: { ...evidence.transcript, omitted: 'judge_budget_exceeded' },
    };
    assert.deepEqual(parseJudgeEvidence(omitted, CONTEXT), omitted);
    for (const transcript of [
      { ...omitted.transcript, omitted: 'unknown_reason' },
      { ...omitted.transcript, budget_bytes: 0 },
      {
        ...omitted.transcript,
        steps: [{ step_id: 1, source: 'agent', message: 'Done' }],
      },
    ]) {
      assert.throws(() =>
        parseJudgeEvidence({ ...evidence, transcript }, CONTEXT),
      );
    }
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
    workspace: { entries: [], complete: true, warnings: [] },
  };
}
