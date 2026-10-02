import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {parseAtifTrajectory, type AtifStep} from '../atif/index.js';
import {GUIDELINE_JUDGE_PROMPT_VERSION} from '../evaluation/guidelineJudge.js';
import {createJudgeTranscriptProjection} from '../evaluation/judgeTranscript.js';
import {sha256Digest} from '../model/hashes.js';
import type {ResolvedRunPlanV1} from '../model/types.js';
import {serializeResolvedRunPlan} from '../planning/index.js';
import {serializeCanonicalJson} from '../serialization.js';
import {createTestResolvedRunPlan} from '../testing/plans.js';
import {createArtifactStore, verifyCompletedRun} from './localStore.js';
import {parseRunResult} from './parse.js';
import {
  EVALUATION_SCHEMA_VERSION,
  RUN_RESULT_SCHEMA_VERSION,
  type ArtifactDescriptorV1,
  type InteractionArtifactV1,
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
    const setupBody = emptySetupBody(testPlan);
    const trajectoryBody = oneShotTrajectory;
    await transaction.write({
      path: 'plan.json',
      body: testPlanBody,
      mediaType: 'application/json',
    });
    await transaction.write({
      path: 'setup.json',
      body: setupBody,
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
      descriptorFor('setup.json', setupBody),
      descriptorFor('interaction.json', interactionBody),
      descriptorFor('trajectory.json', trajectoryBody),
    ];
    const result = resultFor(artifacts);
    const committed = await transaction.commit(
      result as unknown as Readonly<Record<string, unknown>>,
    );
    await expect(verifyCompletedRun(committed.location)).resolves.toMatchObject({runId: 'run-1'});
    await fs.writeFile(path.join(committed.location, 'result.json'), JSON.stringify({
      ...result,
      runtime: {...result.runtime, adapter: 'docker'},
    }));
    await expect(verifyCompletedRun(committed.location)).rejects.toThrow(
      'plan.json runtime does not match',
    );
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

  it('independently checks claimed digests against staged artifact inputs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const transaction = await createArtifactStore({root}).begin('run-1');
    await transaction.write({
      path: 'plan.json',
      body: testPlanBody,
      mediaType: 'application/json',
    });
    const descriptor = {
      ...descriptorFor('plan.json', testPlanBody),
      sha256: `sha256:${'f'.repeat(64)}` as const,
    };
    await expect(transaction.commit(resultFor([descriptor]) as unknown as Record<string, unknown>))
      .rejects.toThrow('Result descriptor mismatch: plan.json');
  });

  it('checks plan artifact bytes and canonicalization without a duplicate plan digest', async () => {
    const canonical = [
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {path: 'trajectory.json', body: oneShotTrajectory},
    ];
    const location = await commitArtifacts(canonical);
    await expect(verifyCompletedRun(location)).resolves.toMatchObject({runId: 'run-1'});
    const alteredPlan = testPlanBody.toString('utf8').replace(
      '"effective_prompt":"do it"',
      '"effective_prompt":"go it"',
    );
    expect(Buffer.byteLength(alteredPlan)).toBe(testPlanBody.byteLength);
    expect(alteredPlan).not.toBe(testPlanBody.toString('utf8'));
    await fs.writeFile(path.join(location, 'plan.json'), alteredPlan);
    await expect(verifyCompletedRun(location)).rejects.toThrow(
      'Artifact does not match its descriptor: plan.json',
    );

    const noncanonical = await commitArtifacts([
      ...canonical,
      {path: 'plan.json', body: Buffer.from(JSON.stringify(testPlan, null, 2))},
    ]);
    await expect(verifyCompletedRun(noncanonical)).rejects.toThrow(
      'Completed plan.json is not canonical.',
    );
  });

  it('strictly verifies workspace evidence schema and removed fields', async () => {
    const canonical = [
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {path: 'trajectory.json', body: oneShotTrajectory},
    ];
    const entry = {
      path: 'answer.txt',
      exists: true,
      kind: 'file',
      size_bytes: 4,
      content_base64: Buffer.from('done').toString('base64'),
    };
    const workspace = {schema_version: 1, entries: [entry], complete: true, warnings: []};
    const valid = await commitArtifacts([
      ...canonical,
      {path: 'workspace-evidence.json', body: jsonBody(workspace)},
    ], withPassingWorkspaceCheck);
    await expect(verifyCompletedRun(valid)).resolves.toMatchObject({runId: 'run-1'});
    for (const invalidWorkspace of [
      {...workspace, schema_version: 2},
      {...workspace, schema_version: 3},
      {...workspace, entries: [{...entry, sha256: `sha256:${'a'.repeat(64)}`}]},
    ]) {
      const invalid = await commitArtifacts([
        ...canonical,
        {path: 'workspace-evidence.json', body: jsonBody(invalidWorkspace)},
      ], withPassingWorkspaceCheck);
      await expect(verifyCompletedRun(invalid)).rejects.toThrow(
        'Completed workspace-evidence.json does not match its schema.',
      );
    }
    await fs.writeFile(path.join(valid, 'workspace-evidence.json'), jsonBody({
      ...workspace,
      entries: [{...entry, content_base64: Buffer.from('fail').toString('base64')}],
    }));
    await expect(verifyCompletedRun(valid)).rejects.toThrow(
      'Artifact does not match its descriptor: workspace-evidence.json',
    );
  });

  it('rejects result evidence without provenance', () => {
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
    for (const schema_version of [2, 3]) {
      expect(() => parseRunResult({...resultFor([]), schema_version})).toThrow();
    }
  });

  it('rejects the removed duplicate plan digest', () => {
    expect(() => parseRunResult({
      ...resultFor([]),
      plan_sha256: `sha256:${'a'.repeat(64)}`,
    })).toThrow();
  });

  it('rejects the removed runtime version field', () => {
    const result = resultFor([]);
    expect(() => parseRunResult({
      ...result,
      runtime: {...result.runtime, adapter_version: '1'},
    })).toThrow();
  });

  it('requires non-empty, unique, canonically ordered action bundle provenance', () => {
    const first = {
      namespace: 'acme-evals',
      version: '1.0.0',
      sha256: `sha256:${'a'.repeat(64)}`,
    };
    const second = {
      namespace: 'zeta-evals',
      version: '2.0.0',
      sha256: `sha256:${'b'.repeat(64)}`,
    };
    const result = resultFor([]);

    expect(() =>
      parseRunResult({
        ...result,
        forge: {...result.forge, action_bundles: []},
      }),
    ).toThrow();
    expect(() =>
      parseRunResult({
        ...result,
        forge: {...result.forge, action_bundles: [first, first]},
      }),
    ).toThrow(/unique/);
    expect(() =>
      parseRunResult({
        ...result,
        forge: {...result.forge, action_bundles: [second, first]},
      }),
    ).toThrow(/canonical namespace order/);
    expect(
      parseRunResult({
        ...result,
        forge: {...result.forge, action_bundles: [first, second]},
      }).forge.action_bundles,
    ).toEqual([first, second]);
  });

  it('rejects the removed aggregate artifact-set digest', () => {
    expect(() =>
      parseRunResult({
        ...resultFor([]),
        artifact_set_sha256: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow();
  });

  it('rejects contradictory result evidence provenance', () => {
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

    const missingSetup = await commitArtifacts(canonical, (result) => result, {
      includeSetup: false,
    });
    await expect(verifyCompletedRun(missingSetup)).rejects.toThrow(
      'missing canonical artifact setup.json',
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

  it('strictly verifies plugin resolutions against the completed plan', async () => {
    const pluginPlan = createTestResolvedRunPlan({
      caseId: 'sample/case',
      prompt: 'do it',
      treatment: 'stripe-plugin',
      treatmentSetup: [
        {
          uses: 'forge/plugin',
          with: {
            agents: {
              'claude-code': {
                plugin: 'stripe@claude-plugins-official',
                marketplace: 'anthropics/claude-plugins-official',
              },
            },
          },
        },
      ],
      agent: {adapter: 'claude-code', provider: 'anthropic', model: 'test'},
    });
    const receipt = {
      adapter: 'claude-code',
      plugin: 'stripe@claude-plugins-official',
      marketplace: 'anthropics/claude-plugins-official',
      native_plugin_id: 'stripe@forge-test',
      version: '0.9.2',
      source: {kind: 'git-subdir'},
    } as const;
    const core = [
      {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
      {path: 'trajectory.json', body: oneShotTrajectory},
    ];
    const setup = (resolution: unknown) =>
      jsonBody({
        schema_version: 1,
        steps: [{index: 0, uses: 'forge/plugin', resolution}],
      });

    const valid = await commitArtifacts(
      [...core, {path: 'setup.json', body: setup(receipt)}],
      (result) => result,
      {plan: pluginPlan},
    );
    await expect(verifyCompletedRun(valid)).resolves.toMatchObject({runId: 'run-1'});

    const malformed = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: setup({...receipt, installed_tree: {sha256: `sha256:${'a'.repeat(64)}`}}),
        },
      ],
      (result) => result,
      {plan: pluginPlan},
    );
    await expect(verifyCompletedRun(malformed)).rejects.toThrow(
      'invalid plugin installation resolution',
    );

    const mismatched = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: setup({...receipt, marketplace: 'stripe/other-marketplace'}),
        },
      ],
      (result) => result,
      {plan: pluginPlan},
    );
    await expect(verifyCompletedRun(mismatched)).rejects.toThrow(
      'does not match the completed run plan',
    );
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

  it('verifies complete Codex evidence with mapped tool categories and different protocol details', async () => {
    const location = await commitCodexEvidence(
      codexInteraction(),
      codexNativeSteps(),
    );
    await expect(verifyCompletedRun(location)).resolves.toMatchObject({
      runId: 'run-1',
    });
  });

  for (const [nativeName, liveName] of [
    ['mcp__my__server.probe', 'mcp__my__server__probe'],
    ['mcp__my__server__probe', 'mcp__my__server__probe'],
    ['mcp__my__server.probe.v1', 'mcp__my__server__probe.v1'],
  ] as const) {
    it(`verifies MCP server names containing __ in ${nativeName}`, async () => {
      const interaction: InteractionArtifactV1 = {
        ...oneShotInteraction,
        turns: [{
          ...oneShotInteraction.turns[0],
          tool_calls: [{name: liveName}],
        }],
      };
      const location = await commitCodexEvidence(interaction, [
        {step_id: 1, source: 'user', message: 'do it'},
        {
          step_id: 2, source: 'agent', message: 'done',
          tool_calls: [{tool_call_id: 'native-mcp', function_name: nativeName, arguments: {}}],
          observation: {results: [{source_call_id: 'native-mcp', content: 'success'}]},
        },
      ]);
      await expect(verifyCompletedRun(location)).resolves.toMatchObject({runId: 'run-1'});
    });
  }

  it('verifies complete Codex evidence for a genuinely tool-free turn', async () => {
    const location = await commitCodexEvidence(oneShotInteraction, [
      {step_id: 1, source: 'user', message: 'do it'},
      {step_id: 2, source: 'agent', message: 'different native response'},
    ]);
    await expect(verifyCompletedRun(location)).resolves.toMatchObject({
      runId: 'run-1',
    });
  });

  for (const missing of ['command pair', 'assistant text'] as const) {
    it(`rejects complete Codex evidence missing ${missing} even after rebinding hashes and judge projection`, async () => {
      const steps = codexNativeSteps();
      const location = await commitCodexEvidence(codexInteraction(), steps);
      await expect(verifyCompletedRun(location)).resolves.toMatchObject({
        runId: 'run-1',
      });

      // Removing a command's whole step drops both its call and output, leaving
      // valid ATIF. The unrelated tool_search remains, so raw total counts are
      // still sufficient; only the mapped command category exposes the loss.
      const tampered = steps
        .filter((step) => missing === 'command pair'
          ? !step.tool_calls?.some(({function_name}) =>
              function_name === 'functions.exec_command')
          : step.source !== 'agent' || step.message === '')
        .map((step, index) => ({...step, step_id: index + 1}));
      await rebindCodexEvidence(location, tampered);

      await expect(verifyCompletedRun(location)).rejects.toThrow(
        'trajectory.json does not cover every completed interaction turn.',
      );
    });
  }

  it('rejects a different Codex MCP server or tool despite matching call counts', async () => {
    for (const replacement of ['mcp__other.search', 'mcp__docs.fetch']) {
      const steps = codexNativeSteps().map((step) =>
        step.source !== 'agent' || step.tool_calls == null
          ? step
          : {
              ...step,
              tool_calls: step.tool_calls.map((call) => ({
                ...call,
                function_name: call.function_name === 'mcp__docs.search'
                  ? replacement
                  : call.function_name,
              })),
            },
      );
      const location = await commitCodexEvidence(codexInteraction(), steps);
      await expect(verifyCompletedRun(location)).rejects.toThrow(
        'trajectory.json does not cover every completed interaction turn.',
      );
    }
  });

  it('preserves bounded, lossy Codex driver fallback verification', async () => {
    const toolCalls = Array.from({length: 300}, (_, index) => ({
      id: `driver-call-${index}`,
      name: 'command_execution',
      input: {command: 'x'.repeat(300)},
    }));
    const interaction: InteractionArtifactV1 = {
      ...oneShotInteraction,
      turns: [{...oneShotInteraction.turns[0], tool_calls: toolCalls}],
    };
    const location = await commitCodexEvidence(interaction, [
      {step_id: 1, source: 'user', message: 'do it'},
      {
        step_id: 2,
        source: 'agent',
        message: 'done',
        tool_calls: toolCalls.slice(0, 256).map((call) => ({
          tool_call_id: call.id,
          function_name: call.name,
          arguments: {command: call.input.command.slice(0, 256)},
        })),
      },
    ], (result) => ({
      ...result,
      evidence: {
        ...result.evidence,
        provenance: {
          ...result.evidence.provenance,
          source: {
            kind: 'driver_fallback',
            format: 'forge-driver-turns',
            session_id: 'session',
          },
        },
        completeness: 'fallback',
        warnings: [
          {code: 'source_incomplete', message: 'Native tools were incomplete.'},
          {code: 'fallback_used', message: 'Using completed driver turns.'},
          {code: 'value_omitted', message: 'Tool details exceeded fallback bounds.'},
        ],
      },
    }));
    await expect(verifyCompletedRun(location)).resolves.toMatchObject({
      runId: 'run-1',
    });
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

  it('verifies judge evidence and its projection declaration', async () => {
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

  it('binds embedded judge steps to the trajectory even if artifact hashes are valid', async () => {
    const judgeEvidence = judgeEvidenceValue();
    const trajectory = trajectoryBody([
      {step_id: 1, source: 'user', message: 'do it'},
      {
        step_id: 2,
        source: 'agent',
        message: 'done',
        reasoning_content: 'private reasoning',
      },
    ]);
    const commitEvidence = (evidence: JudgeEvidenceV1) => commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: trajectory},
        {path: 'judge-evidence.json', body: jsonBody(evidence)},
      ],
      withPassingGuideline,
    );
    const validLocation = await commitEvidence(judgeEvidence);
    await expect(verifyCompletedRun(validLocation)).resolves.toMatchObject({
      runId: 'run-1',
    });

    const {steps: _steps, ...policyOnly} = judgeEvidence.transcript;
    const missingStepsLocation = await commitArtifacts(
      [
        {path: 'interaction.json', body: jsonBody(oneShotInteraction)},
        {path: 'trajectory.json', body: trajectory},
        {
          path: 'judge-evidence.json',
          body: jsonBody({...judgeEvidence, transcript: policyOnly}),
        },
      ],
      withPassingGuideline,
    );
    await expect(verifyCompletedRun(missingStepsLocation)).rejects.toThrow(
      'Completed judge-evidence.json does not match its schema.',
    );

    for (const steps of [
      [],
      judgeEvidence.transcript.steps.map((step) =>
        step.source === 'agent' ? {...step, message: 'invented answer'} : step,
      ),
    ]) {
      const location = await commitEvidence({
        ...judgeEvidence,
        transcript: {...judgeEvidence.transcript, steps},
      });
      await expect(verifyCompletedRun(location)).rejects.toThrow(
        'judge-evidence.json transcript steps do not match the projection of trajectory.json.',
      );
    }
  });
});

interface TestArtifact {
  readonly path: string;
  readonly body: Buffer;
}

function codexInteraction(): InteractionArtifactV1 {
  return {
    ...oneShotInteraction,
    turns: [{
      ...oneShotInteraction.turns[0],
      tool_calls: [
        {id: 'stream-command-1', name: 'command_execution', input: {command: 'pwd'}},
        {id: 'stream-command-2', name: 'command_execution', input: {command: 'pwd'}},
        {id: 'stream-file', name: 'file_change', input: {changes: [{path: 'a.txt', kind: 'add'}]}},
        {id: 'stream-plan', name: 'todo_list', input: {items: [{text: 'Finish', completed: true}]}},
        {id: 'stream-mcp', name: 'mcp__docs__search', input: {query: 'forge'}},
      ],
    }],
  };
}

function codexNativeSteps(): AtifStep[] {
  const tools = [
    {name: 'functions.exec_command', input: {cmd: 'pwd'}},
    {name: 'functions.write_stdin', input: {session_id: 1, chars: ''}},
    {name: 'functions.apply_patch', input: {input: '*** Begin Patch\n*** End Patch'}},
    {name: 'functions.update_plan', input: {plan: [{step: 'Finish', status: 'completed'}]}},
    {name: 'mcp__docs.search', input: {query: 'forge', limit: 1}},
    {name: 'tool_search', input: {query: 'docs search'}},
  ];
  return [
    {step_id: 1, source: 'user', message: 'do it'},
    ...tools.map((tool, index): AtifStep => ({
      step_id: index + 2,
      source: 'agent',
      message: '',
      tool_calls: [{
        tool_call_id: `native-call-${index}`,
        function_name: tool.name,
        arguments: tool.input,
      }],
      observation: {results: [{
        source_call_id: `native-call-${index}`,
        content: 'native tool output',
      }]},
    })),
    {step_id: tools.length + 2, source: 'agent', message: 'different native response'},
  ];
}

function codexEvidenceArtifacts(steps: readonly AtifStep[]): TestArtifact[] {
  const body = trajectoryBody(steps);
  const trajectory = parseAtifTrajectory(JSON.parse(body.toString('utf8')));
  const evidence = judgeEvidenceValue();
  return [
    {path: 'trajectory.json', body},
    {
      path: 'judge-evidence.json',
      body: jsonBody({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          steps: JSON.parse(createJudgeTranscriptProjection(trajectory).transcriptJson),
        },
      }),
    },
  ];
}

async function commitCodexEvidence(
  interaction: InteractionArtifactV1,
  steps: readonly AtifStep[],
  transform: (result: RunResultV1) => RunResultV1 = (result) => result,
): Promise<string> {
  const plan = createTestResolvedRunPlan({
    caseId: 'sample/case',
    prompt: 'do it',
    agent: {adapter: 'codex', provider: 'openai', model: 'test'},
    successGuidelines: ['The task is complete.'],
    judge: {provider: 'test-provider', model: 'judge-model'},
  });
  return commitArtifacts([
    {path: 'interaction.json', body: jsonBody(interaction)},
    ...codexEvidenceArtifacts(steps),
  ], (result) => transform({
    ...withPassingGuideline(result),
    agent: {...result.agent, adapter: 'codex'},
    evidence: {
      ...result.evidence,
      provenance: {
        source: {kind: 'native_log', format: 'codex-rollout-jsonl', session_id: 'session'},
        adapter: {id: 'codex', version: '1'},
      },
    },
  }), {plan});
}

async function rebindCodexEvidence(
  location: string,
  steps: readonly AtifStep[],
): Promise<void> {
  const artifacts = codexEvidenceArtifacts(steps);
  const resultPath = path.join(location, 'result.json');
  const result = parseRunResult(JSON.parse(await fs.readFile(resultPath, 'utf8')));
  await Promise.all(artifacts.map((artifact) =>
    fs.writeFile(path.join(location, artifact.path), artifact.body),
  ));
  await fs.writeFile(resultPath, jsonBody({
    ...result,
    artifacts: result.artifacts.map((descriptor) => {
      const artifact = artifacts.find(({path: artifactPath}) => artifactPath === descriptor.path);
      return artifact === undefined ? descriptor : descriptorFor(artifact.path, artifact.body);
    }),
  }));
}

async function commitArtifacts(
  artifacts: readonly TestArtifact[],
  transform: (result: RunResultV1) => RunResultV1 = (result) => result,
  options: {
    readonly includePlan?: boolean;
    readonly includeSetup?: boolean;
    readonly plan?: ResolvedRunPlanV1;
  } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
  roots.push(root);
  const transaction = await createArtifactStore({root}).begin('run-1');
  const plan =
    options.plan ?? testPlanForResult(transform(resultFor([])));
  const planBody = Buffer.from(serializeResolvedRunPlan(plan), 'utf8');
  const completeArtifacts = [...artifacts];
  if (
    options.includeSetup !== false &&
    !completeArtifacts.some(({path: artifactPath}) => artifactPath === 'setup.json')
  ) {
    completeArtifacts.unshift({path: 'setup.json', body: emptySetupBody(plan)});
  }
  if (
    options.includePlan !== false &&
    !completeArtifacts.some(({path: artifactPath}) => artifactPath === 'plan.json')
  ) {
    completeArtifacts.unshift({path: 'plan.json', body: planBody});
  }
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
      steps: [
        {step_id: 1, source: 'user', message: 'do it'},
        {step_id: 2, source: 'agent', message: 'done'},
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

function emptySetupBody(plan: ResolvedRunPlanV1): Buffer {
  return jsonBody({
    schema_version: 1,
    steps: plan.setup.map((step, index) => ({index, uses: step.uses})),
  });
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
    forge: {version: plan.provenance.forge.version},
    runtime: {
      adapter: 'forge/docker',
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
