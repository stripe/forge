import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { type AtifStep, parseAtifTrajectory } from '../atif/index.ts';
import { createJudgeTranscriptProjection } from '../evaluation/judgeTranscript.ts';
import { scoreEvaluation } from '../evaluation/score.ts';
import { sha256Digest } from '../model/hashes.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import { serializeResolvedRunPlan } from '../planning/index.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { FORGE_BUILD_IDENTITY, FORGE_VERSION } from '../version.ts';
import {
  createArtifactStore,
  RunIdConflictError,
  verifyCompletedRun,
} from './localStore.ts';
import { parseRunResult } from './parse.ts';
import type {
  ArtifactDescriptorV1,
  InteractionArtifactV1,
  JudgeEvidenceV1,
  RunResultV1,
} from './types.ts';

const roots: string[] = [];
const testPlan = createTestResolvedRunPlan({
  caseId: 'sample/case',
  prompt: 'do it',
  agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
});
const testPlanBody = Buffer.from(serializeResolvedRunPlan(testPlan), 'utf8');
const oneShotInteraction = {
  mode: 'one_shot',
  stop_reason: 'task_complete',
  turns: [{ turn: 1, user: 'do it', assistant: 'done', tool_calls: [] }],
  failure: null,
} as const;
const oneShotTrajectory = jsonBody({
  schema_version: 'ATIF-v1.8',
  session_id: 'session',
  agent: { name: 'test-agent', version: '1' },
  steps: [
    { step_id: 1, source: 'user', message: 'do it' },
    { step_id: 2, source: 'agent', message: 'done' },
  ],
});
const multiTurnInteraction = {
  mode: 'multi_turn',
  stop_reason: 'task_complete',
  turns: [
    {
      turn: 1,
      user: 'first prompt',
      assistant: 'first driver response',
      tool_calls: [
        { id: 'driver-call', name: 'Write', input: { path: 'a.txt' } },
      ],
    },
    {
      turn: 2,
      user: 'second prompt',
      assistant: 'second driver response',
      tool_calls: [],
    },
  ],
  role_player: {
    model: { provider: 'test-provider', model: 'test-role-player' },
    needs: [{ id: 'need_1', description: 'Complete the requested task.' }],
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
  mode: 'multi_turn',
  stop_reason: 'role_player_error',
  turns: [],
  role_player: {
    model: { provider: 'test-provider', model: 'test-role-player' },
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
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('local artifact store', () => {
  it('commits result.json last and verifies every claimed byte', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const store = createArtifactStore({ root });
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
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
    const committed = await transaction.commit(
      result as unknown as Readonly<Record<string, unknown>>,
    );
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    assert.equal(
      await fs.readFile(path.join(committed.location, 'result.json'), 'utf8'),
      serializeCanonicalJson(result),
    );
    await assert.rejects(
      transaction.commit(result as unknown as Record<string, unknown>),
      /Artifact transaction is closed\./,
    );
    await transaction.rollback();
    {
      const actual = await verifyCompletedRun(committed.location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
    await fs.writeFile(
      path.join(committed.location, 'result.json'),
      JSON.stringify({
        ...result,
        runtime: { ...result.runtime, adapter: 'docker' },
      }),
    );
    await assert.rejects(
      verifyCompletedRun(committed.location),
      /plan\.json runtime does not match/,
    );
  });

  it('rolls back staged bytes idempotently and permits reuse of the run ID', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const store = createArtifactStore({ root });
    const transaction = await store.begin('run-1');
    const artifact = {
      path: 'extensions/test/nested/report.txt',
      body: Buffer.from('staged'),
      mediaType: 'text/plain',
    };
    await transaction.write(artifact);
    assert.equal((await fs.readdir(path.join(root, '.staging'))).length, 1);
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);

    await transaction.rollback();
    await transaction.rollback();
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
    await assert.rejects(
      transaction.write(artifact),
      /Artifact transaction is closed\./,
    );
    await assert.rejects(
      transaction.commit(resultFor([]) as unknown as Record<string, unknown>),
      /Artifact transaction is closed\./,
    );
    await (await store.begin('run-1')).rollback();
  });

  it('preserves the winner when a second transaction commits the same run ID', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const store = createArtifactStore({ root });
    const winner = await store.begin('run-1');
    const loser = await store.begin('run-1');
    const value = resultFor([]) as unknown as Record<string, unknown>;
    const committed = await winner.commit(value);
    const winnerBytes = await fs.readFile(
      path.join(committed.location, 'result.json'),
    );

    await assert.rejects(loser.commit(value), {
      name: 'RunIdConflictError',
      runId: 'run-1',
      conflictCode: 'run_id_conflict',
    });
    await assert.rejects(store.begin('run-1'), RunIdConflictError);
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    assert.deepEqual(
      await fs.readFile(path.join(committed.location, 'result.json')),
      winnerBytes,
    );
    await assert.rejects(
      loser.commit(value),
      /Artifact transaction is closed\./,
    );
  });

  it('rejects a result for a different run without publishing staged bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const store = createArtifactStore({ root });
    const transaction = await store.begin('run-1');
    await transaction.write({
      path: 'plan.json',
      body: testPlanBody,
      mediaType: 'application/json',
    });
    await assert.rejects(
      transaction.commit({
        ...resultFor([descriptorFor('plan.json', testPlanBody)]),
        run_id: 'run-2',
      } as unknown as Record<string, unknown>),
      RunIdConflictError,
    );
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
    await (await store.begin('run-1')).rollback();
  });

  it('rejects traversal, reserved result bytes, and duplicate artifact writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const transaction = await createArtifactStore({ root }).begin('run-1');
    const artifact = {
      path: 'plan.json',
      body: testPlanBody,
      mediaType: 'application/json',
    };
    await assert.rejects(
      transaction.write({ ...artifact, path: '../outside.json' }),
      /Invalid artifact path: \.\.\/outside\.json/,
    );
    await assert.rejects(
      transaction.write({ ...artifact, path: 'result.json' }),
      /result\.json is reserved for atomic commit\./,
    );
    await transaction.write(artifact);
    await assert.rejects(
      transaction.write(artifact),
      /Duplicate artifact path: plan\.json/,
    );
    await transaction.rollback();
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
  });

  it('rejects duplicate descriptors that omit a staged artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const transaction = await createArtifactStore({ root }).begin('run-1');
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

    await assert.rejects(
      transaction.commit(
        resultFor(duplicated) as unknown as Readonly<Record<string, unknown>>,
      ),
      /Duplicate claimed artifact/,
    );
  });

  it('independently checks claimed digests against staged artifact inputs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const transaction = await createArtifactStore({ root }).begin('run-1');
    await transaction.write({
      path: 'plan.json',
      body: testPlanBody,
      mediaType: 'application/json',
    });
    const descriptor = {
      ...descriptorFor('plan.json', testPlanBody),
      sha256: `sha256:${'f'.repeat(64)}` as const,
    };
    await assert.rejects(
      transaction.commit(
        resultFor([descriptor]) as unknown as Record<string, unknown>,
      ),
      /Result descriptor mismatch: plan\.json/,
    );
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
    await assert.rejects(
      transaction.write({
        path: 'other.json',
        body: Buffer.from('{}'),
        mediaType: 'application/json',
      }),
      /Artifact transaction is closed\./,
    );
    await transaction.rollback();
    await (await createArtifactStore({ root }).begin('run-1')).rollback();
  });

  it('checks plan artifact bytes and canonicalization without a duplicate plan digest', async () => {
    const canonical = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const location = await commitArtifacts(canonical);
    {
      const actual = await verifyCompletedRun(location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
    const alteredPlan = testPlanBody
      .toString('utf8')
      .replace('"effective_prompt":"do it"', '"effective_prompt":"go it"');
    assert.equal(Buffer.byteLength(alteredPlan), testPlanBody.byteLength);
    assert.notEqual(alteredPlan, testPlanBody.toString('utf8'));
    await fs.writeFile(path.join(location, 'plan.json'), alteredPlan);
    await assert.rejects(
      verifyCompletedRun(location),
      /Artifact does not match its descriptor: plan\.json/,
    );

    const noncanonical = await commitArtifacts([
      ...canonical,
      {
        path: 'plan.json',
        body: Buffer.from(JSON.stringify(testPlan, null, 2)),
      },
    ]);
    await assert.rejects(
      verifyCompletedRun(noncanonical),
      /Completed plan\.json is not canonical\./,
    );
  });

  it('checks the result release before reading its companion artifacts', async () => {
    const location = await commitArtifacts([
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ]);
    const resultPath = path.join(location, 'result.json');
    const result = JSON.parse(
      await fs.readFile(resultPath, 'utf8'),
    ) as RunResultV1;
    await fs.writeFile(
      resultPath,
      jsonBody({ ...result, forge: { version: '99.0.0' } }),
    );
    await fs.unlink(path.join(location, 'trajectory.json'));
    await assert.rejects(
      verifyCompletedRun(location),
      /incompatible with installed Forge/,
    );
  });

  it('retains source provenance and exact action bundle matching under the reader release policy', async () => {
    const plan = {
      ...testPlan,
      provenance: {
        ...testPlan.provenance,
        forge: {
          version: FORGE_VERSION,
          commit_sha: 'a'.repeat(40),
          dirty: true,
        },
      },
    };
    const artifacts = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const producer = {
      version: FORGE_VERSION,
      commit_sha: 'b'.repeat(40),
      dirty: false,
    };
    const location = await commitArtifacts(
      artifacts,
      (result) => ({ ...result, forge: producer }),
      { plan },
    );
    assert.deepEqual(
      (await verifyCompletedRun(location)).result.forge,
      producer,
    );

    const developmentPlan = {
      ...plan,
      provenance: {
        ...plan.provenance,
        forge: { ...plan.provenance.forge, version: '0.0.0-dev.42' },
      },
    };
    const developmentLocation = await commitArtifacts(
      artifacts,
      (result) => ({ ...result, forge: producer }),
      { plan: developmentPlan },
    );
    if (FORGE_VERSION.includes('-dev.')) {
      assert.deepEqual(
        (await verifyCompletedRun(developmentLocation)).result.forge,
        producer,
      );
    } else {
      await assert.rejects(
        verifyCompletedRun(developmentLocation),
        /Completed plan\.json does not match its schema/,
      );
    }

    const mismatched = await commitArtifacts(
      artifacts,
      (result) => ({
        ...result,
        forge: {
          ...producer,
          action_bundles: [
            {
              namespace: 'acme-evals',
              version: '1.0.0',
              sha256: `sha256:${'a'.repeat(64)}`,
            },
          ],
        },
      }),
      { plan },
    );
    await assert.rejects(
      verifyCompletedRun(mismatched),
      /plan\.json does not match the completed result summary/,
    );
  });

  it('binds recorded labels and score inclusion to the plan even when altered totals are consistent', async () => {
    const criteria = [
      { value: 'The task is complete.', label: 'correctness' },
      { value: 'Read docs', label: 'source', include_in_score: false },
    ];
    const basePlan = testPlanForResult(withPassingCriterion(resultFor([])));
    const plan = {
      ...basePlan,
      case: { ...basePlan.case, judging_criteria: criteria },
      evaluation: { ...basePlan.evaluation, judging_criteria: criteria },
    };
    const location = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: oneShotTrajectory },
        { path: 'judge-evidence.json', body: judgeEvidenceBody() },
      ],
      (result) => ({
        ...result,
        evaluation: scoreEvaluation(
          [
            {
              criterion: 'The task is complete.',
              label: 'correctness',
              passed: true,
              explanation: '',
              include_in_score: true,
            },
            {
              criterion: 'Read docs',
              label: 'source',
              passed: false,
              explanation: '',
              include_in_score: false,
            },
          ],
          [],
        ),
      }),
      { plan },
    );
    const verified = await verifyCompletedRun(location);
    assert.equal(verified.result.evaluation.score, 1);
    for (const change of [
      { label: 'correctness' },
      { include_in_score: true },
    ]) {
      const result = structuredClone(verified.result);
      const changed = {
        ...result,
        evaluation: scoreEvaluation(
          result.evaluation.judging_criteria.map((entry, index) =>
            index === 1 ? { ...entry, ...change } : entry,
          ),
          [],
        ),
      };
      await fs.writeFile(path.join(location, 'result.json'), jsonBody(changed));
      await assert.rejects(
        verifyCompletedRun(location),
        /evaluation configuration does not match/,
      );
    }
  });

  it('rejects unclaimed files and symlinks even when the claimed artifact bytes match', async () => {
    const location = await commitArtifacts([
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ]);
    await fs.mkdir(path.join(location, 'extra'));
    await fs.writeFile(path.join(location, 'extra/unclaimed.txt'), 'unclaimed');
    await assert.rejects(
      verifyCompletedRun(location),
      /Completed run contains an unclaimed file\./,
    );
    await fs.rm(path.join(location, 'extra'), { recursive: true });

    await fs.symlink(
      path.join(location, 'plan.json'),
      path.join(location, 'unclaimed-link'),
    );
    await assert.rejects(
      verifyCompletedRun(location),
      /Completed run contains a symbolic link\./,
    );
    await fs.unlink(path.join(location, 'unclaimed-link'));

    const copy = path.join(path.dirname(location), 'trajectory-copy.json');
    await fs.writeFile(copy, oneShotTrajectory);
    await fs.unlink(path.join(location, 'trajectory.json'));
    await fs.symlink(copy, path.join(location, 'trajectory.json'));
    await assert.rejects(
      verifyCompletedRun(location),
      /Artifact is unsafe or exceeds its declared size\./,
    );
  });

  it('requires restricted classification and a single root native source', async () => {
    const native: TestArtifact = {
      path: 'native/claude-code/session.jsonl',
      body: Buffer.from('{"native":"exact source"}\n'),
      mediaType: 'application/x-ndjson',
      sensitivity: 'restricted',
    };
    const contribution: TestArtifact = {
      path: 'extensions/reporter/report.txt',
      body: Buffer.from('report'),
      mediaType: 'text/plain',
    };
    const core = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const classifySupplemental = (result: RunResultV1): RunResultV1 => ({
      ...result,
      artifacts: result.artifacts.filter(
        ({ path }) =>
          !path.startsWith('native/') && !path.startsWith('extensions/'),
      ),
      supplemental_artifacts: result.artifacts.filter(
        ({ path }) =>
          path.startsWith('native/') || path.startsWith('extensions/'),
      ),
    });
    const valid = await commitArtifacts(
      [...core, native, contribution],
      classifySupplemental,
    );
    {
      const actual = await verifyCompletedRun(valid);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
    assert.equal(
      (await fs.stat(path.join(valid, native.path))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await fs.stat(path.join(valid, contribution.path))).mode & 0o777,
      0o644,
    );

    // Rebind the result descriptor while leaving the exact source bytes and digest intact.
    const resultPath = path.join(valid, 'result.json');
    const result = parseRunResult(
      JSON.parse(await fs.readFile(resultPath, 'utf8')),
    );
    await fs.writeFile(
      resultPath,
      jsonBody({
        ...result,
        supplemental_artifacts: result.supplemental_artifacts.map(
          (descriptor) => {
            if (descriptor.path !== native.path) return descriptor;
            const { sensitivity: _sensitivity, ...unclassified } = descriptor;
            return unclassified;
          },
        ),
      }),
    );
    await assert.rejects(
      verifyCompletedRun(valid),
      /unsupported path or classification/,
    );

    const duplicateNative = await commitArtifacts(
      [...core, native, { ...native, path: 'native/claude-code/session.log' }],
      classifySupplemental,
    );
    await assert.rejects(
      verifyCompletedRun(duplicateNative),
      /more than one root native artifact/,
    );
  });

  it('strictly verifies workspace evidence schema and removed fields', async () => {
    const canonical = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const entry = {
      path: 'answer.txt',
      exists: true,
      kind: 'file',
      size_bytes: 4,
      content_base64: Buffer.from('done').toString('base64'),
    };
    const workspace = { entries: [entry], complete: true, warnings: [] };
    const valid = await commitArtifacts(
      [
        ...canonical,
        { path: 'workspace-evidence.json', body: jsonBody(workspace) },
      ],
      withPassingWorkspaceCheck,
    );
    {
      const actual = await verifyCompletedRun(valid);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
    for (const invalidWorkspace of [
      { ...workspace, schema_version: 2 },
      {
        ...workspace,
        entries: [{ ...entry, sha256: `sha256:${'a'.repeat(64)}` }],
      },
    ]) {
      const invalid = await commitArtifacts(
        [
          ...canonical,
          { path: 'workspace-evidence.json', body: jsonBody(invalidWorkspace) },
        ],
        withPassingWorkspaceCheck,
      );
      await assert.rejects(
        verifyCompletedRun(invalid),
        /Completed workspace-evidence\.json does not match its schema\./,
      );
    }
    await fs.writeFile(
      path.join(valid, 'workspace-evidence.json'),
      jsonBody({
        ...workspace,
        entries: [
          { ...entry, content_base64: Buffer.from('fail').toString('base64') },
        ],
      }),
    );
    await assert.rejects(
      verifyCompletedRun(valid),
      /Artifact does not match its descriptor: workspace-evidence\.json/,
    );
  });

  it('rejects result evidence without provenance', () => {
    const result = resultFor([]);
    const evidenceWithoutProvenance: Record<string, unknown> = {
      ...result.evidence,
    };
    delete evidenceWithoutProvenance.provenance;

    assert.throws(() =>
      parseRunResult({ ...result, evidence: evidenceWithoutProvenance }),
    );
  });

  it('rejects removed result schema counters', () => {
    assert.throws(() =>
      parseRunResult({ ...resultFor([]), schema_version: 2 }),
    );
    assert.throws(() =>
      parseRunResult({ ...resultFor([]), schema_version: 1 }),
    );
  });

  it('checks the producer release before interpreting the result payload', () => {
    assert.throws(
      () => parseRunResult({ forge: { version: '99.0.0' } }),
      /incompatible with installed Forge/,
    );
    const result = resultFor([]);
    for (const invalidIdentity of [
      { version: FORGE_VERSION, commit_sha: 'abc' },
      { version: FORGE_VERSION, dirty: 'true' },
      { version: FORGE_VERSION, unknown: true },
      { version: `${FORGE_VERSION}\n` },
    ]) {
      assert.throws(() =>
        parseRunResult({ ...result, forge: invalidIdentity }),
      );
    }
    const identity = {
      version: FORGE_VERSION,
      commit_sha: 'a'.repeat(40),
      dirty: true,
    };
    const parsed = parseRunResult({ ...result, forge: identity });
    identity.commit_sha = 'b'.repeat(40);
    identity.dirty = false;
    assert.deepEqual(parsed.forge, {
      version: FORGE_VERSION,
      commit_sha: 'a'.repeat(40),
      dirty: true,
    });
  });

  it('uses the result schema for evaluation and rejects a nested version', () => {
    const result = resultFor([]);
    assert.deepEqual(parseRunResult(result).evaluation, result.evaluation);
    assert.throws(() =>
      parseRunResult({
        ...result,
        evaluation: { ...result.evaluation, schema_version: 1 },
      }),
    );
  });

  it('strictly parses configuration metadata and rejects removed normalization counters', () => {
    const result = resultFor([]);
    const metadata = { endpoint_mode: 'custom', layout_mode: 'default' };
    const providerMetadata = { endpoint_mode: 'custom' };
    const call = {
      sequence: 1,
      purpose: 'judge',
      provider: 'test-provider',
      provider_version: '3.4.1',
      model: 'judge-model',
      status: 'succeeded',
      stop_reason: 'end_turn',
      input_tokens: 10,
      output_tokens: 2,
      cached_tokens: null,
      cost_usd: null,
      error_code: null,
      provider_metadata: providerMetadata,
    };
    const parsed = parseRunResult({
      ...result,
      agent: { ...result.agent, metadata },
      completion_calls: [call],
    });
    metadata.endpoint_mode = 'default';
    providerMetadata.endpoint_mode = 'default';
    assert.deepEqual(parsed.agent.metadata, {
      endpoint_mode: 'custom',
      layout_mode: 'default',
    });
    assert.deepEqual(parsed.completion_calls[0]!.provider_metadata, {
      endpoint_mode: 'custom',
    });
    assert.equal(parsed.completion_calls[0]!.provider_version, '3.4.1');
    assert.throws(() =>
      parseRunResult({
        ...result,
        evidence: { ...result.evidence, normalization_version: 1 },
      }),
    );
    for (const invalid of [
      null,
      { endpoint_mode: 'unknown' },
      { endpoint_mode: 'custom', layout_mode: 'default', endpoint: 'private' },
    ]) {
      assert.throws(() =>
        parseRunResult({
          ...result,
          agent: { ...result.agent, metadata: invalid },
        }),
      );
      assert.throws(() =>
        parseRunResult({
          ...result,
          completion_calls: [{ ...call, provider_metadata: invalid }],
        }),
      );
    }
  });

  it('requires ordered completion-call summaries with matching status and error codes', () => {
    const call = {
      sequence: 1,
      purpose: 'judge',
      provider: 'test-provider',
      provider_version: '1',
      model: 'judge-model',
      status: 'succeeded',
      stop_reason: 'end_turn',
      input_tokens: 10,
      output_tokens: 2,
      cached_tokens: null,
      cost_usd: null,
      error_code: null,
    } as const;
    const result = resultFor([]);
    const calls = [
      call,
      {
        ...call,
        sequence: 2,
        status: 'failed',
        stop_reason: null,
        error_code: 'request_error',
      },
    ];
    assert.deepEqual(
      parseRunResult({ ...result, completion_calls: calls }).completion_calls,
      calls,
    );
    assert.throws(
      () =>
        parseRunResult({
          ...result,
          completion_calls: [{ ...call, sequence: 2 }],
        }),
      /Completion-call sequence must be contiguous and one-based\./,
    );
    assert.throws(
      () =>
        parseRunResult({
          ...result,
          completion_calls: [{ ...call, error_code: 'request_error' }],
        }),
      /Successful completion calls cannot record an error code\./,
    );
    assert.throws(
      () =>
        parseRunResult({
          ...result,
          completion_calls: [{ ...call, status: 'failed' }],
        }),
      /Failed completion calls require an error code\./,
    );
  });

  it('rejects removed root and runtime fields in strict result objects', () => {
    const result = resultFor([]);
    assert.throws(() =>
      parseRunResult({
        ...result,
        plan_sha256: `sha256:${'a'.repeat(64)}`,
      }),
    );
    assert.throws(() =>
      parseRunResult({
        ...result,
        artifact_set_sha256: `sha256:${'a'.repeat(64)}`,
      }),
    );
    assert.throws(() =>
      parseRunResult({
        ...result,
        runtime: { ...result.runtime, adapter_version: '1' },
      }),
    );
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

    assert.throws(() =>
      parseRunResult({
        ...result,
        forge: { ...result.forge, action_bundles: [] },
      }),
    );
    assert.throws(
      () =>
        parseRunResult({
          ...result,
          forge: { ...result.forge, action_bundles: [first, first] },
        }),
      /unique/,
    );
    assert.throws(
      () =>
        parseRunResult({
          ...result,
          forge: { ...result.forge, action_bundles: [second, first] },
        }),
      /canonical namespace order/,
    );
    assert.deepEqual(
      parseRunResult({
        ...result,
        forge: { ...result.forge, action_bundles: [first, second] },
      }).forge.action_bundles,
      [first, second],
    );
  });

  it('rejects contradictory result evidence provenance', () => {
    const result = resultFor([]);
    assert.throws(
      () =>
        parseRunResult({
          ...result,
          evidence: {
            ...result.evidence,
            provenance: {
              ...result.evidence.provenance,
              adapter: { id: 'other-agent', version: '1' },
            },
          },
        }),
      /Evidence provenance does not match the recorded agent adapter/,
    );
  });

  it('requires the exact canonical core artifact inventory', async () => {
    const canonical = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const missingPlan = await commitArtifacts(canonical, (result) => result, {
      includePlan: false,
    });
    await assert.rejects(
      verifyCompletedRun(missingPlan),
      /missing canonical artifact plan\.json/,
    );

    const missingSetup = await commitArtifacts(canonical, (result) => result, {
      includeSetup: false,
    });
    await assert.rejects(
      verifyCompletedRun(missingSetup),
      /missing canonical artifact setup\.json/,
    );

    const legacyEvaluation = await commitArtifacts([
      ...canonical,
      { path: 'evaluation.json', body: jsonBody({ schema_version: 1 }) },
    ]);
    await assert.rejects(
      verifyCompletedRun(legacyEvaluation),
      /noncanonical core artifact evaluation\.json/,
    );

    const unexpectedWorkspace = await commitArtifacts([
      ...canonical,
      { path: 'workspace-evidence.json', body: emptyWorkspaceEvidenceBody() },
    ]);
    await assert.rejects(
      verifyCompletedRun(unexpectedWorkspace),
      /noncanonical core artifact workspace-evidence\.json/,
    );

    const missingWorkspace = await commitArtifacts(
      canonical,
      withPassingWorkspaceCheck,
    );
    await assert.rejects(
      verifyCompletedRun(missingWorkspace),
      /missing canonical artifact workspace-evidence\.json/,
    );

    const checkedRun = await commitArtifacts(
      [
        ...canonical,
        { path: 'workspace-evidence.json', body: emptyWorkspaceEvidenceBody() },
      ],
      withPassingWorkspaceCheck,
    );
    {
      const actual = await verifyCompletedRun(checkedRun);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
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
      agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
    });
    const receipt = {
      adapter: 'claude-code',
      plugin: 'stripe@claude-plugins-official',
      marketplace: 'anthropics/claude-plugins-official',
      marketplace_commit: 'a'.repeat(40),
      native_plugin_id: 'stripe@forge-test',
      version: '0.9.2',
      source: { kind: 'git-subdir', commit: 'b'.repeat(40) },
      installed_tree: {
        format: 'forge-plugin-tree-v1',
        sha256: `sha256:${'c'.repeat(64)}`,
        entry_count: 2,
        file_count: 1,
        size_bytes: 42,
      },
    } as const;
    const core = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const setup = (resolution: unknown) =>
      jsonBody({
        steps: [{ index: 0, uses: 'forge/plugin', resolution }],
      });

    const valid = await commitArtifacts(
      [...core, { path: 'setup.json', body: setup(receipt) }],
      (result) => result,
      { plan: pluginPlan },
    );
    {
      const actual = await verifyCompletedRun(valid);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }

    const refPlan = createTestResolvedRunPlan({
      caseId: 'sample/case',
      prompt: 'do it',
      treatment: 'stripe-plugin',
      treatmentSetup: [
        {
          uses: 'forge/plugin',
          with: {
            agents: {
              'claude-code': {
                plugin: receipt.plugin,
                marketplace: receipt.marketplace,
                ref: 'main',
              },
            },
          },
        },
      ],
      agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
    });
    const withRef = await commitArtifacts(
      [
        ...core,
        { path: 'setup.json', body: setup({ ...receipt, ref: 'main' }) },
      ],
      (result) => result,
      { plan: refPlan },
    );
    assert.ok(await verifyCompletedRun(withRef));

    const missingRef = await commitArtifacts(
      [...core, { path: 'setup.json', body: setup(receipt) }],
      (result) => result,
      { plan: refPlan },
    );
    await assert.rejects(
      verifyCompletedRun(missingRef),
      /does not match the completed run plan/,
    );

    const missingResolution = await commitArtifacts(core, (result) => result, {
      plan: pluginPlan,
    });
    await assert.rejects(
      verifyCompletedRun(missingResolution),
      /omitted a plugin installation resolution/,
    );

    const malformed = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: setup({
            ...receipt,
            installed_tree: { sha256: `sha256:${'a'.repeat(64)}` },
          }),
        },
      ],
      (result) => result,
      { plan: pluginPlan },
    );
    await assert.rejects(
      verifyCompletedRun(malformed),
      /invalid plugin installation resolution/,
    );

    const mismatched = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: setup({ ...receipt, marketplace: 'stripe/other-marketplace' }),
        },
      ],
      (result) => result,
      { plan: pluginPlan },
    );
    await assert.rejects(
      verifyCompletedRun(mismatched),
      /does not match the completed run plan/,
    );
  });

  it('binds canonical setup receipts to the plan and disallows static resolutions', async () => {
    const plan = createTestResolvedRunPlan({
      caseId: 'sample/case',
      prompt: 'do it',
      agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
      caseSetup: [
        {
          uses: 'forge/write',
          with: { target: 'answer.txt', source: { content: 'initial' } },
        },
      ],
    });
    const core = [
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: oneShotTrajectory },
    ];
    const setup = { steps: [{ index: 0, uses: 'forge/write' }] };
    const valid = await commitArtifacts(core, (result) => result, { plan });
    {
      const actual = await verifyCompletedRun(valid);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }

    const noncanonical = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: Buffer.from(JSON.stringify(setup, null, 2)),
        },
      ],
      (result) => result,
      { plan },
    );
    await assert.rejects(
      verifyCompletedRun(noncanonical),
      /Completed setup\.json is not canonical\./,
    );

    const mismatched = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: jsonBody({ steps: [{ index: 0, uses: 'forge/command' }] }),
        },
      ],
      (result) => result,
      { plan },
    );
    await assert.rejects(
      verifyCompletedRun(mismatched),
      /setup\.json does not match the completed run plan\./,
    );

    const inventedResolution = await commitArtifacts(
      [
        ...core,
        {
          path: 'setup.json',
          body: jsonBody({
            steps: [
              {
                index: 0,
                uses: 'forge/write',
                resolution: { path: 'elsewhere' },
              },
            ],
          }),
        },
      ],
      (result) => result,
      { plan },
    );
    await assert.rejects(
      verifyCompletedRun(inventedResolution),
      /Static setup action forge\/write cannot record a resolution\./,
    );
  });

  it('strictly parses interaction.json and verifies its result summary', async () => {
    const missingLocation = await commitArtifacts([]);
    await assert.rejects(
      verifyCompletedRun(missingLocation),
      /missing canonical artifact interaction\.json/,
    );

    const invalidLocation = await commitArtifacts([
      {
        path: 'interaction.json',
        body: jsonBody({ ...oneShotInteraction, undeclared: true }),
      },
    ]);
    await assert.rejects(
      verifyCompletedRun(invalidLocation),
      /Completed interaction\.json does not match its schema\./,
    );

    const mismatchedLocation = await commitArtifacts(
      [{ path: 'interaction.json', body: jsonBody(oneShotInteraction) }],
      (result) => ({
        ...result,
        interaction: { ...result.interaction, turn_count: 2 },
      }),
    );
    await assert.rejects(
      verifyCompletedRun(mismatchedLocation),
      /interaction\.json does not match the completed result summary\./,
    );
  });

  it('always requires a valid trajectory with the completed session identity', async () => {
    const missingLocation = await commitArtifacts([
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
    ]);
    await assert.rejects(
      verifyCompletedRun(missingLocation),
      /missing canonical artifact trajectory\.json/,
    );

    const invalidLocation = await commitArtifacts([
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      {
        path: 'trajectory.json',
        body: jsonBody({
          schema_version: 'ATIF-v1.8',
          session_id: 'session',
          agent: { name: 'test-agent', version: '1' },
          steps: [{ step_id: 1, source: 'unknown', message: 'do it' }],
        }),
      },
    ]);
    await assert.rejects(
      verifyCompletedRun(invalidLocation),
      /Completed trajectory\.json does not match its schema\./,
    );

    const mismatchedSessionLocation = await commitArtifacts([
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      {
        path: 'trajectory.json',
        body: trajectoryBody(
          [
            { step_id: 1, source: 'user', message: 'do it' },
            { step_id: 2, source: 'agent', message: 'done' },
          ],
          'other-session',
        ),
      },
    ]);
    await assert.rejects(
      verifyCompletedRun(mismatchedSessionLocation),
      /trajectory\.json session identity does not match the completed run\./,
    );
  });

  it('accepts projection differences while requiring every ordered prompt and response', async () => {
    const compatibleTrajectory = trajectoryBody([
      { step_id: 1, source: 'user', message: 'first prompt' },
      {
        step_id: 2,
        source: 'agent',
        message: '',
        tool_calls: [
          {
            tool_call_id: 'native-call',
            function_name: 'DifferentNativeTool',
            arguments: { different: true },
          },
        ],
      },
      { step_id: 3, source: 'user', message: 'second prompt' },
      { step_id: 4, source: 'agent', message: 'different native response' },
    ]);
    const compatibleLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(multiTurnInteraction) },
        { path: 'trajectory.json', body: compatibleTrajectory },
      ],
      withMultiTurnSummary,
    );
    {
      const actual = await verifyCompletedRun(compatibleLocation);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }

    const incompatibleSteps = [
      [
        { step_id: 1, source: 'user', message: 'first prompt' },
        { step_id: 2, source: 'agent', message: 'only the first response' },
      ],
      [
        { step_id: 1, source: 'user', message: 'first prompt' },
        { step_id: 2, source: 'agent', message: 'first response' },
        { step_id: 3, source: 'user', message: 'second prompt' },
        { step_id: 4, source: 'agent', message: 'second response' },
        { step_id: 5, source: 'user', message: 'unexpected third prompt' },
        { step_id: 6, source: 'agent', message: 'third response' },
      ],
      [
        { step_id: 1, source: 'user', message: 'second prompt' },
        { step_id: 2, source: 'agent', message: 'second response' },
        { step_id: 3, source: 'user', message: 'first prompt' },
        { step_id: 4, source: 'agent', message: 'first response' },
      ],
      [
        { step_id: 1, source: 'user', message: 'first prompt' },
        { step_id: 2, source: 'agent', message: '' },
        { step_id: 3, source: 'user', message: 'second prompt' },
        { step_id: 4, source: 'agent', message: 'second response' },
      ],
      [
        { step_id: 1, source: 'user', message: 'first prompt' },
        {
          step_id: 2,
          source: 'agent',
          message: [{ type: 'text', text: '' }],
        },
        { step_id: 3, source: 'user', message: 'second prompt' },
        { step_id: 4, source: 'agent', message: 'second response' },
      ],
    ];
    for (const steps of incompatibleSteps) {
      const location = await commitArtifacts(
        [
          { path: 'interaction.json', body: jsonBody(multiTurnInteraction) },
          { path: 'trajectory.json', body: trajectoryBody(steps) },
        ],
        withMultiTurnSummary,
      );
      await assert.rejects(
        verifyCompletedRun(location),
        /trajectory\.json does not cover every completed interaction turn\./,
      );
    }
  });

  it('verifies complete Codex evidence with mapped tool categories and different protocol details', async () => {
    const location = await commitCodexEvidence(
      codexInteraction(),
      codexNativeSteps(),
    );
    {
      const actual = await verifyCompletedRun(location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
  });

  for (const [nativeName, liveName] of [
    ['mcp__my__server.probe', 'mcp__my__server__probe'],
    ['mcp__my__server__probe', 'mcp__my__server__probe'],
    ['mcp__my__server.probe.v1', 'mcp__my__server__probe.v1'],
  ] as const) {
    it(`verifies MCP server names containing __ in ${nativeName}`, async () => {
      const interaction: InteractionArtifactV1 = {
        ...oneShotInteraction,
        turns: [
          {
            ...oneShotInteraction.turns[0],
            tool_calls: [{ name: liveName }],
          },
        ],
      };
      const location = await commitCodexEvidence(interaction, [
        { step_id: 1, source: 'user', message: 'do it' },
        {
          step_id: 2,
          source: 'agent',
          message: 'done',
          tool_calls: [
            {
              tool_call_id: 'native-mcp',
              function_name: nativeName,
              arguments: {},
            },
          ],
          observation: {
            results: [{ source_call_id: 'native-mcp', content: 'success' }],
          },
        },
      ]);
      {
        const actual = await verifyCompletedRun(location);
        assert.ok(actual);
        assert.equal(actual.runId, 'run-1');
      }
    });
  }

  it('verifies complete Codex evidence for a genuinely tool-free turn', async () => {
    const location = await commitCodexEvidence(oneShotInteraction, [
      { step_id: 1, source: 'user', message: 'do it' },
      { step_id: 2, source: 'agent', message: 'different native response' },
    ]);
    {
      const actual = await verifyCompletedRun(location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
  });

  for (const missing of ['command pair', 'assistant text'] as const) {
    it(`rejects complete Codex evidence missing ${missing} even after rebinding hashes and judge projection`, async () => {
      const steps = codexNativeSteps();
      const location = await commitCodexEvidence(codexInteraction(), steps);
      {
        const actual = await verifyCompletedRun(location);
        assert.ok(actual);
        assert.equal(actual.runId, 'run-1');
      }

      // Removing a command's whole step drops both its call and output, leaving
      // valid ATIF. The unrelated tool_search remains, so raw total counts are
      // still sufficient; only the mapped command category exposes the loss.
      const tampered = steps
        .filter((step) =>
          missing === 'command pair'
            ? !step.tool_calls?.some(
                ({ function_name }) =>
                  function_name === 'functions.exec_command',
              )
            : step.source !== 'agent' || step.message === '',
        )
        .map((step, index) => ({ ...step, step_id: index + 1 }));
      await rebindCodexEvidence(location, tampered);

      await assert.rejects(
        verifyCompletedRun(location),
        /trajectory\.json does not cover every completed interaction turn\./,
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
                function_name:
                  call.function_name === 'mcp__docs.search'
                    ? replacement
                    : call.function_name,
              })),
            },
      );
      const location = await commitCodexEvidence(codexInteraction(), steps);
      await assert.rejects(
        verifyCompletedRun(location),
        /trajectory\.json does not cover every completed interaction turn\./,
      );
    }
  });

  it('preserves bounded, lossy Codex driver fallback verification', async () => {
    const toolCalls = Array.from({ length: 300 }, (_, index) => ({
      id: `driver-call-${index}`,
      name: 'command_execution',
      input: { command: 'x'.repeat(300) },
    }));
    const interaction: InteractionArtifactV1 = {
      ...oneShotInteraction,
      turns: [{ ...oneShotInteraction.turns[0], tool_calls: toolCalls }],
    };
    const location = await commitCodexEvidence(
      interaction,
      [
        { step_id: 1, source: 'user', message: 'do it' },
        {
          step_id: 2,
          source: 'agent',
          message: 'done',
          tool_calls: toolCalls.slice(0, 256).map((call) => ({
            tool_call_id: call.id,
            function_name: call.name,
            arguments: { command: call.input.command.slice(0, 256) },
          })),
        },
      ],
      (result) => ({
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
            {
              code: 'source_incomplete',
              message: 'Native tools were incomplete.',
            },
            { code: 'fallback_used', message: 'Using completed driver turns.' },
            {
              code: 'value_omitted',
              message: 'Tool details exceeded fallback bounds.',
            },
          ],
        },
      }),
    );
    {
      const actual = await verifyCompletedRun(location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }
  });

  it('accepts only the system fallback for a zero-turn role-player failure', async () => {
    const systemTrajectory = jsonBody({
      schema_version: 'ATIF-v1.8',
      agent: { name: 'test-agent', version: '1' },
      steps: [
        {
          step_id: 1,
          source: 'system',
          message:
            'The role player failed before the coding agent was invoked.',
        },
      ],
    });
    const validLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(zeroTurnInteraction) },
        { path: 'trajectory.json', body: systemTrajectory },
      ],
      withZeroTurnRolePlayerFailure,
    );
    {
      const actual = await verifyCompletedRun(validLocation);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }

    const invalidLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(zeroTurnInteraction) },
        {
          path: 'trajectory.json',
          body: jsonBody({
            schema_version: 'ATIF-v1.8',
            agent: { name: 'test-agent', version: '1' },
            steps: [{ step_id: 1, source: 'user', message: 'unsent prompt' }],
          }),
        },
      ],
      withZeroTurnRolePlayerFailure,
    );
    await assert.rejects(
      verifyCompletedRun(invalidLocation),
      /Zero-turn interaction requires the system-only role-player-error trajectory\./,
    );
  });

  it('requires judge evidence exactly when criteria were judged', async () => {
    const missingLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: oneShotTrajectory },
      ],
      withPassingCriterion,
    );
    await assert.rejects(
      verifyCompletedRun(missingLocation),
      /missing judge-evidence\.json/,
    );

    const trajectory = oneShotTrajectory;
    const unexpectedLocation = await commitArtifacts([
      { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
      { path: 'trajectory.json', body: trajectory },
      { path: 'judge-evidence.json', body: judgeEvidenceBody() },
    ]);
    await assert.rejects(
      verifyCompletedRun(unexpectedLocation),
      /without judged criteria contains judge-evidence\.json/,
    );
  });

  it('verifies judge evidence and its projection declaration', async () => {
    const trajectory = trajectoryBody([
      { step_id: 1, source: 'user', message: 'do it' },
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
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: trajectory },
        { path: 'judge-evidence.json', body: jsonBody(validJudgeEvidence) },
      ],
      withPassingCriterion,
    );
    {
      const actual = await verifyCompletedRun(validLocation);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }

    const unexpectedPromptVersionLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: trajectory },
        {
          path: 'judge-evidence.json',
          body: jsonBody({
            ...validJudgeEvidence,
            prompt_version: 'unsupported',
          }),
        },
      ],
      withPassingCriterion,
    );
    await assert.rejects(
      verifyCompletedRun(unexpectedPromptVersionLocation),
      /Completed judge-evidence\.json does not match its schema\./,
    );

    const unsupportedProjectionLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: trajectory },
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
      withPassingCriterion,
    );
    await assert.rejects(
      verifyCompletedRun(unsupportedProjectionLocation),
      /Completed judge-evidence\.json does not match its schema\./,
    );

    const invalidLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: trajectory },
        {
          path: 'judge-evidence.json',
          body: jsonBody({
            ...validJudgeEvidence,
            undeclared: true,
          }),
        },
      ],
      withPassingCriterion,
    );
    await assert.rejects(
      verifyCompletedRun(invalidLocation),
      /Completed judge-evidence\.json does not match its schema\./,
    );
  });

  it('binds embedded judge steps to the trajectory even if artifact hashes are valid', async () => {
    const judgeEvidence = judgeEvidenceValue();
    const trajectory = trajectoryBody([
      { step_id: 1, source: 'user', message: 'do it' },
      {
        step_id: 2,
        source: 'agent',
        message: 'done',
        reasoning_content: 'private reasoning',
      },
    ]);
    const commitEvidence = (evidence: JudgeEvidenceV1) =>
      commitArtifacts(
        [
          { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
          { path: 'trajectory.json', body: trajectory },
          { path: 'judge-evidence.json', body: jsonBody(evidence) },
        ],
        withPassingCriterion,
      );
    const validLocation = await commitEvidence(judgeEvidence);
    {
      const actual = await verifyCompletedRun(validLocation);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-1');
    }

    const { steps: _steps, ...policyOnly } = judgeEvidence.transcript;
    const missingStepsLocation = await commitArtifacts(
      [
        { path: 'interaction.json', body: jsonBody(oneShotInteraction) },
        { path: 'trajectory.json', body: trajectory },
        {
          path: 'judge-evidence.json',
          body: jsonBody({ ...judgeEvidence, transcript: policyOnly }),
        },
      ],
      withPassingCriterion,
    );
    await assert.rejects(
      verifyCompletedRun(missingStepsLocation),
      /Completed judge-evidence\.json does not match its schema\./,
    );

    for (const steps of [
      [],
      judgeEvidence.transcript.steps.map((step) =>
        step.source === 'agent'
          ? { ...step, message: 'invented answer' }
          : step,
      ),
    ]) {
      const location = await commitEvidence({
        ...judgeEvidence,
        transcript: { ...judgeEvidence.transcript, steps },
      });
      await assert.rejects(
        verifyCompletedRun(location),
        /judge-evidence\.json transcript steps do not match the projection of trajectory\.json\./,
      );
    }
  });
});

