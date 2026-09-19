import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import type {
  AgentAdapter,
  AgentNativeEvidenceResult,
} from '../contracts/agent.js';
import type {
  RunArtifactStore,
  RunArtifactTransaction,
} from '../contracts/artifacts.js';
import type {ForgeComposition} from '../contracts/composition.js';
import {credentialReference} from '../contracts/credentials.js';
import type {RunInputProvider} from '../contracts/inputs.js';
import type {
  PreparedRuntime,
  RuntimeAdapter,
  SealedRuntime,
} from '../contracts/runtime.js';
import type {ResolvedRunPlanV1} from '../model/types.js';
import {createArtifactStore, verifyCompletedRun} from '../results/index.js';
import {createOwnedWorkspace} from '../runtime/workspace.js';
import {createSetupExecutorWithHandlers} from '../setup/executor.js';
import type {
  SetupExecutionContext,
  SetupStepHandler,
} from '../setup/types.js';
import {ForgeExecutionError} from './errors.js';
import {
  executeEval,
  executeEvalWithTestHooks,
  preflightEval,
} from './execute.js';

const roots: string[] = [];
const SECRET = 'sk-ant-test-secret-value';
const RAW_NATIVE_SESSION = `{"type":"system","credential":"${SECRET}"}\n`;
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, {recursive: true, force: true}),
    ),
  );
});

