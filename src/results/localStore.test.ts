import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {GUIDELINE_JUDGE_PROMPT_VERSION} from '../evaluation/guidelineJudge.js';
import {sha256Digest} from '../model/hashes.js';
import type {ResolvedRunPlanV1} from '../model/types.js';
import {
  resolvedRunPlanSha256,
  serializeResolvedRunPlan,
} from '../planning/index.js';
import {serializeCanonicalJson} from '../serialization.js';
import {createTestResolvedRunPlan} from '../testing/plans.js';
import {createArtifactStore, verifyCompletedRun} from './localStore.js';
import {parseRunResult} from './parse.js';
import {
  EVALUATION_SCHEMA_VERSION,
  RUN_RESULT_SCHEMA_VERSION,
  type ArtifactDescriptorV1,
  type JudgeEvidenceV1,
  type RunResultV1,
} from './types.js';

const roots: string[] = [];
const testPlan = createTestResolvedRunPlan({
  caseId: 'sample/case',
  prompt: 'do it',
  agent: {adapter: 'claude-code', provider: 'anthropic', model: 'test'},
});
const testPlanBody = Buffer.from(serializeResolvedRunPlan(testPlan), 'utf8');
const oneShotInteraction = {
  schema_version: 1,
  mode: 'one_shot',
  stop_reason: 'task_complete',
  turns: [{turn: 1, user: 'do it', assistant: 'done', tool_calls: []}],
  failure: null,
} as const;
const oneShotTrajectory = jsonBody({
  schema_version: 'ATIF-v1.8',
  session_id: 'session',
  agent: {name: 'test-agent', version: '1'},
  steps: [
    {step_id: 1, source: 'user', message: 'do it'},
    {step_id: 2, source: 'agent', message: 'done'},
  ],
});
const multiTurnInteraction = {
  schema_version: 1,
  mode: 'multi_turn',
  stop_reason: 'task_complete',
  turns: [
    {
      turn: 1,
      user: 'first prompt',
      assistant: 'first driver response',
      tool_calls: [{id: 'driver-call', name: 'Write', input: {path: 'a.txt'}}],
    },
    {
      turn: 2,
      user: 'second prompt',
      assistant: 'second driver response',
      tool_calls: [],
    },
  ],
  role_player: {
    model: {provider: 'test-provider', model: 'test-role-player'},
    prompt_version: '1',
    needs: [{id: 'need_1', description: 'Complete the requested task.'}],
    decisions: [
      {
        sequence: 1,
        after_agent_turn: null,
        message: 'first prompt',
        stop: false,
        remaining_need_ids: ['need_1'],
        focus_need_id: 'need_1',
        coding_agent_invoked: true,
        source: 'generated',
      },
      {
        sequence: 2,
        after_agent_turn: 1,
        message: 'second prompt',
        stop: false,
        remaining_need_ids: ['need_1'],
        focus_need_id: 'need_1',
        coding_agent_invoked: true,
        source: 'generated',
      },
      {
        sequence: 3,
        after_agent_turn: 2,
        message: '',
        stop: true,
        remaining_need_ids: [],
        focus_need_id: null,
        coding_agent_invoked: false,
        source: 'generated',
      },
    ],
  },
  failure: null,
} as const;
const rolePlayerFailure = {
  status: 'role_player_error',
  error_type: 'request_error',
  attempts: 3,
  explanation: 'Ava request failed after 3 attempts.',
} as const;
const zeroTurnInteraction = {
  schema_version: 1,
  mode: 'multi_turn',
  stop_reason: 'role_player_error',
  turns: [],
  role_player: {
    model: {provider: 'test-provider', model: 'test-role-player'},
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
        error: rolePlayerFailure,
      },
    ],
  },
  failure: rolePlayerFailure,
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('local artifact store', () => {
  it('commits result.json last and verifies every claimed byte', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const store = createArtifactStore({root});
    const transaction = await store.begin('run-1');
    const interactionBody = jsonBody(oneShotInteraction);
    const trajectoryBody = oneShotTrajectory;
    await transaction.write({
      path: 'plan.json',
      body: testPlanBody,
      mediaType: 'application/json',
    });
    await transaction.write({
      path: 'interaction.json',
      body: interactionBody,
      mediaType: 'application/json',
    });
    await transaction.write({
      path: 'trajectory.json',
      body: trajectoryBody,
      mediaType: 'application/json',
    });
    const artifacts: ArtifactDescriptorV1[] = [
      descriptorFor('plan.json', testPlanBody),
      descriptorFor('interaction.json', interactionBody),
      descriptorFor('trajectory.json', trajectoryBody),
    ];
    const result = resultFor(artifacts);
    const committed = await transaction.commit(
      result as unknown as Readonly<Record<string, unknown>>,
    );
    await expect(verifyCompletedRun(committed.location)).resolves.toMatchObject({runId: 'run-1'});
  });

  it('rejects duplicate descriptors that omit a staged artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const transaction = await createArtifactStore({root}).begin('run-1');
    const first = Buffer.from('{}\n');
    const second = Buffer.from('[]\n');
    await transaction.write({
      path: 'plan.json',
      body: first,
      mediaType: 'application/json',
    });
    await transaction.write({
      path: 'other.json',
      body: second,
      mediaType: 'application/json',
    });
    const descriptor: ArtifactDescriptorV1 = {
      path: 'plan.json',
      media_type: 'application/json',
      size_bytes: first.byteLength,
      sha256: sha256Digest(first),
    };
    const duplicated = [descriptor, descriptor];

    await expect(
      transaction.commit(
        resultFor(duplicated) as unknown as Readonly<Record<string, unknown>>,
      ),
    ).rejects.toThrow('Duplicate claimed artifact');
  });

  it('rejects result schema v1 evidence without provenance', () => {
    const result = resultFor([]);
    const evidenceWithoutProvenance: Record<string, unknown> = {
      ...result.evidence,
    };
    delete evidenceWithoutProvenance.provenance;

    expect(() =>
      parseRunResult({...result, evidence: evidenceWithoutProvenance}),
    ).toThrow();
  });

  it('rejects unsupported result schema versions', () => {
    expect(() => parseRunResult({...resultFor([]), schema_version: 2})).toThrow();
  });

  it('rejects the removed aggregate artifact-set digest', () => {
    expect(() =>
      parseRunResult({
        ...resultFor([]),
        artifact_set_sha256: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow();
  });

  it('rejects contradictory result-schema-v1 evidence provenance', () => {
    const result = resultFor([]);
    expect(() =>
      parseRunResult({
        ...result,
        evidence: {
          ...result.evidence,
          provenance: {
            ...result.evidence.provenance,
            adapter: {id: 'other-agent', version: '1'},
          },
        },
      }),
    ).toThrow('Evidence provenance does not match the recorded agent adapter');
  });

  it('requires the exact canonical core artifact inventory', async () => {
    const canonical = [
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {path: 'trajectory.json', body: oneShotTrajectory},
    ];
    const missingPlan = await commitArtifacts(
      canonical,
      (result) => result,
      {includePlan: false},
    );
    await expect(verifyCompletedRun(missingPlan)).rejects.toThrow(
      'missing canonical artifact plan.json',
    );

    const legacyEvaluation = await commitArtifacts([
      ...canonical,
      {path: 'evaluation.json', body: jsonBody({schema_version: 1})},
    ]);
    await expect(verifyCompletedRun(legacyEvaluation)).rejects.toThrow(
      'noncanonical core artifact evaluation.json',
    );

    const unexpectedWorkspace = await commitArtifacts([
      ...canonical,
      {path: 'workspace-evidence.json', body: emptyWorkspaceEvidenceBody()},
    ]);
    await expect(verifyCompletedRun(unexpectedWorkspace)).rejects.toThrow(
      'noncanonical core artifact workspace-evidence.json',
    );

    const missingWorkspace = await commitArtifacts(
      canonical,
      withPassingWorkspaceCheck,
    );
    await expect(verifyCompletedRun(missingWorkspace)).rejects.toThrow(
      'missing canonical artifact workspace-evidence.json',
    );

    const checkedRun = await commitArtifacts(
      [
        ...canonical,
        {path: 'workspace-evidence.json', body: emptyWorkspaceEvidenceBody()},
      ],
      withPassingWorkspaceCheck,
    );
    await expect(verifyCompletedRun(checkedRun)).resolves.toMatchObject({
      runId: 'run-1',
    });
  });

  it('strictly parses interaction.json and verifies its result summary', async () => {
    const missingLocation = await commitArtifacts([]);
    await expect(verifyCompletedRun(missingLocation)).rejects.toThrow(
      'missing canonical artifact interaction.json',
    );

    const invalidLocation = await commitArtifacts([
      {
        path: 'interaction.json',
        body: jsonBody({...oneShotInteraction, undeclared: true}),
      },
    ]);
    await expect(verifyCompletedRun(invalidLocation)).rejects.toThrow(
      'Completed interaction.json does not match its schema.',
    );

    const mismatchedLocation = await commitArtifacts(
      [{path: 'interaction.json', body: jsonBody(oneShotInteraction)}],
      (result) => ({
        ...result,
        interaction: {...result.interaction, turn_count: 2},
      }),
    );
    await expect(verifyCompletedRun(mismatchedLocation)).rejects.toThrow(
      'interaction.json does not match the completed result summary.',
    );
  });

  it('always requires a valid trajectory with the completed session identity', async () => {
    const missingLocation = await commitArtifacts([
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
    ]);
    await expect(verifyCompletedRun(missingLocation)).rejects.toThrow(
      'missing canonical artifact trajectory.json',
    );

    const invalidLocation = await commitArtifacts([
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {
        path: 'trajectory.json',
        body: jsonBody({
          schema_version: 'ATIF-v1.8',
          session_id: 'session',
          agent: {name: 'test-agent', version: '1'},
          steps: [{step_id: 1, source: 'unknown', message: 'do it'}],
        }),
      },
    ]);
    await expect(verifyCompletedRun(invalidLocation)).rejects.toThrow(
      'Completed trajectory.json does not match its schema.',
    );

    const mismatchedSessionLocation = await commitArtifacts([
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {
        path: 'trajectory.json',
        body: trajectoryBody(
          [
            {step_id: 1, source: 'user', message: 'do it'},
            {step_id: 2, source: 'agent', message: 'done'},
          ],
          'other-session',
        ),
      },
    ]);
    await expect(verifyCompletedRun(mismatchedSessionLocation)).rejects.toThrow(
      'trajectory.json session identity does not match the completed run.',
    );
  });

  it('accepts projection differences while requiring every ordered prompt and response', async () => {
    const compatibleTrajectory = trajectoryBody([
      {step_id: 1, source: 'user', message: 'first prompt'},
      {
        step_id: 2,
        source: 'agent',
        message: '',
        tool_calls: [
          {
            tool_call_id: 'native-call',
            function_name: 'DifferentNativeTool',
            arguments: {different: true},
          },
        ],
      },
      {step_id: 3, source: 'user', message: 'second prompt'},
      {step_id: 4, source: 'agent', message: 'different native response'},
    ]);
    const compatibleLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(multiTurnInteraction)},
        {path: 'trajectory.json', body: compatibleTrajectory},
      ],
      withMultiTurnSummary,
    );
    await expect(verifyCompletedRun(compatibleLocation)).resolves.toMatchObject({
      runId: 'run-1',
    });

    const incompatibleSteps = [
      [
        {step_id: 1, source: 'user', message: 'first prompt'},
        {step_id: 2, source: 'agent', message: 'only the first response'},
      ],
      [
        {step_id: 1, source: 'user', message: 'first prompt'},
        {step_id: 2, source: 'agent', message: 'first response'},
        {step_id: 3, source: 'user', message: 'second prompt'},
        {step_id: 4, source: 'agent', message: 'second response'},
        {step_id: 5, source: 'user', message: 'unexpected third prompt'},
        {step_id: 6, source: 'agent', message: 'third response'},
      ],
      [
        {step_id: 1, source: 'user', message: 'second prompt'},
        {step_id: 2, source: 'agent', message: 'second response'},
        {step_id: 3, source: 'user', message: 'first prompt'},
        {step_id: 4, source: 'agent', message: 'first response'},
      ],
      [
        {step_id: 1, source: 'user', message: 'first prompt'},
        {step_id: 2, source: 'agent', message: ''},
        {step_id: 3, source: 'user', message: 'second prompt'},
        {step_id: 4, source: 'agent', message: 'second response'},
      ],
      [
        {step_id: 1, source: 'user', message: 'first prompt'},
        {
          step_id: 2,
          source: 'agent',
          message: [{type: 'text', text: ''}],
        },
        {step_id: 3, source: 'user', message: 'second prompt'},
        {step_id: 4, source: 'agent', message: 'second response'},
      ],
    ];
    for (const steps of incompatibleSteps) {
      const location = await commitArtifacts(
        [
          {path: 'interaction.json', body: jsonBody(multiTurnInteraction)},
          {path: 'trajectory.json', body: trajectoryBody(steps)},
        ],
        withMultiTurnSummary,
      );
      await expect(verifyCompletedRun(location)).rejects.toThrow(
        'trajectory.json does not cover every completed interaction turn.',
      );
    }
  });

  it('accepts only the system fallback for a zero-turn role-player failure', async () => {
    const systemTrajectory = jsonBody({
      schema_version: 'ATIF-v1.8',
      agent: {name: 'test-agent', version: '1'},
      steps: [
        {
          step_id: 1,
          source: 'system',
          message: 'The role player failed before the coding agent was invoked.',
        },
      ],
    });
    const validLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(zeroTurnInteraction)},
        {path: 'trajectory.json', body: systemTrajectory},
      ],
      withZeroTurnRolePlayerFailure,
    );
    await expect(verifyCompletedRun(validLocation)).resolves.toMatchObject({
      runId: 'run-1',
    });

    const invalidLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(zeroTurnInteraction)},
        {
          path: 'trajectory.json',
          body: jsonBody({
            schema_version: 'ATIF-v1.8',
            agent: {name: 'test-agent', version: '1'},
            steps: [{step_id: 1, source: 'user', message: 'unsent prompt'}],
          }),
        },
      ],
      withZeroTurnRolePlayerFailure,
    );
    await expect(verifyCompletedRun(invalidLocation)).rejects.toThrow(
      'Zero-turn interaction requires the system-only role-player-error trajectory.',
    );
  });

  it('requires judge evidence exactly when guidelines were judged', async () => {
    const missingLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: oneShotTrajectory},
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(missingLocation)).rejects.toThrow(
      'missing judge-evidence.json',
    );

    const trajectory = oneShotTrajectory;
    const unexpectedLocation = await commitArtifacts([
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {path: 'trajectory.json', body: trajectory},
      {path: 'judge-evidence.json', body: judgeEvidenceBody()},
    ]);
    await expect(verifyCompletedRun(unexpectedLocation)).rejects.toThrow(
      'without judged guidelines contains judge-evidence.json',
    );
  });

  it('strictly parses judge evidence and its projection declaration', async () => {
    const trajectory = trajectoryBody([
      {step_id: 1, source: 'user', message: 'do it'},
      {
        step_id: 2,
        source: 'agent',
        message: 'done',
        reasoning_content: 'private reasoning',
        reasoning_effort: 'high',
      },
    ]);
    const validJudgeEvidence = judgeEvidenceValue();
    const validLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: trajectory},
        {path: 'judge-evidence.json', body: jsonBody(validJudgeEvidence)},
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(validLocation)).resolves.toMatchObject({
      runId: 'run-1',
    });

    const unsupportedPromptLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: trajectory},
        {
          path: 'judge-evidence.json',
          body: jsonBody({...validJudgeEvidence, prompt_version: 'unsupported'}),
        },
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(unsupportedPromptLocation)).rejects.toThrow(
      'prompt_version is not supported by this Forge build',
    );

    const unsupportedProjectionLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: trajectory},
        {
          path: 'judge-evidence.json',
          body: jsonBody({
            ...validJudgeEvidence,
            transcript: {
              ...validJudgeEvidence.transcript,
              projection_id: 'unsupported-projection',
            },
          }),
        },
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(unsupportedProjectionLocation)).rejects.toThrow(
      'Completed judge-evidence.json does not match its schema.',
    );

    const malformedTrajectory = jsonBody({
      schema_version: 'ATIF-v1.8',
      agent: {name: 'test-agent', version: '1'},
      steps: [{step_id: 1, source: 'unknown', message: 'do it'}],
    });
    const malformedTrajectoryLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: malformedTrajectory},
        {
          path: 'judge-evidence.json',
          body: jsonBody(validJudgeEvidence),
        },
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(malformedTrajectoryLocation)).rejects.toThrow(
      'Completed trajectory.json does not match its schema.',
    );

    const invalidLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: trajectory},
        {
          path: 'judge-evidence.json',
          body: jsonBody({
            ...validJudgeEvidence,
            undeclared: true,
          }),
        },
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(invalidLocation)).rejects.toThrow(
      'Completed judge-evidence.json does not match its schema.',
    );
  });
});

