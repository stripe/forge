import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';

import type {
  AgentAdapter,
  AgentNativeEvidenceResult,
} from '../contracts/agent.ts';
import type {
  RunArtifact,
  RunArtifactStore,
  RunArtifactTransaction,
} from '../contracts/artifacts.ts';
import type { ForgeComposition } from '../contracts/composition.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type { RunInputProvider } from '../contracts/inputs.ts';
import type { RunEvent } from '../contracts/observability.ts';
import type {
  PreparedRuntime,
  RuntimeAdapter,
  SealedRuntime,
} from '../contracts/runtime.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import { createArtifactStore, verifyCompletedRun } from '../results/index.ts';
import { createOwnedWorkspace } from '../runtime/workspace.ts';
import { createSetupExecutorWithHandlers } from '../setup/executor.ts';
import type {
  SetupExecutionContext,
  SetupStepHandler,
} from '../setup/types.ts';
import { FORGE_BUILD_IDENTITY, FORGE_VERSION } from '../version.ts';
import { ForgeExecutionError } from './errors.ts';
import {
  executeEval,
  executeEvalWithTestHooks,
  preflightEval,
} from './execute.ts';

const roots: string[] = [];
const SECRET = 'sk-ant-test-secret-value';
const RAW_NATIVE_SESSION = `{"type":"system","credential":"${SECRET}"}\n`;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('executeEval', () => {
  it('persists a preflight metadata snapshot without replacing custom adapter versions', async () => {
    const fixture = await executionFixture();
    const store = createArtifactStore({
      root: path.join(fixture.root, 'artifacts'),
    });
    const composition = fixture.composition(store);
    const agent = composition.agents.get('claude-code')!;
    const metadata = {
      endpoint_mode: 'custom' as const,
      layout_mode: 'custom' as 'default' | 'custom',
    };
    const configuredAgent: AgentAdapter = {
      ...agent,
      metadata,
      async prepare(context) {
        metadata.layout_mode = 'default';
        await agent.prepare(context);
      },
    };
    const completed = await executeEval({
      runId: 'metadata-snapshot',
      plan: fixture.plan,
      composition: {
        ...composition,
        agents: new Map([[agent.id, configuredAgent]]),
      },
    });
    assert.equal(completed.result.agent.adapter_version, 'test-adapter');
    assert.deepEqual(completed.result.agent.metadata, {
      endpoint_mode: 'custom',
      layout_mode: 'custom',
    });
    assert.equal(
      Object.hasOwn(completed.result.evidence, 'normalization_version'),
      false,
    );
    assert.deepEqual(
      (await verifyCompletedRun(completed.location)).result.agent.metadata,
      completed.result.agent.metadata,
    );
  });

  it('rejects undeclared adapter metadata before resolving credentials or allocating a runtime', async () => {
    const fixture = await executionFixture();
    const composition = fixture.composition(inertStore());
    const agent = composition.agents.get('claude-code')!;
    const configuredAgent = {
      ...agent,
      metadata: {
        endpoint_mode: 'custom',
        layout_mode: 'default',
        endpoint: 'https://private.example.com',
      },
    } as AgentAdapter;
    assert.throws(
      () =>
        preflightEval({
          plan: fixture.plan,
          composition: {
            ...composition,
            agents: new Map([[agent.id, configuredAgent]]),
          },
        }),
      ForgeExecutionError,
    );
    assert.deepEqual(fixture.calls, []);
  });

  it('runs the shared lifecycle, redacts credentials, and atomically commits', async () => {
    const fixture = await executionFixture({ nativeArtifact: true });
    const localStore = createArtifactStore({
      root: path.join(fixture.root, 'artifacts'),
    });
    const composition = fixture.composition(
      recordingStore(localStore, fixture.calls),
    );

    const completed = await executeEval({
      runId: 'run-1',
      plan: fixture.plan,
      composition,
      now: monotonicClock(),
    });

    {
      const actual = completed.result;
      assert.ok(actual);
      assert.ok(actual.evidence.provenance.source.kind === 'native_log');
      assert.ok(!('schema_version' in actual));
      assert.equal(actual.run_id, 'run-1');
      assert.deepEqual(actual.forge, FORGE_BUILD_IDENTITY);
      assert.equal(actual.agent.session_id, 'canonical-session');
      assert.equal(actual.evidence.redaction_count, 1);
      assert.equal(actual.evidence.completeness, 'complete');
      assert.equal(
        actual.evidence.provenance.source.format,
        'claude-code-jsonl',
      );
      assert.equal(
        actual.evidence.provenance.source.session_id,
        'canonical-session',
      );
      assert.equal(actual.evidence.provenance.adapter.id, 'claude-code');
      assert.equal(actual.evidence.provenance.adapter.version, 'test-adapter');
      assert.deepEqual(
        actual.supplemental_artifacts.map((item) => ({
          path: item.path,
          media_type: item.media_type,
          sensitivity: item.sensitivity,
        })),
        [
          {
            path: 'native/claude-code/session.jsonl',
            media_type: 'application/x-ndjson',
            sensitivity: 'restricted',
          },
        ],
      );
      assert.equal(actual.evaluation.status, 'passed');
      assert.equal(actual.evaluation.score, 0);
    }
    assert.deepEqual(fixture.calls, [
      'credential:anthropic.api-key',
      'runtime:prepare',
      'agent:prepare',
      'runtime:finalize-setup',
      'agent:open',
      'agent:send',
      'runtime:quiesce',
      'agent:native:canonical-session',
      'agent:evidence:canonical-session',
      'artifact:begin',
      'artifact:write:plan.json',
      'artifact:write:setup.json',
      'artifact:write:trajectory.json',
      'artifact:write:interaction.json',
      'artifact:write:workspace-evidence.json',
      'artifact:write:native/claude-code/session.jsonl',
      'runtime:dispose',
      'artifact:commit',
    ]);

    const verified = await verifyCompletedRun(completed.location);
    {
      const actual = verified.result;
      assert.ok(actual);
      assert.ok(!('schema_version' in actual));
      assert.equal(actual.evidence.provenance.source.kind, 'native_log');
      assert.equal(
        actual.evidence.provenance.source.format,
        'claude-code-jsonl',
      );
      assert.equal(actual.evidence.provenance.adapter.id, 'claude-code');
      assert.equal(actual.evidence.provenance.adapter.version, 'test-adapter');
    }
    assert.deepEqual(verified.result.evaluation.checks, [
      { name: 'file_created: greeting.txt', passed: true },
      { name: 'file_exists: greeting.txt', passed: true },
      { name: 'file_contains: greeting.txt /hello/', passed: true },
      {
        name: 'tool_called: NeverCalled',
        label: 'telemetry',
        requirement_level: 'OPTIONAL',
        passed: false,
        tool_calls: { matched_count: 0, calls: [] },
      },
    ]);
    assert.equal(verified.result.evaluation.status, 'passed');
    const trajectory = await fs.readFile(
      path.join(completed.location, 'trajectory.json'),
      'utf8',
    );
    assert.ok(trajectory.includes('[REDACTED]'));
    assert.ok(!trajectory.includes(SECRET));
    const nativePath = path.join(
      completed.location,
      'native/claude-code/session.jsonl',
    );
    assert.equal(await fs.readFile(nativePath, 'utf8'), RAW_NATIVE_SESSION);
    assert.equal((await fs.stat(nativePath)).mode & 0o777, 0o600);
    assert.ok(!('plan_sha256' in completed.result));
    const workspaceEvidence = JSON.parse(
      await fs.readFile(
        path.join(completed.location, 'workspace-evidence.json'),
        'utf8',
      ),
    ) as { entries: Array<Record<string, unknown>> };
    assert.ok(!('schema_version' in workspaceEvidence));
    assert.ok(!('sha256' in workspaceEvidence.entries[0]!));
  });

  it('commits completed scoring with a safe warning when runtime cleanup fails', async () => {
    const fixture = await executionFixture();
    const store = createArtifactStore({
      root: path.join(fixture.root, 'cleanup-warning'),
    });
    const composition = fixture.composition(
      recordingStore(store, fixture.calls),
    );
    const observed: RunEvent[] = [];
    const warning = {
      code: 'runtime_cleanup_failed',
      message: 'Runtime cleanup failed after canonical artifacts were staged.',
    };
    const completed = await executeEval({
      runId: 'run-cleanup-warning',
      plan: fixture.plan,
      composition: {
        ...composition,
        runtime: {
          ...composition.runtime,
          async prepare(input) {
            const prepared = await composition.runtime.prepare(input);
            return {
              ...prepared,
              async dispose() {
                await prepared.dispose();
                throw new Error(`private cleanup detail: ${SECRET}`);
              },
            };
          },
        },
        observer: {
          observe(event) {
            observed.push(event);
            throw new Error('synchronous observation failure');
          },
        },
      },
      now: monotonicClock(),
    });

    {
      const actual = completed.result.evaluation;
      assert.ok(actual);
      assert.equal(actual.status, 'passed');
      assert.equal(actual.score, 0);
    }
    assert.deepEqual(completed.result.warnings, [warning]);
    assert.ok(!JSON.stringify(observed).includes(SECRET));
    assert.deepEqual(fixture.calls.slice(-2), [
      'runtime:dispose',
      'artifact:commit',
    ]);
    assert.deepEqual(
      fixture.calls.filter((call) => call === 'runtime:dispose'),
      ['runtime:dispose'],
    );
    const verified = await verifyCompletedRun(completed.location);
    assert.deepEqual(verified.result.warnings, [warning]);
    assert.deepEqual(verified.result.evaluation, completed.result.evaluation);
  });

  it('isolates contributor result snapshots and captures returned artifact bytes', async () => {
    const nativeBody = Buffer.from(RAW_NATIVE_SESSION);
    const fixture = await executionFixture({
      nativeArtifact: true,
      nativeArtifactBody: nativeBody,
    });
    const contributionBody = Buffer.from('first contribution\n');
    const contributed = {
      path: 'extensions/first/report.txt',
      body: contributionBody,
      mediaType: 'text/plain',
    } satisfies RunArtifact;
    let nativeDigest: unknown;
    const composition: ForgeComposition = {
      ...fixture.composition(
        createArtifactStore({
          root: path.join(fixture.root, 'snapshot-artifacts'),
        }),
      ),
      contributors: [
        {
          id: 'first',
          async contribute({ result }) {
            const descriptors = result.supplemental_artifacts as Array<{
              sha256: string;
            }>;
            nativeDigest = descriptors[0]!.sha256;
            descriptors[0]!.sha256 = `sha256:${'f'.repeat(64)}`;
            (result.evaluation as { status: string }).status = 'failed';
            return [contributed];
          },
        },
        {
          id: 'second',
          async contribute({ result }) {
            assert.equal(
              (result.supplemental_artifacts as Array<{ sha256: string }>)[0]
                ?.sha256,
              nativeDigest,
            );
            {
              const actual = result.evaluation as { status: string };
              assert.ok(actual);
              assert.equal(actual.status, 'passed');
            }
            nativeBody.fill(0);
            contributionBody.fill(0);
            contributed.path = 'extensions/second/replaced.txt';
            return [];
          },
        },
      ],
    };

    const completed = await executeEval({
      runId: 'run-contributor-snapshots',
      plan: fixture.plan,
      composition,
      now: monotonicClock(),
    });
    assert.equal(completed.result.evaluation.status, 'passed');
    assert.equal(
      completed.result.supplemental_artifacts[0]?.sha256,
      nativeDigest,
    );
    assert.equal(
      await fs.readFile(
        path.join(completed.location, 'native/claude-code/session.jsonl'),
        'utf8',
      ),
      RAW_NATIVE_SESSION,
    );
    assert.equal(
      await fs.readFile(
        path.join(completed.location, 'extensions/first/report.txt'),
        'utf8',
      ),
      'first contribution\n',
    );
    {
      const actual = await verifyCompletedRun(completed.location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-contributor-snapshots');
    }
  });

  it('omits standalone evaluation and empty workspace evidence artifacts', async () => {
    const emptyCheckVariants: Array<
      readonly [string, ResolvedRunPlanV1['evaluation']['checks']]
    > = [
      ['omitted', undefined],
      ['empty', { files_created: [], file_checks: [] }],
    ];
    for (const [suffix, emptyChecks] of emptyCheckVariants) {
      const fixture = await executionFixture();
      const caseWithoutChecks = { ...fixture.plan.case };
      delete caseWithoutChecks.checks;
      const evalCase =
        emptyChecks === undefined
          ? caseWithoutChecks
          : { ...caseWithoutChecks, checks: emptyChecks };
      const plan: ResolvedRunPlanV1 = {
        ...fixture.plan,
        case: evalCase,
        evaluation: {
          judging_criteria: [],
          ...(emptyChecks === undefined ? {} : { checks: emptyChecks }),
        },
      };
      const completed = await executeEval({
        runId: `run-minimal-artifacts-${suffix}`,
        plan,
        composition: fixture.composition(
          createArtifactStore({
            root: path.join(fixture.root, `minimal-artifacts-${suffix}`),
          }),
        ),
        now: monotonicClock(),
      });

      {
        const actual = completed.result.evaluation;
        assert.ok(actual);
        assert.equal(actual.status, 'passed');
        assert.equal(actual.score, 0);
      }
      assert.deepEqual(
        completed.result.artifacts.map(
          ({ path: artifactPath }) => artifactPath,
        ),
        ['plan.json', 'setup.json', 'trajectory.json', 'interaction.json'],
      );
      {
        const actual = await verifyCompletedRun(completed.location);
        assert.ok(actual);
        assert.deepEqual(actual.runId, `run-minimal-artifacts-${suffix}`);
      }
    }
  });

  it('rejects adapter-produced fallback evidence', async () => {
    const fixture = await executionFixture({ adapterFallbackEvidence: true });

    await assert.rejects(
      executeEval({
        runId: 'run-bad-evidence',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      }),
      { code: 'evidence_failed', phase: 'evidence' },
    );
    assert.ok(!fixture.calls.includes('artifact:begin'));
    assert.equal(fixture.calls.at(-1), 'runtime:dispose');
  });

  it('rejects completed evidence without exact session provenance', async () => {
    const fixture = await executionFixture({ omitEvidenceSession: true });

    await assert.rejects(
      executeEval({
        runId: 'run-unowned-evidence',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      }),
      { code: 'evidence_failed', phase: 'evidence' },
    );
    assert.ok(!fixture.calls.includes('artifact:begin'));
    assert.equal(fixture.calls.at(-1), 'runtime:dispose');
  });

  it('rejects a native artifact for a different session before staging', async () => {
    const fixture = await executionFixture({
      nativeArtifact: true,
      nativeArtifactSessionId: 'other-session',
    });

    await assert.rejects(
      executeEval({
        runId: 'run-mismatched-native-artifact',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      }),
      { code: 'evidence_failed', phase: 'evidence' },
    );
    assert.ok(!fixture.calls.includes('artifact:begin'));
    assert.equal(fixture.calls.at(-1), 'runtime:dispose');
  });

  it('retains exact native bytes when normalization uses driver fallback', async () => {
    const fixture = await executionFixture({
      nativeArtifact: true,
      nativeEvidenceUnavailable: true,
    });
    const completed = await executeEval({
      runId: 'run-native-fallback',
      plan: fixture.plan,
      composition: fixture.composition(
        createArtifactStore({
          root: path.join(fixture.root, 'native-fallback'),
        }),
      ),
      now: monotonicClock(),
    });

    {
      const actual = completed.result.evidence;
      assert.ok(actual);
      assert.equal(actual.completeness, 'fallback');
      assert.equal(actual.provenance.source.kind, 'driver_fallback');
    }
    assert.equal(
      await fs.readFile(
        path.join(completed.location, 'native/claude-code/session.jsonl'),
        'utf8',
      ),
      RAW_NATIVE_SESSION,
    );
    {
      const actual = await verifyCompletedRun(completed.location);
      assert.ok(actual);
      assert.equal(actual.runId, 'run-native-fallback');
    }
  });

  it('rolls back an opened artifact transaction when staging fails', async () => {
    const fixture = await executionFixture();
    let rollbacks = 0;
    const failingStore: RunArtifactStore = {
      async begin(): Promise<RunArtifactTransaction> {
        fixture.calls.push('artifact:begin');
        return {
          async write() {
            fixture.calls.push('artifact:write:failed');
            throw new Error('storage unavailable');
          },
          async commit() {
            throw new Error('commit must not run');
          },
          async rollback() {
            rollbacks += 1;
            fixture.calls.push('artifact:rollback');
          },
        };
      },
    };

    const rejected = executeEval({
      runId: 'run-rollback',
      plan: fixture.plan,
      composition: fixture.composition(failingStore),
      now: monotonicClock(),
    });
    await assert.rejects(rejected, {
      code: 'artifact_failed',
      phase: 'artifact_stage',
    });
    assert.equal(rollbacks, 1);
    assert.deepEqual(fixture.calls.slice(-2), [
      'artifact:rollback',
      'runtime:dispose',
    ]);
  });

  it('preserves a commit failure through failed rollback without disposing twice', async () => {
    const fixture = await executionFixture();
    const commitFailure = new Error('primary commit failure');
    const failingStore: RunArtifactStore = {
      async begin() {
        fixture.calls.push('artifact:begin');
        return {
          async write(artifact) {
            fixture.calls.push(`artifact:write:${artifact.path}`);
          },
          async commit() {
            fixture.calls.push('artifact:commit');
            throw commitFailure;
          },
          async rollback() {
            fixture.calls.push('artifact:rollback');
            throw new Error('secondary rollback failure');
          },
        };
      },
    };

    await assert.rejects(
      executeEval({
        runId: 'run-commit-failure',
        plan: fixture.plan,
        composition: fixture.composition(failingStore),
        now: monotonicClock(),
      }),
      {
        code: 'artifact_failed',
        phase: 'result_commit',
        message: 'Forge failed during result_commit.',
        cause: commitFailure,
      },
    );
    assert.deepEqual(fixture.calls.slice(-3), [
      'runtime:dispose',
      'artifact:commit',
      'artifact:rollback',
    ]);
    assert.deepEqual(
      fixture.calls.filter((call) => call === 'runtime:dispose'),
      ['runtime:dispose'],
    );
    assert.deepEqual(
      fixture.calls.filter((call) => call === 'artifact:rollback'),
      ['artifact:rollback'],
    );
  });

  it('classifies session startup failures as agent failures', async () => {
    const fixture = await executionFixture({ openSessionFailure: true });

    let captured: unknown;
    try {
      await executeEval({
        runId: 'run-agent-failure',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      });
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof ForgeExecutionError);
    {
      const actual = captured;
      assert.ok(actual);
      assert.equal(actual.code, 'agent_failed');
      assert.equal(actual.phase, 'interaction');
    }
    assert.equal(fixture.calls.at(-1), 'runtime:dispose');
  });

  it('authorizes original shared-source references and preserves declared scopes', async () => {
    const fixture = await executionFixture();
    const step: ResolvedRunPlanV1['setup'][number] = {
      uses: 'forge/command',
      with: { argv: ['true'] },
    };
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      treatment: { id: fixture.plan.treatment.id, setup: [step] },
      setup: [step],
    };
    const handler: SetupStepHandler = {
      uses: step.uses,
      preflight() {
        return Object.freeze({
          requirements: Object.freeze({
            credentials: Object.freeze({
              setup: Object.freeze({
                SETUP_TOKEN: Object.freeze({
                  reference: credentialReference('setup.token'),
                }),
                SHARED_TOKEN: Object.freeze({
                  reference: credentialReference('shared.agent-token'),
                }),
              }),
              agent: Object.freeze({
                SERVICE_TOKEN: Object.freeze({
                  reference: credentialReference('service.token'),
                }),
                SHARED_TOKEN: Object.freeze({
                  reference: credentialReference('shared.token'),
                }),
              }),
            }),
          }),
          async apply(context: SetupExecutionContext) {
            assert.equal(context.stepIndex, 0);
            assert.equal(context.selection.adapter, 'claude-code');
            assert.equal(context.paths.workspace, '/workspace');
          },
        });
      },
    };
    const localStore = createArtifactStore({
      root: path.join(fixture.root, 'scoped-artifacts'),
    });
    const composition = fixture.composition(localStore);
    const runtime = composition.runtime;
    const originalAgent = composition.agents.get('claude-code')!;
    const calls: Array<{ reference: string; purpose: string; runId: string }> =
      [];

    await executeEvalWithTestHooks(
      {
        runId: 'run-scoped-credentials',
        plan,
        composition: {
          ...composition,
          agents: new Map([
            [
              originalAgent.id,
              {
                ...originalAgent,
                requirements(selection) {
                  const requirements = originalAgent.requirements(selection);
                  return {
                    ...requirements,
                    environment: {
                      ...requirements.environment,
                      credentials: {
                        ...requirements.environment.credentials,
                        SHARED_TOKEN: {
                          reference: credentialReference('shared.agent-token'),
                        },
                      },
                    },
                  };
                },
              },
            ],
          ]),
          credentialResolver: {
            sourceIdentity(reference) {
              return reference.startsWith('shared.')
                ? 'shared-source'
                : undefined;
            },
            async resolve(reference, context) {
              calls.push({
                reference,
                purpose: context.purpose,
                runId: context.runId,
              });
              return SECRET;
            },
          },
          runtime: {
            ...runtime,
            async prepare(input) {
              assert.deepEqual(
                input.environment.credentials.ANTHROPIC_API_KEY?.scopes,
                ['agent'],
              );
              assert.deepEqual(
                input.environment.credentials.SETUP_TOKEN?.scopes,
                ['setup'],
              );
              assert.deepEqual(
                input.environment.credentials.SERVICE_TOKEN?.scopes,
                ['agent'],
              );
              assert.deepEqual(
                input.environment.credentials.SHARED_TOKEN?.scopes,
                ['setup', 'agent'],
              );
              return runtime.prepare(input);
            },
          },
        },
        now: monotonicClock(),
      },
      {
        setupExecutor: createSetupExecutorWithHandlers(
          new Map([[handler.uses, handler]]),
          true,
        ),
      },
    );
    assert.deepEqual(
      calls.filter(({ purpose }) => purpose === 'forge-eval:SHARED_TOKEN'),
      [
        {
          reference: 'shared.agent-token',
          purpose: 'forge-eval:SHARED_TOKEN',
          runId: 'run-scoped-credentials',
        },
        {
          reference: 'shared.token',
          purpose: 'forge-eval:SHARED_TOKEN',
          runId: 'run-scoped-credentials',
        },
      ],
    );
  });

  for (const failure of [
    'unproven',
    'execution-unproven',
    'denied',
    'inconsistent',
  ] as const) {
    it(`rejects ${failure} authorization of a second original reference`, async () => {
      const fixture = await executionFixture();
      const step: ResolvedRunPlanV1['setup'][number] = {
        uses: 'forge/credentials',
        with: { env: ['ANTHROPIC_API_KEY'] },
      };
      const plan = {
        ...fixture.plan,
        treatment: { id: fixture.plan.treatment.id, setup: [step] },
        setup: [step],
      };
      const calls: Array<{ reference: string; purpose: string }> = [];
      const composition = fixture.composition(inertStore());
      const agent = composition.agents.get('claude-code')!;
      await assert.rejects(
        executeEval({
          runId: `shared-reference-${failure}`,
          plan,
          composition: {
            ...composition,
            agents: new Map([
              [
                agent.id,
                {
                  ...agent,
                  requirements(selection) {
                    const requirements = agent.requirements(selection);
                    return {
                      ...requirements,
                      environment: {
                        ...requirements.environment,
                        credentials: {
                          FIRST_TOKEN: {
                            reference: credentialReference('first.token'),
                          },
                          ...requirements.environment.credentials,
                        },
                      },
                    };
                  },
                },
              ],
            ]),
            credentialResolver: {
              ...(failure === 'unproven'
                ? {}
                : {
                    sourceIdentity: (
                      _reference: unknown,
                      context: { phase: string },
                    ) =>
                      failure === 'execution-unproven' &&
                      context.phase === 'execution'
                        ? undefined
                        : 'source',
                  }),
              async resolve(reference, context) {
                calls.push({ reference, purpose: context.purpose });
                if (reference === 'env:ANTHROPIC_API_KEY') {
                  if (failure === 'denied') throw new Error('access denied');
                  return 'different-source-value';
                }
                return SECRET;
              },
            },
          },
        }),
        {
          code: failure === 'unproven' ? 'invalid_plan' : 'credential_failed',
          phase: 'preflight',
        },
      );
      assert.deepEqual(
        calls,
        failure === 'unproven' || failure === 'execution-unproven'
          ? []
          : [
              {
                reference: 'first.token',
                purpose: 'forge-eval:FIRST_TOKEN',
              },
              {
                reference: 'anthropic.api-key',
                purpose: 'forge-eval:ANTHROPIC_API_KEY',
              },
              {
                reference: 'env:ANTHROPIC_API_KEY',
                purpose: 'forge-eval:ANTHROPIC_API_KEY',
              },
            ],
      );
      assert.equal(fixture.calls.includes('runtime:prepare'), false);
    });
  }

  for (const [description, credential] of [
    ['an unescaped credential', SECRET],
    ['a JSON-escaped credential', 'sk-ant-test-"quoted"\\value'],
  ] as const) {
    it(`rejects a setup resolution containing ${description} before interaction`, async () => {
      const fixture = await executionFixture({ credentialValue: credential });
      const step: ResolvedRunPlanV1['setup'][number] = {
        uses: 'forge/command',
        with: { argv: ['true'] },
      };
      const plan: ResolvedRunPlanV1 = {
        ...fixture.plan,
        treatment: { id: fixture.plan.treatment.id, setup: [step] },
        setup: [step],
      };
      const handler: SetupStepHandler = {
        uses: step.uses,
        preflight() {
          return {
            requirements: {},
            async apply() {
              return { leaked: credential };
            },
          };
        },
      };

      await assert.rejects(
        executeEvalWithTestHooks(
          {
            runId: 'run-secret-setup-resolution',
            plan,
            composition: fixture.composition(inertStore()),
            now: monotonicClock(),
          },
          {
            setupExecutor: createSetupExecutorWithHandlers(
              new Map([[handler.uses, handler]]),
            ),
          },
        ),
        { code: 'setup_failed', phase: 'setup' },
      );
      assert.ok(!fixture.calls.includes('agent:open'));
      assert.equal(fixture.calls.at(-1), 'runtime:dispose');
    });
  }

  it('preflights every first-party setup operation before resolving credentials or allocating', async () => {
    const fixture = await executionFixture();
    const step: ResolvedRunPlanV1['setup'][number] = {
      uses: 'forge/command',
      with: { argv: ['true'] },
    };
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      treatment: { id: fixture.plan.treatment.id, setup: [step] },
      setup: [step],
    };
    const handler: SetupStepHandler = {
      uses: step.uses,
      preflight() {
        throw new TypeError('invalid first-party payload');
      },
    };
    const composition = fixture.composition(inertStore());
    let credentialResolved = false;
    let runtimePrepared = false;

    await assert.rejects(
      executeEvalWithTestHooks(
        {
          runId: 'run-invalid-setup-preflight',
          plan,
          composition: {
            ...composition,
            credentialResolver: {
              async resolve() {
                credentialResolved = true;
                return 'must-not-resolve';
              },
            },
            runtime: {
              ...composition.runtime,
              async prepare(input) {
                runtimePrepared = true;
                return composition.runtime.prepare(input);
              },
            },
          },
        },
        {
          setupExecutor: createSetupExecutorWithHandlers(
            new Map([[handler.uses, handler]]),
          ),
        },
      ),
      { code: 'invalid_plan', phase: 'preflight' },
    );
    assert.equal(credentialResolved, false);
    assert.equal(runtimePrepared, false);
  });

  it('rejects a plan stamped by another package version', async () => {
    const fixture = await executionFixture();
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      provenance: {
        ...fixture.plan.provenance,
        forge: { ...fixture.plan.provenance.forge, version: '0.0.0' },
      },
    };
    assert.throws(
      () =>
        preflightEval({ plan, composition: fixture.composition(inertStore()) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'invalid_plan');
        assert.equal((error as { phase?: string }).phase, 'preflight');
        assert.ok(error.cause instanceof Error);
        assert.ok(error.cause.cause instanceof Error);
        assert.equal(
          error.cause.cause.message,
          `Forge 0.0.0 is incompatible with installed Forge ${FORGE_VERSION}; official releases require an exact version match.`,
        );
        return true;
      },
    );
  });

  it('preflights source provenance and applies the reader release policy to development plans', async () => {
    const fixture = await executionFixture();
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      provenance: {
        ...fixture.plan.provenance,
        forge: {
          version: FORGE_VERSION,
          commit_sha: 'a'.repeat(40),
          dirty: true,
        },
      },
    };
    assert.doesNotThrow(() =>
      preflightEval({ plan, composition: fixture.composition(inertStore()) }),
    );
    const developmentPlan = {
      ...plan,
      provenance: {
        ...plan.provenance,
        forge: { ...plan.provenance.forge, version: '0.0.0-dev.42' },
      },
    };
    if (FORGE_VERSION.includes('-dev.')) {
      assert.doesNotThrow(() =>
        preflightEval({
          plan: developmentPlan,
          composition: fixture.composition(inertStore()),
        }),
      );
    } else {
      assert.throws(
        () =>
          preflightEval({
            plan: developmentPlan,
            composition: fixture.composition(inertStore()),
          }),
        { code: 'invalid_plan', phase: 'preflight' },
      );
    }
  });

  it('rejects malformed agent environment declarations during pure preflight', async () => {
    const fixture = await executionFixture();
    const composition = fixture.composition(inertStore());
    const selected = composition.agents.get('claude-code')!;

    for (const environment of [
      [],
      { credential: { TOKEN: { reference: 'unsafe.token' } } },
      { variables: [] },
      { variables: null },
      { variables: { 'BAD-NAME': 'value' } },
      { variables: { VALID_NAME: 'line-one\nline-two' } },
      { credentials: [] },
      { credentials: null },
      { credentials: { TOKEN: { reference: 'unsafe.token', extra: true } } },
    ]) {
      const unsafeAgent: AgentAdapter = {
        ...selected,
        requirements(selection) {
          return {
            ...selected.requirements(selection),
            environment,
          } as unknown as ReturnType<AgentAdapter['requirements']>;
        },
      };
      assert.throws(
        () =>
          preflightEval({
            plan: fixture.plan,
            composition: {
              ...composition,
              agents: new Map([[unsafeAgent.id, unsafeAgent]]),
            },
          }),
        ForgeExecutionError,
      );
    }

    let credentialResolved = false;
    let runtimePrepared = false;
    const unsafeAgent: AgentAdapter = {
      ...selected,
      requirements(selection) {
        return {
          ...selected.requirements(selection),
          environment: {
            credential: { TOKEN: { reference: 'unsafe.token' } },
          },
        } as unknown as ReturnType<AgentAdapter['requirements']>;
      },
    };
    await assert.rejects(
      executeEval({
        runId: 'run-invalid-agent-environment',
        plan: fixture.plan,
        composition: {
          ...composition,
          agents: new Map([[unsafeAgent.id, unsafeAgent]]),
          credentialResolver: {
            async resolve() {
              credentialResolved = true;
              return 'must-not-resolve';
            },
          },
          runtime: {
            ...composition.runtime,
            async prepare(input) {
              runtimePrepared = true;
              return composition.runtime.prepare(input);
            },
          },
        },
      }),
      { code: 'invalid_plan', phase: 'preflight' },
    );
    assert.equal(credentialResolved, false);
    assert.equal(runtimePrepared, false);
  });

  it('rejects capability-assigned credential scopes before resolving authority', async () => {
    const fixture = await executionFixture();
    const composition = fixture.composition(inertStore());
    const selected = composition.agents.get('claude-code')!;
    let credentialResolved = false;
    let runtimePrepared = false;
    const unsafeAgent: AgentAdapter = {
      ...selected,
      requirements(selection) {
        const requirements = selected.requirements(selection);
        return {
          ...requirements,
          environment: {
            credentials: {
              TOKEN: {
                reference: credentialReference('unsafe.token'),
                scopes: ['setup'],
              },
            },
          },
        } as unknown as ReturnType<AgentAdapter['requirements']>;
      },
    };

    await assert.rejects(
      executeEval({
        runId: 'run-unsafe-scope',
        plan: fixture.plan,
        composition: {
          ...composition,
          agents: new Map([[unsafeAgent.id, unsafeAgent]]),
          credentialResolver: {
            async resolve() {
              credentialResolved = true;
              return 'must-not-resolve';
            },
          },
          runtime: {
            ...composition.runtime,
            async prepare(input) {
              runtimePrepared = true;
              return composition.runtime.prepare(input);
            },
          },
        },
      }),
      { code: 'invalid_plan', phase: 'preflight' },
    );
    assert.equal(credentialResolved, false);
    assert.equal(runtimePrepared, false);
  });

  it('validates the fallback agent identity before resolving authority', async () => {
    const fixture = await executionFixture();
    const composition = fixture.composition(inertStore());
    const selected = composition.agents.get('claude-code')!;
    let credentialResolved = false;
    let runtimePrepared = false;
    const unsafeAgent: AgentAdapter = {
      ...selected,
      evidenceIdentity() {
        return { name: 'claude-code\nforged', version: 'test' };
      },
    };

    await assert.rejects(
      executeEval({
        runId: 'run-unsafe-evidence-identity',
        plan: fixture.plan,
        composition: {
          ...composition,
          agents: new Map([[unsafeAgent.id, unsafeAgent]]),
          credentialResolver: {
            async resolve() {
              credentialResolved = true;
              return 'must-not-resolve';
            },
          },
          runtime: {
            ...composition.runtime,
            async prepare(input) {
              runtimePrepared = true;
              return composition.runtime.prepare(input);
            },
          },
        },
      }),
      { code: 'invalid_plan', phase: 'preflight' },
    );
    assert.equal(credentialResolved, false);
    assert.equal(runtimePrepared, false);
  });
});