interface TestArtifact {
  readonly path: string;
  readonly body: Buffer;
  readonly mediaType?: string;
  readonly sensitivity?: 'restricted';
}

function codexInteraction(): InteractionArtifactV1 {
  return {
    ...oneShotInteraction,
    turns: [
      {
        ...oneShotInteraction.turns[0],
        tool_calls: [
          {
            id: 'stream-command-1',
            name: 'command_execution',
            input: { command: 'pwd' },
          },
          {
            id: 'stream-command-2',
            name: 'command_execution',
            input: { command: 'pwd' },
          },
          {
            id: 'stream-file',
            name: 'file_change',
            input: { changes: [{ path: 'a.txt', kind: 'add' }] },
          },
          {
            id: 'stream-plan',
            name: 'todo_list',
            input: { items: [{ text: 'Finish', completed: true }] },
          },
          {
            id: 'stream-mcp',
            name: 'mcp__docs__search',
            input: { query: 'forge' },
          },
        ],
      },
    ],
  };
}

function codexNativeSteps(): AtifStep[] {
  const tools = [
    { name: 'functions.exec_command', input: { cmd: 'pwd' } },
    { name: 'functions.write_stdin', input: { session_id: 1, chars: '' } },
    {
      name: 'functions.apply_patch',
      input: { input: '*** Begin Patch\n*** End Patch' },
    },
    {
      name: 'functions.update_plan',
      input: { plan: [{ step: 'Finish', status: 'completed' }] },
    },
    { name: 'mcp__docs.search', input: { query: 'forge', limit: 1 } },
    { name: 'tool_search', input: { query: 'docs search' } },
  ];
  return [
    { step_id: 1, source: 'user', message: 'do it' },
    ...tools.map(
      (tool, index): AtifStep => ({
        step_id: index + 2,
        source: 'agent',
        message: '',
        tool_calls: [
          {
            tool_call_id: `native-call-${index}`,
            function_name: tool.name,
            arguments: tool.input,
          },
        ],
        observation: {
          results: [
            {
              source_call_id: `native-call-${index}`,
              content: 'native tool output',
            },
          ],
        },
      }),
    ),
    {
      step_id: tools.length + 2,
      source: 'agent',
      message: 'different native response',
    },
  ];
}