interface TestArtifact {
  readonly path: string;
  readonly body: Buffer;
}

async function commitArtifacts(
  artifacts: readonly TestArtifact[],
  transform: (result: RunResultV1) => RunResultV1 = (result) => result,
  options: {readonly includePlan?: boolean} = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
  roots.push(root);
  const transaction = await createArtifactStore({root}).begin('run-1');
  const plan = testPlanForResult(transform(resultFor([])));
  const planBody = Buffer.from(serializeResolvedRunPlan(plan), 'utf8');
  const completeArtifacts =
    options.includePlan === false ||
    artifacts.some(({path: artifactPath}) => artifactPath === 'plan.json')
      ? [...artifacts]
      : [{path: 'plan.json', body: planBody}, ...artifacts];
  for (const artifact of completeArtifacts) {
    await transaction.write({...artifact, mediaType: 'application/json'});
  }
  const descriptors = completeArtifacts.map(({path: artifactPath, body}) =>
    descriptorFor(artifactPath, body),
  );
  const committed = await transaction.commit(
    transform(resultFor(descriptors, plan)) as unknown as Readonly<Record<string, unknown>>,
  );
  return committed.location;
}

function testPlanForResult(result: RunResultV1): ResolvedRunPlanV1 {
  const multiTurn = result.interaction.mode === 'multi_turn';
  const guidelines = result.evaluation.guidelines.map(({guideline}) => guideline);
  const hasChecks = result.evaluation.checks.length > 0;
  return createTestResolvedRunPlan({
    caseId: 'sample/case',
    prompt: 'do it',
    mode: result.interaction.mode,
    ...(multiTurn
      ? {rolePlayer: {provider: 'test-provider', model: 'role-model'}}
      : {}),
    successGuidelines: guidelines,
    ...(guidelines.length === 0
      ? {}
      : {judge: {provider: 'test-provider', model: 'judge-model'}}),
    ...(hasChecks ? {checks: {files_created: ['answer.txt']}} : {}),
    agent: {adapter: 'claude-code', provider: 'anthropic', model: 'test'},
  });
}