describe('executeEval', () => {
  it('runs the shared lifecycle, redacts credentials, and atomically commits', async () => {
    const fixture = await executionFixture({nativeArtifact: true});
    const localStore = createArtifactStore({
      root: path.join(fixture.root, 'artifacts'),
    });
    const composition = fixture.composition(recordingStore(localStore, fixture.calls));

    const completed = await executeEval({
      runId: 'run-1',
      plan: fixture.plan,
      composition,
      now: monotonicClock(),
    });

    expect(completed.result).toMatchObject({
      schema_version: 1,
      run_id: 'run-1',
      agent: {session_id: 'canonical-session'},
      evidence: {
        redaction_count: 1,
        completeness: 'complete',
        provenance: {
          source: {
            kind: 'native_log',
            format: 'claude-code-jsonl',
            session_id: 'canonical-session',
          },
          adapter: {id: 'claude-code', version: 'test-adapter'},
        },
      },
      supplemental_artifacts: [
        {
          path: 'native/claude-code/session.jsonl',
          media_type: 'application/x-ndjson',
          sensitivity: 'restricted',
        },
      ],
      evaluation: {status: 'passed', score: 0},
    });
    expect(fixture.calls).toEqual([
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
    expect(verified.result).toMatchObject({
      schema_version: 1,
      evidence: {
        provenance: {
          source: {kind: 'native_log', format: 'claude-code-jsonl'},
          adapter: {id: 'claude-code', version: 'test-adapter'},
        },
      },
    });
    expect(verified.result.evaluation.checks).toEqual([
      {name: 'file_created: greeting.txt', passed: true},
      {name: 'file_exists: greeting.txt', passed: true},
      {name: 'file_contains: greeting.txt /hello/', passed: true},
    ]);
    const trajectory = await fs.readFile(
      path.join(completed.location, 'trajectory.json'),
      'utf8',
    );
    expect(trajectory).toContain('[REDACTED]');
    expect(trajectory).not.toContain(SECRET);
    const nativePath = path.join(
      completed.location,
      'native/claude-code/session.jsonl',
    );
    expect(await fs.readFile(nativePath, 'utf8')).toBe(RAW_NATIVE_SESSION);
    expect((await fs.stat(nativePath)).mode & 0o777).toBe(0o600);
  });

  it('omits standalone evaluation and empty workspace evidence artifacts', async () => {
    const emptyCheckVariants: Array<
      readonly [
        string,
        ResolvedRunPlanV1['evaluation']['checks'],
      ]
    > = [
      ['omitted', undefined],
      ['empty', {files_created: [], file_checks: []}],
    ];
    for (const [suffix, emptyChecks] of emptyCheckVariants) {
      const fixture = await executionFixture();
      const caseWithoutChecks = {...fixture.plan.case};
      delete caseWithoutChecks.checks;
      const evalCase =
        emptyChecks === undefined
          ? caseWithoutChecks
          : {...caseWithoutChecks, checks: emptyChecks};
      const plan: ResolvedRunPlanV1 = {
        ...fixture.plan,
        case: evalCase,
        evaluation: {
          success_guidelines: [],
          ...(emptyChecks === undefined ? {} : {checks: emptyChecks}),
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

      expect(completed.result.evaluation).toMatchObject({status: 'passed', score: 0});
      expect(completed.result.artifacts.map(({path: artifactPath}) => artifactPath)).toEqual([
        'plan.json',
        'setup.json',
        'trajectory.json',
        'interaction.json',
      ]);
      await expect(verifyCompletedRun(completed.location)).resolves.toMatchObject({
        runId: `run-minimal-artifacts-${suffix}`,
      });
    }
  });

  it('rejects adapter-produced fallback evidence', async () => {
    const fixture = await executionFixture({adapterFallbackEvidence: true});

    await expect(
      executeEval({
        runId: 'run-bad-evidence',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      }),
    ).rejects.toMatchObject({code: 'evidence_failed', phase: 'evidence'});
    expect(fixture.calls).not.toContain('artifact:begin');
    expect(fixture.calls.at(-1)).toBe('runtime:dispose');
  });

  it('rejects completed evidence without exact session provenance', async () => {
    const fixture = await executionFixture({omitEvidenceSession: true});

    await expect(
      executeEval({
        runId: 'run-unowned-evidence',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      }),
    ).rejects.toMatchObject({code: 'evidence_failed', phase: 'evidence'});
    expect(fixture.calls).not.toContain('artifact:begin');
    expect(fixture.calls.at(-1)).toBe('runtime:dispose');
  });

  it('rejects a native artifact for a different session before staging', async () => {
    const fixture = await executionFixture({
      nativeArtifact: true,
      nativeArtifactSessionId: 'other-session',
    });

    await expect(
      executeEval({
        runId: 'run-mismatched-native-artifact',
        plan: fixture.plan,
        composition: fixture.composition(inertStore()),
        now: monotonicClock(),
      }),
    ).rejects.toMatchObject({code: 'evidence_failed', phase: 'evidence'});
    expect(fixture.calls).not.toContain('artifact:begin');
    expect(fixture.calls.at(-1)).toBe('runtime:dispose');
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
        createArtifactStore({root: path.join(fixture.root, 'native-fallback')}),
      ),
      now: monotonicClock(),
    });

    expect(completed.result.evidence).toMatchObject({
      completeness: 'fallback',
      provenance: {source: {kind: 'driver_fallback'}},
    });
    expect(
      await fs.readFile(
        path.join(
          completed.location,
          'native/claude-code/session.jsonl',
        ),
        'utf8',
      ),
    ).toBe(RAW_NATIVE_SESSION);
    await expect(verifyCompletedRun(completed.location)).resolves.toMatchObject({
      runId: 'run-native-fallback',
    });
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
    await expect(rejected).rejects.toMatchObject({
      code: 'artifact_failed',
      phase: 'artifact_stage',
    });
    expect(rollbacks).toBe(1);
    expect(fixture.calls.slice(-2)).toEqual([
      'artifact:rollback',
      'runtime:dispose',
    ]);
  });

  it('classifies session startup failures as agent failures', async () => {
    const fixture = await executionFixture({openSessionFailure: true});

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
    expect(captured).toBeInstanceOf(ForgeExecutionError);
    expect(captured).toMatchObject({code: 'agent_failed', phase: 'interaction'});
    expect(fixture.calls.at(-1)).toBe('runtime:dispose');
  });

  it('assigns credential scope from a first-party setup capability', async () => {
    const fixture = await executionFixture();
    const step: ResolvedRunPlanV1['setup'][number] = {
      uses: 'forge/command@1',
      with: {argv: ['true']},
    };
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      treatment: {id: fixture.plan.treatment.id, setup: [step]},
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
                  reference: credentialReference('shared.token'),
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
            expect(context.stepIndex).toBe(0);
            expect(context.selection.adapter).toBe('claude-code');
            expect(context.paths.workspace).toBe('/workspace');
          },
        });
      },
    };
    const localStore = createArtifactStore({
      root: path.join(fixture.root, 'scoped-artifacts'),
    });
    const composition = fixture.composition(localStore);
    const runtime = composition.runtime;

    await executeEvalWithTestHooks(
      {
        runId: 'run-scoped-credentials',
        plan,
        composition: {
          ...composition,
          runtime: {
            ...runtime,
            async prepare(input) {
              expect(input.environment.credentials.ANTHROPIC_API_KEY?.scopes).toEqual([
                'agent',
              ]);
              expect(input.environment.credentials.SETUP_TOKEN?.scopes).toEqual([
                'setup',
              ]);
              expect(input.environment.credentials.SERVICE_TOKEN?.scopes).toEqual([
                'agent',
              ]);
              expect(input.environment.credentials.SHARED_TOKEN?.scopes).toEqual([
                'setup',
                'agent',
              ]);
              return runtime.prepare(input);
            },
          },
        },
        now: monotonicClock(),
      },
      {
        setupExecutor: createSetupExecutorWithHandlers(
          new Map([[handler.uses, handler]]),
        ),
      },
    );
  });

  for (const [description, credential] of [
    ['an unescaped credential', SECRET],
    ['a JSON-escaped credential', 'sk-ant-test-"quoted"\\value'],
  ] as const) {
    it(`rejects a setup resolution containing ${description} before interaction`, async () => {
      const fixture = await executionFixture({credentialValue: credential});
      const step: ResolvedRunPlanV1['setup'][number] = {
        uses: 'forge/command@1',
        with: {argv: ['true']},
      };
      const plan: ResolvedRunPlanV1 = {
        ...fixture.plan,
        treatment: {id: fixture.plan.treatment.id, setup: [step]},
        setup: [step],
      };
      const handler: SetupStepHandler = {
        uses: step.uses,
        preflight() {
          return {
            requirements: {},
            async apply() {
              return {leaked: credential};
            },
          };
        },
      };

      await expect(
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
      ).rejects.toMatchObject({code: 'setup_failed', phase: 'setup'});
      expect(fixture.calls).not.toContain('agent:open');
      expect(fixture.calls.at(-1)).toBe('runtime:dispose');
    });
  }

  it('preflights every first-party setup operation before resolving credentials or allocating', async () => {
    const fixture = await executionFixture();
    const step: ResolvedRunPlanV1['setup'][number] = {
      uses: 'forge/command@1',
      with: {argv: ['true']},
    };
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      treatment: {id: fixture.plan.treatment.id, setup: [step]},
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

    await expect(
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
    ).rejects.toMatchObject({code: 'invalid_plan', phase: 'preflight'});
    expect(credentialResolved).toBe(false);
    expect(runtimePrepared).toBe(false);
  });

  it('rejects malformed agent environment declarations during pure preflight', async () => {
    const fixture = await executionFixture();
    const composition = fixture.composition(inertStore());
    const selected = composition.agents.get('claude-code')!;

    for (const environment of [
      [],
      {credential: {TOKEN: {reference: 'unsafe.token'}}},
      {variables: []},
      {variables: null},
      {variables: {'BAD-NAME': 'value'}},
      {variables: {VALID_NAME: 'line-one\nline-two'}},
      {credentials: []},
      {credentials: null},
      {credentials: {TOKEN: {reference: 'unsafe.token', extra: true}}},
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
      expect(() =>
        preflightEval({
          plan: fixture.plan,
          composition: {
            ...composition,
            agents: new Map([[unsafeAgent.id, unsafeAgent]]),
          },
        }),
      ).toThrow(ForgeExecutionError);
    }

    let credentialResolved = false;
    let runtimePrepared = false;
    const unsafeAgent: AgentAdapter = {
      ...selected,
      requirements(selection) {
        return {
          ...selected.requirements(selection),
          environment: {
            credential: {TOKEN: {reference: 'unsafe.token'}},
          },
        } as unknown as ReturnType<AgentAdapter['requirements']>;
      },
    };
    await expect(
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
    ).rejects.toMatchObject({code: 'invalid_plan', phase: 'preflight'});
    expect(credentialResolved).toBe(false);
    expect(runtimePrepared).toBe(false);
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

    await expect(
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
    ).rejects.toMatchObject({code: 'invalid_plan', phase: 'preflight'});
    expect(credentialResolved).toBe(false);
    expect(runtimePrepared).toBe(false);
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
        return {name: 'claude-code\nforged', version: 'test'};
      },
    };

    await expect(
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
    ).rejects.toMatchObject({code: 'invalid_plan', phase: 'preflight'});
    expect(credentialResolved).toBe(false);
    expect(runtimePrepared).toBe(false);
  });
});