function codexEvidenceArtifacts(steps: readonly AtifStep[]): TestArtifact[] {
  const body = trajectoryBody(steps);
  const trajectory = parseAtifTrajectory(JSON.parse(body.toString('utf8')));
  const evidence = judgeEvidenceValue();
  return [
    { path: 'trajectory.json', body },
    {
      path: 'judge-evidence.json',
      body: jsonBody({
        ...evidence,
        transcript: {
          ...evidence.transcript,
          steps: JSON.parse(
            createJudgeTranscriptProjection(trajectory).transcriptJson,
          ),
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
    agent: { adapter: 'codex', provider: 'openai', model: 'test' },
    judgingCriteria: ['The task is complete.'],
    judge: { provider: 'test-provider', model: 'judge-model' },
  });
  return commitArtifacts(
    [
      { path: 'interaction.json', body: jsonBody(interaction) },
      ...codexEvidenceArtifacts(steps),
    ],
    (result) =>
      transform({
        ...withPassingCriterion(result),
        agent: { ...result.agent, adapter: 'codex' },
        evidence: {
          ...result.evidence,
          provenance: {
            source: {
              kind: 'native_log',
              format: 'codex-rollout-jsonl',
              session_id: 'session',
            },
            adapter: { id: 'codex', version: '1' },
          },
        },
      }),
    { plan },
  );
}

async function rebindCodexEvidence(
  location: string,
  steps: readonly AtifStep[],
): Promise<void> {
  const artifacts = codexEvidenceArtifacts(steps);
  const resultPath = path.join(location, 'result.json');
  const result = parseRunResult(
    JSON.parse(await fs.readFile(resultPath, 'utf8')),
  );
  await Promise.all(
    artifacts.map((artifact) =>
      fs.writeFile(path.join(location, artifact.path), artifact.body),
    ),
  );
  await fs.writeFile(
    resultPath,
    jsonBody({
      ...result,
      artifacts: result.artifacts.map((descriptor) => {
        const artifact = artifacts.find(
          ({ path: artifactPath }) => artifactPath === descriptor.path,
        );
        return artifact === undefined
          ? descriptor
          : descriptorFor(artifact.path, artifact.body);
      }),
    }),
  );
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
  const transaction = await createArtifactStore({ root }).begin('run-1');
  const plan = options.plan ?? testPlanForResult(transform(resultFor([])));
  const planBody = Buffer.from(serializeResolvedRunPlan(plan), 'utf8');
  const completeArtifacts = [...artifacts];
  if (
    options.includeSetup !== false &&
    !completeArtifacts.some(
      ({ path: artifactPath }) => artifactPath === 'setup.json',
    )
  ) {
    completeArtifacts.unshift({
      path: 'setup.json',
      body: emptySetupBody(plan),
    });
  }
  if (
    options.includePlan !== false &&
    !completeArtifacts.some(
      ({ path: artifactPath }) => artifactPath === 'plan.json',
    )
  ) {
    completeArtifacts.unshift({ path: 'plan.json', body: planBody });
  }
  for (const artifact of completeArtifacts) {
    await transaction.write({
      ...artifact,
      mediaType: artifact.mediaType ?? 'application/json',
    });
  }
  const descriptors = completeArtifacts.map((artifact) =>
    descriptorFor(artifact.path, artifact.body, artifact),
  );
  const committed = await transaction.commit(
    transform(resultFor(descriptors, plan)) as unknown as Readonly<
      Record<string, unknown>
    >,
  );
  return committed.location;
}

function testPlanForResult(result: RunResultV1): ResolvedRunPlanV1 {
  const multiTurn = result.interaction.mode === 'multi_turn';
  const criteria = result.evaluation.judging_criteria.map(
    ({ criterion }) => criterion,
  );
  const hasChecks = result.evaluation.checks.length > 0;
  return createTestResolvedRunPlan({
    caseId: 'sample/case',
    prompt: 'do it',
    mode: result.interaction.mode,
    ...(multiTurn
      ? { rolePlayer: { provider: 'test-provider', model: 'role-model' } }
      : {}),
    judgingCriteria: criteria,
    ...(criteria.length === 0
      ? {}
      : { judge: { provider: 'test-provider', model: 'judge-model' } }),
    ...(hasChecks ? { checks: { files_created: ['answer.txt'] } } : {}),
    agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
  });
}

function descriptorFor(
  artifactPath: string,
  body: Buffer,
  options: Pick<TestArtifact, 'mediaType' | 'sensitivity'> = {},
): ArtifactDescriptorV1 {
  return {
    path: artifactPath,
    media_type: options.mediaType ?? 'application/json',
    size_bytes: body.byteLength,
    sha256: sha256Digest(body),
    ...(options.sensitivity === undefined
      ? {}
      : { sensitivity: options.sensitivity }),
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
    agent: { name: 'test-agent', version: '1' },
    steps,
  });
}

function judgeEvidenceValue(): JudgeEvidenceV1 {
  return {
    transcript: {
      source: 'trajectory.json',
      projection_id: 'forge-visible-atif-steps',
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
        { step_id: 1, source: 'user', message: 'do it' },
        { step_id: 2, source: 'agent', message: 'done' },
      ],
    },
    workspace: { entries: [], complete: true, warnings: [] },
  };
}

function judgeEvidenceBody(): Buffer {
  return jsonBody(judgeEvidenceValue());
}

function emptyWorkspaceEvidenceBody(): Buffer {
  return jsonBody({ entries: [], complete: true, warnings: [] });
}

function emptySetupBody(plan: ResolvedRunPlanV1): Buffer {
  return jsonBody({
    steps: plan.setup.map((step, index) => ({ index, uses: step.uses })),
  });
}

function withPassingCriterion(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    evaluation: {
      ...result.evaluation,
      score: 1,
      judging_criteria_passed: 1,
      judging_criteria_total: 1,
      judging_criteria: [
        {
          criterion: 'The task is complete.',
          passed: true,
          explanation: 'Met.',
        },
      ],
    },
  };
}

