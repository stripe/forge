import type {
  AgentAdapter,
  AgentEvidenceContext,
  AgentNativeEvidenceResult,
  AgentRuntimeRequirements,
  AgentTurn,
} from '../contracts/agent.js';
import type {
  CommittedRun,
  RunArtifact,
  RunArtifactStore,
  RunArtifactTransaction,
} from '../contracts/artifacts.js';
import {
  CommandExecutionError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from '../contracts/command.js';
import type {
  CredentialScope,
  CredentialReference,
  CredentialResolver,
  ResolvedEnvironment,
} from '../contracts/credentials.js';
import type {
  PreparedRuntime,
  RuntimeAdapter,
  RuntimePreparation,
  SealedRuntime,
} from '../contracts/runtime.js';
import type {TestFileContents} from './memoryWorkspace.js';
import {
  createMemoryWorkspace,
  type MemoryWorkspaceFixture,
} from './memoryWorkspace.js';

export interface StaticCredentialResolverOptions {
  readonly onResolve?: (
    reference: CredentialReference,
    purpose: string,
  ) => void;
}

/** Explicit test-only credential resolver; unknown references fail closed. */
export function createStaticCredentialResolver(
  values: Readonly<Record<string, string>> = {},
  options: StaticCredentialResolverOptions = {},
): CredentialResolver {
  const snapshot = new Map(Object.entries(values));
  const resolver: CredentialResolver = {
    async resolve(reference, context) {
      context.signal.throwIfAborted();
      options.onResolve?.(reference, context.purpose);
      const value = snapshot.get(reference);
      if (value === undefined) {
        throw new Error(`No test credential is defined for ${reference}.`);
      }
      return value;
    },
  };
  return Object.freeze(resolver);
}

export interface MemoryStoredRun {
  readonly runId: string;
  readonly location: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly artifacts: ReadonlyMap<string, RunArtifact>;
}

export interface MemoryArtifactStoreFixture {
  readonly store: RunArtifactStore;
  readonly runs: ReadonlyMap<string, MemoryStoredRun>;
  readonly events: string[];
}

/** Transactional artifact-store double with observable stage/commit ordering. */
export function createMemoryArtifactStore(): MemoryArtifactStoreFixture {
  const runs = new Map<string, MemoryStoredRun>();
  const active = new Set<string>();
  const events: string[] = [];

  const store: RunArtifactStore = {
    async begin(runId: string): Promise<RunArtifactTransaction> {
      if (!runId || runs.has(runId) || active.has(runId)) {
        throw new Error(`Test artifact run already exists: ${runId}`);
      }
      active.add(runId);
      events.push(`begin:${runId}`);
      const artifacts = new Map<string, RunArtifact>();
      let closed = false;

      return {
        async write(artifact: RunArtifact): Promise<void> {
          assertTransactionOpen(closed);
          if (artifacts.has(artifact.path)) {
            throw new Error(`Duplicate test artifact: ${artifact.path}`);
          }
          artifacts.set(artifact.path, copyArtifact(artifact));
          events.push(`write:${runId}:${artifact.path}`);
        },
        async commit(
          result: Readonly<Record<string, unknown>>,
        ): Promise<CommittedRun> {
          assertTransactionOpen(closed);
          closed = true;
          active.delete(runId);
          const location = `memory://forge/runs/${encodeURIComponent(runId)}`;
          const stored: MemoryStoredRun = Object.freeze({
            runId,
            location,
            result: cloneJsonRecord(result),
            artifacts: new Map(
              [...artifacts].map(([artifactPath, artifact]) => [
                artifactPath,
                copyArtifact(artifact),
              ]),
            ),
          });
          runs.set(runId, stored);
          events.push(`commit:${runId}`);
          return {
            runId,
            location,
            result: cloneJsonRecord(stored.result),
          };
        },
        async rollback(): Promise<void> {
          if (closed) return;
          closed = true;
          active.delete(runId);
          artifacts.clear();
          events.push(`rollback:${runId}`);
        },
      };
    },
  };

  return Object.freeze({store, runs, events});
}

export interface ScriptedAgentOptions {
  readonly id?: string;
  readonly version?: string;
  readonly turns?: readonly AgentTurn[];
  readonly requirements?: AgentRuntimeRequirements;
  readonly evidence?:
    | AgentNativeEvidenceResult
    | ((context: AgentEvidenceContext) => Promise<AgentNativeEvidenceResult>);
}

export interface ScriptedAgentFixture {
  readonly adapter: AgentAdapter;
  readonly messages: string[];
  readonly events: string[];
}

/** Stateful coding-agent double which returns one scripted response per send. */
export function createScriptedAgentAdapter(
  options: ScriptedAgentOptions = {},
): ScriptedAgentFixture {
  const id = options.id ?? 'test-agent';
  const version = options.version ?? '1';
  const turns = (options.turns ?? [
    {
      text: 'Completed the requested task.',
      sessionId: 'test-session',
      toolCalls: [],
    },
  ]).map(copyAgentTurn);
  const requirements = options.requirements ?? {
    executables: [],
    environment: {},
    stateDirectories: [],
  };
  const messages: string[] = [];
  const events: string[] = [];
  let nextTurn = 0;

  const adapter: AgentAdapter = {
    id,
    version,
    requirements(selection) {
      if (selection.adapter !== id) {
        throw new TypeError(
          `Scripted agent ${id} cannot serve adapter ${selection.adapter}.`,
        );
      }
      return requirements;
    },
    evidenceIdentity(selection) {
      if (selection.adapter !== id) {
        throw new TypeError(
          `Scripted agent ${id} cannot serve adapter ${selection.adapter}.`,
        );
      }
      return {name: id, version};
    },
    async prepare(): Promise<void> {
      events.push('prepare');
    },
    async openSession() {
      events.push('open-session');
      let sessionId: string | undefined;
      return {
        sessionId: () => sessionId,
        async send(message, sendOptions) {
          sendOptions.signal.throwIfAborted();
          const turn = turns[nextTurn];
          if (!turn) throw new Error('Scripted agent has no remaining turn.');
          nextTurn += 1;
          messages.push(message);
          events.push(`send:${nextTurn}`);
          sessionId = turn.sessionId;
          return copyAgentTurn(turn);
        },
      };
    },
    async collectEvidence(context) {
      context.signal.throwIfAborted();
      events.push('collect-evidence');
      if (typeof options.evidence === 'function') {
        return options.evidence(context);
      }
      if (options.evidence !== undefined) return options.evidence;
      return {
        kind: 'unavailable',
        reason: {
          code: 'source_unavailable',
          message: 'The scripted agent has no native evidence.',
        },
      };
    },
  };

  return Object.freeze({adapter: Object.freeze(adapter), messages, events});
}

export type TestCommandScope = 'uncredentialed' | 'setup' | 'agent';

export interface RecordedTestCommand {
  readonly scope: TestCommandScope;
  readonly credentialEnvironmentNames: readonly string[];
  readonly argv: readonly string[];
  readonly options: CommandOptions;
}

export type TestCommandHandler = (
  command: RecordedTestCommand,
) => CommandResult | Promise<CommandResult>;

export interface FakeRuntimeAdapterOptions {
  readonly id?: string;
  readonly initialFiles?: Readonly<Record<string, TestFileContents>>;
  readonly stateFiles?: Readonly<
    Record<string, Readonly<Record<string, TestFileContents>>>
  >;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly command?: TestCommandHandler;
}

export interface FakeRuntimeRun {
  readonly input: RuntimePreparation;
  readonly workspace: MemoryWorkspaceFixture;
  readonly stateDirectories: ReadonlyMap<string, MemoryWorkspaceFixture>;
  readonly commands: RecordedTestCommand[];
  readonly events: string[];
  readonly prepared: PreparedRuntime;
}

export interface FakeRuntimeAdapterFixture {
  readonly adapter: RuntimeAdapter;
  readonly runs: readonly FakeRuntimeRun[];
}

/** In-memory runtime double with the same prepare -> quiesce -> dispose states. */
export function createFakeRuntimeAdapter(
  options: FakeRuntimeAdapterOptions = {},
): FakeRuntimeAdapterFixture {
  const id = options.id ?? 'forge/docker';
  const runs: FakeRuntimeRun[] = [];

  const adapter: RuntimeAdapter = {
    id,
    preflight() {},
    async prepare(input): Promise<PreparedRuntime> {
      input.signal.throwIfAborted();
      const workspace = createMemoryWorkspace(options.initialFiles);
      const states = new Map<string, MemoryWorkspaceFixture>();
      for (const requirement of input.requirements.stateDirectories) {
        if (states.has(requirement.id)) {
          throw new TypeError(
            `Duplicate runtime state requirement: ${requirement.id}`,
          );
        }
        states.set(
          requirement.id,
          createMemoryWorkspace(options.stateFiles?.[requirement.id]),
        );
      }
      const commands: RecordedTestCommand[] = [];
      const events: string[] = ['prepare'];
      let setupFinalized = false;
      let quiesced = false;
      let disposed = false;
      let sealedRuntime: SealedRuntime | undefined;

      const commandRunner = (
        scope: TestCommandScope,
        credentialEnvironmentNames: readonly string[] = [],
      ): CommandRunner => {
        const selectedCredentialEnvironmentNames = Object.freeze([
          ...credentialEnvironmentNames,
        ]);
        const runner: CommandRunner = {
          async run(argv, commandOptions = {}) {
            if (quiesced || disposed) {
              throw new CommandExecutionError(
                'Fake runtime command runner is closed.',
                'command_runner_closed',
              );
            }
            if (setupFinalized && scope !== 'agent') {
              throw new CommandExecutionError(
                'Fake runtime setup command runner is finalized.',
                'command_runner_closed',
              );
            }
            commandOptions.signal?.throwIfAborted();
            const command: RecordedTestCommand = Object.freeze({
              scope,
              credentialEnvironmentNames: selectedCredentialEnvironmentNames,
              argv: Object.freeze([...argv]),
              options: Object.freeze({...commandOptions}),
            });
            commands.push(command);
            events.push(`command:${scope}`);
            const result = await (options.command?.(command) ?? {
              stdout: '',
              stderr: '',
              exitCode: 0,
              durationMs: 0,
            });
            emitStdoutLines(result.stdout, commandOptions.onStdoutLine);
            return {...result};
          },
        };
        return Object.freeze(runner);
      };

      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        quiesced = true;
        workspace.seal();
        for (const state of states.values()) state.seal();
        events.push('dispose');
      };

      const prepared: PreparedRuntime = Object.freeze({
        runtimeId: input.runId,
        workspace: workspace.mutable,
        paths: Object.freeze({workspace: '/workspace', home: '/home/forge'}),
        stateDirectories: new Map(
          [...states].map(([stateId, state]) => [stateId, state.mutable]),
        ),
        commands: Object.freeze({
          uncredentialed: commandRunner('uncredentialed'),
          setup: (credentialEnvironmentNames: readonly string[]) =>
            commandRunner(
              'setup',
              validateCredentialProjection(
                input.environment,
                'setup',
                credentialEnvironmentNames,
              ),
            ),
          agent: commandRunner(
            'agent',
            credentialEnvironmentNamesForScope(input.environment, 'agent'),
          ),
        }),
        async finalizeSetup(): Promise<void> {
          if (quiesced || disposed || setupFinalized) {
            throw new Error('Fake runtime setup cannot be finalized.');
          }
          setupFinalized = true;
          for (const requirement of input.requirements.stateDirectories) {
            if (requirement.sealAfterSetup) states.get(requirement.id)?.seal();
          }
          events.push('finalizeSetup');
        },
        async quiesce(): Promise<SealedRuntime> {
          if (disposed && sealedRuntime === undefined) {
            throw new Error('Fake runtime was disposed before quiescence.');
          }
          if (sealedRuntime !== undefined) return sealedRuntime;
          quiesced = true;
          workspace.seal();
          for (const state of states.values()) state.seal();
          events.push('quiesce');
          sealedRuntime = Object.freeze({
            runtimeId: input.runId,
            workspace: workspace.readonly,
            paths: Object.freeze({workspace: '/workspace', home: '/home/forge'}),
            stateDirectories: new Map(
              [...states].map(([stateId, state]) => [stateId, state.readonly]),
            ),
            metadata: Object.freeze({
              adapter: id,
              ...(options.metadata ?? {}),
            }),
          });
          return sealedRuntime;
        },
        dispose,
      });
      const run: FakeRuntimeRun = Object.freeze({
        input,
        workspace,
        stateDirectories: states,
        commands,
        events,
        prepared,
      });
      runs.push(run);
      return prepared;
    },
  };

  return Object.freeze({adapter: Object.freeze(adapter), runs});
}