async function executionFixture(
  options: {
    openSessionFailure?: boolean;
    adapterFallbackEvidence?: boolean;
    omitEvidenceSession?: boolean;
    nativeArtifact?: boolean;
    nativeArtifactBody?: Uint8Array;
    nativeArtifactSessionId?: string;
    nativeEvidenceUnavailable?: boolean;
    credentialValue?: string;
  } = {},
): Promise<{
  root: string;
  plan: ResolvedRunPlanV1;
  calls: string[];
  composition: (store: RunArtifactStore) => ForgeComposition;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-execution-test-'),
  );
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  await fs.mkdir(workspaceRoot);
  const workspace = await createOwnedWorkspace(workspaceRoot);
  await workspace.writeFile('greeting.txt', Buffer.from('hello from forge\n'));
  const calls: string[] = [];
  const credentialValue = options.credentialValue ?? SECRET;

  const sealed: SealedRuntime = {
    runtimeId: 'runtime-1',
    workspace,
    paths: { workspace: '/workspace', home: '/home/forge' },
    stateDirectories: new Map(),
    metadata: { image: 'sha256:test-image' },
  };
  const dispose = async () => {
    calls.push('runtime:dispose');
  };
  const prepared: PreparedRuntime = {
    ...sealed,
    workspace,
    stateDirectories: new Map(),
    commands: {
      uncredentialed: inertCommandRunner(),
      setup: () => inertCommandRunner(),
      agent: inertCommandRunner(),
    },
    async finalizeSetup() {
      calls.push('runtime:finalize-setup');
    },
    async quiesce() {
      calls.push('runtime:quiesce');
      return sealed;
    },
    dispose,
  };
  const runtime: RuntimeAdapter = {
    id: 'forge/docker',
    preflight() {},
    async prepare(input) {
      calls.push('runtime:prepare');
      assert.equal(
        input.environment.credentials.ANTHROPIC_API_KEY?.value,
        credentialValue,
      );
      assert.deepEqual(
        input.environment.credentials.ANTHROPIC_API_KEY?.scopes,
        ['agent'],
      );
      assert.deepEqual(input.requirements.executables, ['claude']);
      return prepared;
    },
  };
  const agent: AgentAdapter = {
    id: 'claude-code',
    version: 'test-adapter',
    requirements() {
      return {
        executables: ['claude'],
        environment: {
          credentials: {
            ANTHROPIC_API_KEY: {
              reference: credentialReference('anthropic.api-key'),
            },
          },
        },
        stateDirectories: [],
      };
    },
    evidenceIdentity() {
      return { name: 'claude-code', version: 'test' };
    },
    async prepare(context) {
      assert.deepEqual(Object.keys(context.runtime.commands), [
        'uncredentialed',
      ]);
      assert.equal('quiesce' in context.runtime, false);
      assert.equal('dispose' in context.runtime, false);
      assert.equal('setup' in context.runtime.commands, false);
      assert.equal('set' in context.runtime.stateDirectories, false);
      await context.runtime.commands.uncredentialed.run([
        'agent-version-check',
      ]);
      calls.push('agent:prepare');
    },
    async openSession(context) {
      assert.deepEqual(Object.keys(context.runtime.commands), ['agent']);
      assert.equal('quiesce' in context.runtime, false);
      assert.equal('dispose' in context.runtime, false);
      assert.equal('setup' in context.runtime.commands, false);
      assert.equal('set' in context.runtime.stateDirectories, false);
      calls.push('agent:open');
      if (options.openSessionFailure) throw new Error('could not start agent');
      return {
        async send() {
          await context.runtime.commands.agent.run(['agent-interaction']);
          calls.push('agent:send');
          return {
            text: 'done',
            sessionId: 'canonical-session',
            toolCalls: [],
          };
        },
        sessionId() {
          return 'canonical-session';
        },
      };
    },
    ...(options.nativeArtifact === true
      ? {
          async collectNativeArtifact(context) {
            assert.equal('commands' in context.runtime, false);
            assert.equal('writeFile' in context.runtime.workspace, false);
            calls.push(`agent:native:${context.sessionId}`);
            return {
              format: 'claude-code-jsonl',
              sessionId: options.nativeArtifactSessionId ?? context.sessionId,
              mediaType: 'application/x-ndjson',
              extension: 'jsonl',
              body:
                options.nativeArtifactBody ??
                Buffer.from(RAW_NATIVE_SESSION, 'utf8'),
            };
          },
        }
      : {}),
    async collectEvidence(context) {
      assert.equal('commands' in context.runtime, false);
      assert.equal('dispose' in context.runtime, false);
      assert.equal('writeFile' in context.runtime.workspace, false);
      assert.equal('set' in context.runtime.stateDirectories, false);
      calls.push(`agent:evidence:${context.sessionId}`);
      if (options.nativeEvidenceUnavailable === true) {
        return {
          kind: 'unavailable',
          reason: {
            code: 'source_incomplete',
            message: 'The native source contains an unsupported record.',
          },
        };
      }
      return nativeEvidence({
        ...(options.adapterFallbackEvidence === undefined
          ? {}
          : { adapterFallback: options.adapterFallbackEvidence }),
        ...(options.omitEvidenceSession === undefined
          ? {}
          : { omitSession: options.omitEvidenceSession }),
      });
    },
  };
  const plan = resolvedPlan();

  return {
    root,
    plan,
    calls,
    composition: (artifactStore) => ({
      runtime,
      agents: new Map([[agent.id, agent]]),
      credentialResolver: {
        async resolve(reference) {
          calls.push(`credential:${reference}`);
          return credentialValue;
        },
      },
      inputProvider: inertInputProvider(),
      artifactStore,
    }),
  };
}