function withPassingWorkspaceCheck(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    evaluation: {
      ...result.evaluation,
      checks: [{ name: 'file_created: answer.txt', passed: true }],
    },
  };
}

function withMultiTurnSummary(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    interaction: { mode: 'multi_turn', turn_count: 2 },
  };
}

function withZeroTurnRolePlayerFailure(result: RunResultV1): RunResultV1 {
  return {
    ...result,
    agent: { ...result.agent, session_id: null },
    interaction: { mode: 'multi_turn', turn_count: 0 },
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
    run_id: 'run-1',
    selection: plan.selection,
    forge: {
      ...FORGE_BUILD_IDENTITY,
      ...(plan.provenance.forge.action_bundles === undefined
        ? {}
        : { action_bundles: plan.provenance.forge.action_bundles }),
    },
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
    interaction: { mode: 'one_shot', turn_count: 1 },
    failure: null,
    evidence: {
      format: 'atif',
      schema_version: 'ATIF-v1.8',
      provenance: {
        source: {
          kind: 'native_log',
          format: 'claude-code-jsonl',
          session_id: 'session',
        },
        adapter: { id: 'claude-code', version: '1' },
      },
      completeness: 'complete',
      warnings: [],
      redaction_count: 0,
    },
    evaluation: {
      score: 0,
      status: 'passed',
      judging_criteria_passed: 0,
      judging_criteria_total: 0,
      judging_criteria: [],
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
