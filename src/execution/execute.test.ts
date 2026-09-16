import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {
  createNormalizedTrajectory,
  type NormalizedTrajectory,
} from '../atif/index.js';
import type {AgentAdapter} from '../contracts/agent.js';
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
import type {SetupStepHandler} from '../setup/types.js';
import {ForgeExecutionError} from './errors.js';
import {executeEval} from './execute.js';

const roots: string[] = [];
const SECRET = 'sk-ant-test-secret-value';
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
    const fixture = await executionFixture();
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
      evaluation: {status: 'passed', score: 0},
    });
    expect(fixture.calls).toEqual([
      'credential:anthropic.api-key',
      'runtime:prepare',
      'agent:prepare',
      'agent:open',
      'agent:send',
      'runtime:quiesce',
      'agent:evidence:canonical-session',
      'artifact:begin',
      'artifact:write:plan.json',
      'artifact:write:trajectory.json',
      'artifact:write:interaction.json',
      'artifact:write:workspace-evidence.json',
      'artifact:write:evaluation.json',
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
  });

  it('rejects evidence provenance that contradicts the selected adapter', async () => {
    const fixture = await executionFixture({evidenceAdapterId: 'other-agent'});

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

  it('assigns credential scope from the declaring capability', async () => {
    const fixture = await executionFixture();
    const step = {uses: 'acme/use-token@1', with: {}} as const;
    const plan: ResolvedRunPlanV1 = {
      ...fixture.plan,
      treatment: {id: fixture.plan.treatment.id, setup: [step]},
      setup: [step],
    };
    const handler: SetupStepHandler = {
      uses: step.uses,
      requirements() {
        return {
          credentials: {
            SETUP_TOKEN: {
              reference: credentialReference('setup.token'),
            },
          },
        };
      },
      async execute() {},
    };
    const localStore = createArtifactStore({
      root: path.join(fixture.root, 'scoped-artifacts'),
    });
    const composition = fixture.composition(localStore);
    const runtime = composition.runtime;

    await executeEval({
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
            return runtime.prepare(input);
          },
        },
        setupHandlers: new Map([[handler.uses, handler]]),
      },
      now: monotonicClock(),
    });
  });

  it('rejects extension-assigned credential scopes before resolving authority', async () => {
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
});

async function executionFixture(
  options: {
    openSessionFailure?: boolean;
    evidenceAdapterId?: string;
    omitEvidenceSession?: boolean;
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
      setup: inertCommandRunner(),
      agent: inertCommandRunner(),
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
      expect(input.environment.credentials.ANTHROPIC_API_KEY?.value).toBe(SECRET);
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
    async collectEvidence(context) {
      expect('commands' in context.runtime).toBe(false);
      expect('dispose' in context.runtime).toBe(false);
      expect('writeFile' in context.runtime.workspace).toBe(false);
      expect('set' in context.runtime.stateDirectories).toBe(false);
      calls.push(`agent:evidence:${context.sessionId}`);
      return normalizedTrajectory(
        {
          ...(options.evidenceAdapterId === undefined
            ? {}
            : {adapterId: options.evidenceAdapterId}),
          ...(options.omitEvidenceSession === undefined
            ? {}
            : {omitSession: options.omitEvidenceSession}),
        },
      );
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
      setupHandlers: new Map(),
      credentialResolver: {
        async resolve(reference) {
          calls.push(`credential:${reference}`);
          return SECRET;
        },
      },
      inputProvider: inertInputProvider(),
      artifactStore,
    }),
  };
}

function normalizedTrajectory(
  options: {adapterId?: string; omitSession?: boolean} = {},
): NormalizedTrajectory {
  return createNormalizedTrajectory({
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
    provenance: {
      source: {
        kind: 'native_log',
        format: 'claude-code-jsonl',
        ...(options.omitSession === true
          ? {}
          : {sessionId: 'canonical-session'}),
      },
      adapter: {
        id: options.adapterId ?? 'claude-code',
        version: 'test-adapter',
      },
    },
    completeness: 'complete',
  });
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
      profile: {id: 'local', version: '1', sha256: DIGEST_B},
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