function nativeEvidence(
  options: { adapterFallback?: boolean; omitSession?: boolean } = {},
): AgentNativeEvidenceResult {
  return {
    kind: 'available',
    trajectory: {
      schema_version: 'ATIF-v1.8',
      ...(options.omitSession === true
        ? {}
        : { session_id: 'canonical-session' }),
      agent: { name: 'claude-code', version: 'test', model_name: 'sonnet' },
      steps: [
        { step_id: 1, source: 'user', message: 'Create greeting.txt' },
        { step_id: 2, source: 'agent', message: `done with ${SECRET}` },
      ],
    },
    source: {
      kind: options.adapterFallback === true ? 'driver_fallback' : 'native_log',
      format:
        options.adapterFallback === true
          ? 'forge-driver-turns'
          : 'claude-code-jsonl',
      ...(options.omitSession === true
        ? {}
        : { sessionId: 'canonical-session' }),
    },
    warnings: [],
  } as AgentNativeEvidenceResult;
}

function resolvedPlan(): ResolvedRunPlanV1 {
  const agent = {
    adapter: 'claude-code',
    provider: 'anthropic',
    model: 'sonnet',
  };
  const checks = {
    files_created: ['greeting.txt'],
    file_checks: [{ file: 'greeting.txt', exists: true, contains: 'hello' }],
    tool_call_checks: [
      {
        tool: 'NeverCalled',
        label: 'telemetry',
        requirement_level: 'OPTIONAL' as const,
      },
    ],
  };
  return {
    selection: {
      case_id: 'sample/case',
      treatment: 'baseline',
      agent,
      repetition: 0,
    },
    provenance: {
      dataset: { id: 'sample', version: '1' },
      experiment: { id: 'local', version: '1' },
      case: { id: 'sample/case', path: 'cases/case.yaml' },
      forge: { ...FORGE_BUILD_IDENTITY },
    },
    case: {
      id: 'sample/case',
      version: '0.1.0',
      initial_prompt: 'Create greeting.txt',
      execution_mode: 'one_shot',
      setup: [],
      judging_criteria: [],
      checks,
    },
    treatment: { id: 'baseline', setup: [] },
    setup: [],
    interaction: {
      mode: 'one_shot',
      initial_prompt: 'Create greeting.txt',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Create greeting.txt',
      max_turns: 1,
    },
    evaluation: { judging_criteria: [], checks },
    agent,
    runtime: {
      adapter: 'docker',
      image: { kind: 'forge' },
      platform: 'linux/amd64',
      resources: {
        memory_bytes: 4 * 1024 * 1024 * 1024,
        cpu_count: 2,
        process_count: 512,
      },
    },
    limits: { run_timeout_ms: 30_000 },
  };
}