async function executionFixture(
  options: {
    openSessionFailure?: boolean;
    adapterFallbackEvidence?: boolean;
    omitEvidenceSession?: boolean;
    nativeArtifact?: boolean;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-execution-test-'));
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
    paths: {workspace: '/workspace', home: '/home/forge'},
    stateDirectories: new Map(),
    metadata: {image: 'sha256:test-image'},
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
    id: 'docker',
    version: '1',
    async prepare(input) {
      calls.push('runtime:prepare');
      expect(input.environment.credentials.ANTHROPIC_API_KEY?.value).toBe(
        credentialValue,
      );
      expect(input.environment.credentials.ANTHROPIC_API_KEY?.scopes).toEqual([
        'agent',
      ]);
      expect(input.requirements.executables).toEqual(['claude']);
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
      return {name: 'claude-code', version: 'test'};
    },
    async prepare(context) {
      expect(Object.keys(context.runtime.commands)).toEqual(['uncredentialed']);
      expect('quiesce' in context.runtime).toBe(false);
      expect('dispose' in context.runtime).toBe(false);
      expect('setup' in context.runtime.commands).toBe(false);
      expect('set' in context.runtime.stateDirectories).toBe(false);
      await context.runtime.commands.uncredentialed.run(['agent-version-check']);
      calls.push('agent:prepare');
    },
    async openSession(context) {
      expect(Object.keys(context.runtime.commands)).toEqual(['agent']);
      expect('quiesce' in context.runtime).toBe(false);
      expect('dispose' in context.runtime).toBe(false);
      expect('setup' in context.runtime.commands).toBe(false);
      expect('set' in context.runtime.stateDirectories).toBe(false);
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
            expect('commands' in context.runtime).toBe(false);
            expect('writeFile' in context.runtime.workspace).toBe(false);
            calls.push(`agent:native:${context.sessionId}`);
            return {
              format: 'claude-code-jsonl',
              sessionId:
                options.nativeArtifactSessionId ?? context.sessionId,
              mediaType: 'application/x-ndjson',
              extension: 'jsonl',
              body: Buffer.from(RAW_NATIVE_SESSION, 'utf8'),
            };
          },
        }
      : {}),
    async collectEvidence(context) {
      expect('commands' in context.runtime).toBe(false);
      expect('dispose' in context.runtime).toBe(false);
      expect('writeFile' in context.runtime.workspace).toBe(false);
      expect('set' in context.runtime.stateDirectories).toBe(false);
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
          : {adapterFallback: options.adapterFallbackEvidence}),
        ...(options.omitEvidenceSession === undefined
          ? {}
          : {omitSession: options.omitEvidenceSession}),
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
  options: {adapterFallback?: boolean; omitSession?: boolean} = {},
): AgentNativeEvidenceResult {
  return {
    kind: 'available',
    trajectory: {
      schema_version: 'ATIF-v1.8',
      ...(options.omitSession === true
        ? {}
        : {session_id: 'canonical-session'}),
      agent: {name: 'claude-code', version: 'test', model_name: 'sonnet'},
      steps: [
        {step_id: 1, source: 'user', message: 'Create greeting.txt'},
        {step_id: 2, source: 'agent', message: `done with ${SECRET}`},
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
        : {sessionId: 'canonical-session'}),
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
    file_checks: [{file: 'greeting.txt', exists: true, contains: 'hello'}],
  };
  return {
    schema_version: 1,
    selection: {
      case_id: 'sample/case',
      treatment: 'baseline',
      agent,
      repetition: 0,
    },
    provenance: {
      dataset: {id: 'sample', version: '1', manifest_sha256: DIGEST_A},
      experiment: {id: 'local', version: '1', sha256: DIGEST_B},
      case: {id: 'sample/case', path: 'cases/case.yaml', sha256: DIGEST_C},
      forge: {version: '0.1.0'},
    },
    case: {
      schema_version: 1,
      id: 'sample/case',
      initial_prompt: 'Create greeting.txt',
      execution_mode: 'one_shot',
      setup: [],
      success_guidelines: [],
      checks,
    },
    treatment: {id: 'baseline', setup: []},
    setup: [],
    interaction: {
      mode: 'one_shot',
      initial_prompt: 'Create greeting.txt',
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: 'Create greeting.txt',
      max_turns: 1,
    },
    evaluation: {success_guidelines: [], checks},
    agent,
    runtime: {
      adapter: 'docker',
      image: {kind: 'forge'},
      platform: 'linux/amd64',
      resources: {
        memory_bytes: 4 * 1024 * 1024 * 1024,
        cpu_count: 2,
        process_count: 512,
      },
    },
    limits: {run_timeout_ms: 30_000},
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
      if (this !== runner) throw new Error('Command runner receiver was not preserved.');
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