function descriptorFor(
  artifactPath: string,
  body: Buffer,
): ArtifactDescriptorV1 {
  return {
    path: artifactPath,
    media_type: 'application/json',
    size_bytes: body.byteLength,
    sha256: sha256Digest(body),
  };
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(serializeCanonicalJson(value), 'utf8');
}

function trajectoryBody(
  steps: readonly unknown[],
  sessionId = 'session',
): Buffer {
  return jsonBody({
    schema_version: 'ATIF-v1.8',
    session_id: sessionId,
    agent: {name: 'test-agent', version: '1'},
    steps,
  });
}

function judgeEvidenceValue(): JudgeEvidenceV1 {
  return {
    schema_version: 1,
    prompt_version: GUIDELINE_JUDGE_PROMPT_VERSION,
    transcript: {
      source: 'trajectory.json',
      projection_id: 'forge-visible-atif-steps',
      projection_version: 1,
      trajectory_scope: 'root',
      included_step_sources: ['user', 'agent'],
      copied_context: 'excluded',
      included_fields: [
        'step_id',
        'source',
        'message',
        'tool_calls[].tool_call_id',
        'tool_calls[].function_name',
        'tool_calls[].arguments',
        'observation.results[].source_call_id',
        'observation.results[].content',
        'observation.results[].is_error',
      ],
    },
    workspace: {entries: [], complete: true, warnings: []},
  };
}