function validateCredentialProjection(
  environment: ResolvedEnvironment,
  scope: CredentialScope,
  input: readonly string[],
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError('Credential environment names must be an array.');
  }
  const names = new Set<string>();
  for (const name of input) {
    if (typeof name !== 'string' || names.has(name)) {
      throw new TypeError('Credential environment names must be unique strings.');
    }
    const binding = Object.hasOwn(environment.credentials, name)
      ? environment.credentials[name]
      : undefined;
    if (!binding?.scopes.includes(scope)) {
      throw new TypeError(
        `Credential environment variable ${JSON.stringify(name)} is not available in ${scope} scope.`,
      );
    }
    names.add(name);
  }
  return Object.freeze([...names]);
}

function credentialEnvironmentNamesForScope(
  environment: ResolvedEnvironment,
  scope: CredentialScope,
): readonly string[] {
  return Object.freeze(
    Object.entries(environment.credentials)
      .filter(([, binding]) => binding.scopes.includes(scope))
      .map(([name]) => name)
      .sort(compareCodeUnits),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyAgentTurn(turn: AgentTurn): AgentTurn {
  return {
    text: turn.text,
    sessionId: turn.sessionId,
    toolCalls: turn.toolCalls.map((toolCall) => ({...toolCall})),
    ...(turn.costUsd === undefined ? {} : {costUsd: turn.costUsd}),
  };
}

function copyArtifact(artifact: RunArtifact): RunArtifact {
  return Object.freeze({
    path: artifact.path,
    mediaType: artifact.mediaType,
    body: Uint8Array.from(artifact.body),
    ...(artifact.sensitivity === undefined
      ? {}
      : {sensitivity: artifact.sensitivity}),
  });
}

function cloneJsonRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return structuredClone(value) as Readonly<Record<string, unknown>>;
}

function assertTransactionOpen(closed: boolean): void {
  if (closed) throw new Error('Test artifact transaction is closed.');
}

function emitStdoutLines(
  stdout: string,
  listener: ((line: string) => void) | undefined,
): void {
  if (!listener || stdout.length === 0) return;
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) listener(line);
}