function recordingStore(
  delegate: RunArtifactStore,
  calls: string[],
): RunArtifactStore {
  return {
    async begin(runId) {
      calls.push('artifact:begin');
      const transaction = await delegate.begin(runId);
      return {
        async write(artifact) {
          calls.push(`artifact:write:${artifact.path}`);
          await transaction.write(artifact);
        },
        async commit(result) {
          calls.push('artifact:commit');
          return transaction.commit(result);
        },
        rollback: () => transaction.rollback(),
      };
    },
  };
}

function inertStore(): RunArtifactStore {
  return {
    async begin() {
      throw new Error('artifact store must not be reached');
    },
  };
}

function inertCommandRunner() {
  const runner = {
    async run() {
      if (this !== runner)
        throw new Error('Command runner receiver was not preserved.');
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
      };
    },
  };
  return runner;
}

function inertInputProvider(): RunInputProvider {
  return {
    async inspect() {
      throw new Error('input provider must not be reached');
    },
    async read() {
      throw new Error('input provider must not be reached');
    },
    async listFiles() {
      throw new Error('input provider must not be reached');
    },
  };
}

function monotonicClock(): () => Date {
  let milliseconds = Date.parse('2026-09-15T00:00:00.000Z');
  return () => new Date(milliseconds++);
}