function judgeEvidenceBody(): Buffer {
  return jsonBody(judgeEvidenceValue());
}

function emptyWorkspaceEvidenceBody(): Buffer {
  return jsonBody({schema_version: 1, entries: [], complete: true, warnings: []});
}

function withPassingGuideline(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    evaluation: {
      ...result.evaluation,
      score: 1,
      guidelines_passed: 1,
      guidelines_total: 1,
      guidelines: [{guideline: 'The task is complete.', passed: true, explanation: 'Met.'}],
    },
  };
}

function withPassingWorkspaceCheck(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    evaluation: {
      ...result.evaluation,
      checks: [{name: 'file_created: answer.txt', passed: true}],
    },
  };
}

function withMultiTurnSummary(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    interaction: {mode: 'multi_turn', turn_count: 2},
  };
}

function withZeroTurnRolePlayerFailure(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    agent: {...result.agent, session_id: null},
    interaction: {mode: 'multi_turn', turn_count: 0},
    failure: rolePlayerFailure,
    evidence: {
      ...result.evidence,
      provenance: {
        source: {
          kind: 'role_player_error',
          format: 'forge-system-event',
        },
        adapter: result.evidence.provenance.adapter,
      },
      completeness: 'fallback',
      warnings: [
        {
          code: 'fallback_used',
          message:
            'Canonical ATIF contains only a system event because the role player failed before the agent was invoked.',
        },
      ],
    },
    stop_reason: 'role_player_error',
    warnings: [
      {
        code: 'role_player_error',
        message: rolePlayerFailure.explanation,
      },
    ],
  };
}

function resultFor(
  artifacts: ArtifactDescriptorV1[],
  plan: ResolvedRunPlanV1 = testPlan,
): RunResultV1 {
  return {
    schema_version: RUN_RESULT_SCHEMA_VERSION,
    run_id: 'run-1',
    selection: plan.selection,
    plan_sha256: resolvedRunPlanSha256(plan),
    forge: {version: plan.provenance.forge.version},
    runtime: {
      adapter: 'docker',
      runtime_id: 'run-1',
      platform: 'linux/amd64',
      metadata: {},
    },
    agent: {
      adapter: 'claude-code',
      adapter_version: '1',
      provider: plan.agent.provider,
      model: plan.agent.model,
      session_id: 'session',
      cost_usd: null,
    },
    completion_calls: [],
    interaction: {mode: 'one_shot', turn_count: 1},
    failure: null,
    evidence: {
      format: 'atif',
      schema_version: 'ATIF-v1.8',
      normalization_version: 1,
      provenance: {
        source: {
          kind: 'native_log',
          format: 'claude-code-jsonl',
          session_id: 'session',
        },
        adapter: {id: 'claude-code', version: '1'},
      },
      completeness: 'complete',
      warnings: [],
      redaction_count: 0,
    },
    evaluation: {
      schema_version: EVALUATION_SCHEMA_VERSION,
      score: 0,
      status: 'passed',
      guidelines_passed: 0,
      guidelines_total: 0,
      guidelines: [],
      checks: [],
    },
    started_at: '2026-09-15T00:00:00.000Z',
    completed_at: '2026-09-15T00:00:01.000Z',
    duration_ms: 1000,
    stop_reason: 'task_complete',
    artifacts,
    supplemental_artifacts: [],
    warnings: [],
  };
}
