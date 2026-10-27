import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'vitest';
import type { CommandResult } from '../contracts/command.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type { AgentPluginInstaller } from '../contracts/plugin.ts';
import type { MutableWorkspace, WorkspaceEntry } from '../contracts/runtime.ts';
import { parseSetupStep } from '../model/parse.ts';
import type { SetupStepV1 } from '../model/types.ts';
import {
  createSetupExecutor,
  createSetupExecutorWithHandlers,
  firstPartySetupHandlers,
} from './executor.ts';
import type {
  PreparedSetupStep,
  SetupApplyContext,
  SetupStepHandler,
  SetupStepRequirements,
} from './types.ts';
import { SetupActionError } from './types.ts';

const setupTarget = Object.freeze({
  selection: Object.freeze({
    adapter: 'test-agent',
    provider: 'test-provider',
    model: 'test-model',
  }),
  runtime: Object.freeze({
    adapter: 'docker' as const,
    image: Object.freeze({ kind: 'forge' as const }),
    platform: 'linux/amd64' as const,
    resources: Object.freeze({
      memory_bytes: 1024,
      cpu_count: 1,
      process_count: 8,
    }),
  }),
});

function result(exitCode = 0): CommandResult {
  return { stdout: '', stderr: '', exitCode, durationMs: 1 };
}

describe('portable setup actions', () => {
  it('applies static actions in source order without exposing agent credentials to setup', async () => {
    const events: string[] = [];
    const writes = new Map<string, Uint8Array>();
    const workspace: MutableWorkspace = {
      async inspect(relativePath): Promise<WorkspaceEntry> {
        return {
          path: relativePath,
          kind: writes.has(relativePath) ? 'file' : 'absent',
        };
      },
      async readFile(relativePath) {
        return writes.get(relativePath) ?? new Uint8Array();
      },
      async listFiles() {
        return [];
      },
      async writeFile(relativePath, body) {
        events.push(`write:${relativePath}`);
        writes.set(relativePath, body);
      },
    };
    const steps: SetupStepV1[] = [
      {
        uses: 'forge/write',
        with: { target: 'notes/inline.txt', source: { content: 'inline' } },
      },
      {
        uses: 'forge/write',
        with: {
          target: 'notes/fixture.txt',
          source: { dataset_path: 'fixtures/source.txt' },
        },
      },
      {
        uses: 'forge/credentials',
        with: { env: ['API_TOKEN'] },
      },
      {
        uses: 'forge/command',
        with: { argv: ['node', '--version'], cwd: '.', timeout_ms: 1234 },
      },
    ];

    const prepared = createSetupExecutor().preflight(steps, setupTarget);
    assert.deepEqual(prepared.requirements.credentials, {
      agent: { API_TOKEN: { reference: 'env:API_TOKEN' } },
    });
    const applied = await prepared.apply({
      runId: 'run-1',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace,
      stateDirectories: new Map(),
      commands: {
        uncredentialed: {
          async run(argv, options) {
            events.push(`command:${argv.join(' ')}`);
            assert.equal(options?.cwd, '.');
            assert.equal(options?.timeoutMs, 1234);
            return result();
          },
        },
        setup() {
          throw new Error(
            'credential-free commands must not use setup credentials',
          );
        },
      },
      inputs: {
        async inspect(datasetPath) {
          return { path: datasetPath, kind: 'file', size: 7 };
        },
        async read(datasetPath) {
          assert.equal(datasetPath, 'fixtures/source.txt');
          return Buffer.from('fixture');
        },
        async listFiles() {
          return [];
        },
      },
      signal: new AbortController().signal,
    });

    assert.deepEqual(events, [
      'write:notes/inline.txt',
      'write:notes/fixture.txt',
      'command:node --version',
    ]);
    assert.deepEqual(applied.steps, [
      { index: 0, uses: 'forge/write' },
      { index: 1, uses: 'forge/write' },
      { index: 2, uses: 'forge/credentials' },
      { index: 3, uses: 'forge/command' },
    ]);
    assert.equal(
      Buffer.from(writes.get('notes/fixture.txt')!).toString(),
      'fixture',
    );
  });

  it('resolves the named plugin and installs through the selected agent capability', async () => {
    const events: string[] = [];
    const pluginState = emptyWorkspace();
    const installer: AgentPluginInstaller = {
      supportsMcpBearerAuth: true,
      preflight(distribution, context) {
        events.push(
          `preflight:${context.selection.adapter}:${distribution.plugin}`,
        );
        return {
          requirements: {
            executables: ['git'],
            stateDirectories: [
              {
                id: 'plugin-state',
                containerPath: '/home/forge/plugin-state',
                sealAfterSetup: true,
              },
            ],
          },
          async install(installContext) {
            assert.deepEqual(
              [...installContext.stateDirectories.keys()],
              ['plugin-state'],
            );
            assert.equal(
              installContext.stateDirectories.get('plugin-state'),
              pluginState,
            );
            assert.equal(
              installContext.stateDirectories.has('unrelated-state'),
              false,
            );
            assert.equal(
              Object.isFrozen(installContext.stateDirectories),
              true,
            );
            assert.equal('set' in installContext.stateDirectories, false);
            events.push('install');
            return {
              adapter: context.selection.adapter,
              plugin: distribution.plugin,
              marketplace: distribution.marketplace,
              marketplace_commit: 'a'.repeat(40),
              native_plugin_id: 'stripe@forge-test',
              version: '1.0.0',
              source: { kind: 'marketplace-path' },
              installed_tree: {
                format: 'forge-plugin-tree-v1',
                sha256: `sha256:${'b'.repeat(64)}`,
                entry_count: 1,
                file_count: 1,
                size_bytes: 1,
              },
            };
          },
        };
      },
    };
    const step = parseSetupStep({
      uses: 'forge/plugin',
      with: { plugin: 'stripe' },
    });
    const prepared = createSetupExecutor().preflight([step], {
      ...setupTarget,
      selection: { ...setupTarget.selection, adapter: 'claude-code' },
      pluginInstaller: installer,
    });
    assert.deepEqual(prepared.requirements, {
      executables: ['git'],
      stateDirectories: [
        {
          id: 'plugin-state',
          containerPath: '/home/forge/plugin-state',
          sealAfterSetup: true,
        },
      ],
    });

    const applied = await prepared.apply({
      runId: 'run-plugin',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace: emptyWorkspace(),
      stateDirectories: new Map([
        ['plugin-state', pluginState],
        ['unrelated-state', emptyWorkspace()],
      ]),
      commands: inertCommandProjections(),
      inputs: emptyInputs(),
      signal: new AbortController().signal,
    });
    assert.deepEqual(events, [
      'preflight:claude-code:stripe@claude-plugins-official',
      'install',
    ]);
    assert.deepEqual(applied.steps, [
      {
        index: 0,
        uses: 'forge/plugin',
        resolution: {
          adapter: 'claude-code',
          plugin: 'stripe@claude-plugins-official',
          marketplace: 'anthropics/claude-plugins-official',
          marketplace_commit: 'a'.repeat(40),
          native_plugin_id: 'stripe@forge-test',
          version: '1.0.0',
          source: { kind: 'marketplace-path' },
          installed_tree: {
            format: 'forge-plugin-tree-v1',
            sha256: `sha256:${'b'.repeat(64)}`,
            entry_count: 1,
            file_count: 1,
            size_bytes: 1,
          },
        },
      },
    ]);
  });

  for (const adapter of ['claude-code', 'codex'] as const) {
    it(`selects the compatible Stripe distribution and agent credentials for ${adapter}`, () => {
      const step = parseSetupStep({
        uses: 'forge/plugin',
        with: { plugin: 'stripe' },
      });
      const target = {
        ...setupTarget,
        selection: { ...setupTarget.selection, adapter },
      };
      const installer: AgentPluginInstaller = {
        supportsMcpBearerAuth: true,
        preflight(distribution, context) {
          assert.deepEqual(distribution, {
            plugin: 'stripe@claude-plugins-official',
            marketplace: 'anthropics/claude-plugins-official',
          });
          assert.deepEqual(context.mcpServers, ['stripe']);
          return {
            requirements: { executables: [], stateDirectories: [] },
            async install() {
              throw new Error('preflight must not install');
            },
          };
        },
      };
      const prepared = createSetupExecutor().preflight([step], {
        ...target,
        pluginInstaller: installer,
      });
      assert.equal(prepared.requirements.credentials, undefined);
      const augmented = createSetupExecutor().preflight(
        [
          step,
          parseSetupStep({
            uses: 'forge/credentials',
            with: { env: ['STRIPE_API_KEY', 'API_TOKEN'] },
          }),
        ],
        { ...target, pluginInstaller: installer },
      );
      assert.deepEqual(augmented.requirements.credentials, {
        agent: {
          STRIPE_API_KEY: { reference: 'env:STRIPE_API_KEY' },
          API_TOKEN: { reference: 'env:API_TOKEN' },
        },
      });
      assert.throws(
        () =>
          createSetupExecutor().preflight([step], {
            ...target,
            pluginInstaller: { preflight: installer.preflight },
          }),
        /does not support plugin MCP bearer authentication/,
      );
    });
  }

  it('rejects unsupported agents and missing installers in preflight', () => {
    const step = parseSetupStep({
      uses: 'forge/plugin',
      with: { plugin: 'stripe' },
    });
    assert.throws(
      () => createSetupExecutor().preflight([step], setupTarget),
      /does not support agent/,
    );
    assert.throws(
      () =>
        createSetupExecutor().preflight([step], {
          ...setupTarget,
          selection: { ...setupTarget.selection, adapter: 'codex' },
        }),
      /does not support forge\/plugin/,
    );
  });

  it('preflights all handlers before performing mutations', async () => {
    let mutated = false;
    const mutatingHandler: SetupStepHandler = {
      uses: 'acme/mutate',
      preflight() {
        return {
          requirements: {},
          async apply() {
            mutated = true;
          },
        };
      },
    };
    const executor = createSetupExecutorWithHandlers(
      new Map([[mutatingHandler.uses, mutatingHandler]]),
    );
    const steps: SetupStepV1[] = [
      { uses: mutatingHandler.uses, with: {} } as unknown as SetupStepV1,
      { uses: 'example/missing', with: {} } as unknown as SetupStepV1,
    ];
    assert.throws(
      () => executor.preflight(steps, setupTarget),
      /No setup handler/,
    );
    assert.equal(mutated, false);
  });

  it('binds setup and agent requirements during one pure preflight', async () => {
    const events: string[] = [];
    const handler: SetupStepHandler = {
      uses: 'acme/configure',
      preflight(_step, context) {
        assert.equal(Object.isFrozen(context.selection), true);
        assert.equal(Object.isFrozen(context.runtime), true);
        assert('resources' in context.runtime);
        assert.equal(Object.isFrozen(context.runtime.resources), true);
        events.push(
          `preflight:${context.stepIndex}:${context.selection.adapter}:${context.runtime.platform}`,
        );
        return {
          requirements: {
            variables: { FEATURE_MODE: 'enabled' },
            credentials: {
              setup: {
                PACKAGE_TOKEN: {
                  reference: credentialReference('acme.package-token'),
                },
              },
              agent: {
                SERVICE_TOKEN: {
                  reference: credentialReference('acme.service-token'),
                },
              },
            },
          },
          async apply(applyContext) {
            events.push(
              `apply:${applyContext.stepIndex}:${applyContext.selection.adapter}:${applyContext.paths.workspace}`,
            );
            await applyContext.commands.run(['configure']);
          },
        };
      },
    };
    const prepared = createSetupExecutorWithHandlers(
      new Map([[handler.uses, handler]]),
    ).preflight(
      [{ uses: handler.uses, with: {} } as unknown as SetupStepV1],
      setupTarget,
    );

    assert.deepEqual(prepared.requirements, {
      variables: { FEATURE_MODE: 'enabled' },
      credentials: {
        setup: {
          PACKAGE_TOKEN: { reference: 'acme.package-token' },
        },
        agent: {
          SERVICE_TOKEN: { reference: 'acme.service-token' },
        },
      },
    });
    assert.equal(Object.isFrozen(prepared.requirements), true);

    await prepared.apply({
      runId: 'run-requirements',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace: emptyWorkspace(),
      stateDirectories: new Map(),
      commands: {
        uncredentialed: {
          async run() {
            throw new Error('credentialed setup must use the setup projection');
          },
        },
        setup(credentialEnvironmentNames) {
          assert.deepEqual(credentialEnvironmentNames, ['PACKAGE_TOKEN']);
          return {
            async run() {
              events.push('command:setup');
              return result();
            },
          };
        },
      },
      inputs: emptyInputs(),
      signal: new AbortController().signal,
    });

    assert.deepEqual(events, [
      'preflight:0:test-agent:linux/amd64',
      'apply:0:test-agent:/workspace',
      'command:setup',
    ]);
    await assert.rejects(
      prepared.apply({
        runId: 'run-requirements-repeated',
        paths: { workspace: '/workspace', home: '/home/forge' },
        workspace: emptyWorkspace(),
        stateDirectories: new Map(),
        commands: inertCommandProjections(),
        inputs: emptyInputs(),
        signal: new AbortController().signal,
      }),
      /already been applied/,
    );
  });

  it('rejects conflicting setup and agent credential references during preflight', () => {
    const handler: SetupStepHandler = {
      uses: 'acme/conflict',
      preflight() {
        return {
          requirements: {
            credentials: {
              setup: {
                SHARED_TOKEN: { reference: credentialReference('setup-token') },
              },
              agent: {
                SHARED_TOKEN: { reference: credentialReference('agent-token') },
              },
            },
          },
          async apply() {},
        };
      },
    };

    assert.throws(
      () =>
        createSetupExecutorWithHandlers(
          new Map([[handler.uses, handler]]),
        ).preflight(
          [{ uses: handler.uses, with: {} } as unknown as SetupStepV1],
          setupTarget,
        ),
      /conflicting references/,
    );
  });

  it('projects only the setup credentials declared by each prepared step', async () => {
    const projections: Array<{
      credentialEnvironmentNames: readonly string[];
      argv: readonly string[];
    }> = [];
    const handler: SetupStepHandler = {
      uses: 'acme/install',
      preflight(step) {
        const payload = step.with as unknown as Readonly<{
          credential_name: string;
          credential_reference: string;
          scope?: 'setup' | 'agent';
        }>;
        const credentialName = payload.credential_name;
        return {
          requirements: {
            credentials: {
              [payload.scope ?? 'setup']: {
                [credentialName]: {
                  reference: credentialReference(payload.credential_reference),
                },
              },
            },
          },
          async apply(context) {
            await context.commands.run(['install', credentialName]);
          },
        };
      },
    };
    const prepared = createSetupExecutorWithHandlers(
      new Map([[handler.uses, handler]]),
    ).preflight(
      [
        {
          uses: handler.uses,
          with: {
            credential_name: 'TOKEN_A',
            credential_reference: 'acme.token-a',
          },
        } as unknown as SetupStepV1,
        {
          uses: handler.uses,
          with: {
            credential_name: 'TOKEN_B',
            credential_reference: 'acme.token-b',
          },
        } as unknown as SetupStepV1,
        {
          uses: handler.uses,
          with: {
            credential_name: 'TOKEN_C',
            credential_reference: 'acme.token-c',
            scope: 'agent',
          },
        } as unknown as SetupStepV1,
      ],
      setupTarget,
    );

    await prepared.apply({
      runId: 'run-projected-credentials',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace: emptyWorkspace(),
      stateDirectories: new Map(),
      commands: {
        uncredentialed: {
          async run(argv) {
            assert.deepEqual(argv, ['install', 'TOKEN_C']);
            projections.push({
              credentialEnvironmentNames: [],
              argv: [...argv],
            });
            return result();
          },
        },
        setup(credentialEnvironmentNames) {
          const selected = Object.freeze([...credentialEnvironmentNames]);
          return {
            async run(argv) {
              projections.push({
                credentialEnvironmentNames: selected,
                argv: Object.freeze([...argv]),
              });
              return result();
            },
          };
        },
      },
      inputs: emptyInputs(),
      signal: new AbortController().signal,
    });

    assert.deepEqual(projections, [
      { credentialEnvironmentNames: ['TOKEN_A'], argv: ['install', 'TOKEN_A'] },
      { credentialEnvironmentNames: ['TOKEN_B'], argv: ['install', 'TOKEN_B'] },
      { credentialEnvironmentNames: [], argv: ['install', 'TOKEN_C'] },
    ]);
  });

  it('binds prepared operations to an immutable setup-step snapshot', async () => {
    const inputStep = {
      uses: 'acme/capture',
      with: { value: 'before' },
    };
    let frozenDuringPreflight = false;
    let appliedValue: string | undefined;
    const handler: SetupStepHandler = {
      uses: inputStep.uses,
      preflight(step) {
        const payload = step.with as unknown as Readonly<{ value: string }>;
        frozenDuringPreflight =
          Object.isFrozen(step) && Object.isFrozen(step.with);
        return {
          requirements: {},
          async apply() {
            appliedValue = payload.value;
          },
        };
      },
    };
    const prepared = createSetupExecutorWithHandlers(
      new Map([[handler.uses, handler]]),
    ).preflight([inputStep as unknown as SetupStepV1], setupTarget);

    inputStep.with.value = 'after';
    await prepared.apply({
      runId: 'run-immutable-step',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace: emptyWorkspace(),
      stateDirectories: new Map(),
      commands: inertCommandProjections(),
      inputs: emptyInputs(),
      signal: new AbortController().signal,
    });

    assert.equal(frozenDuringPreflight, true);
    assert.equal(appliedValue, 'before');
  });

  it('rejects handler-assigned raw credential scopes', () => {
    const handler: SetupStepHandler = {
      uses: 'acme/unsafe-scope',
      preflight() {
        return {
          requirements: {
            credentials: {
              agent: {
                TOKEN: {
                  reference: credentialReference('acme.token'),
                  scopes: ['setup'],
                },
              },
            },
          } as unknown as SetupStepRequirements,
          async apply() {},
        };
      },
    };

    assert.throws(
      () =>
        createSetupExecutorWithHandlers(
          new Map([[handler.uses, handler]]),
        ).preflight(
          [{ uses: handler.uses, with: {} } as unknown as SetupStepV1],
          setupTarget,
        ),
      /binding TOKEN is invalid/,
    );
  });

  it('strictly rejects malformed extension requirement collections and bindings', () => {
    const malformed: unknown[] = [
      new Date(),
      { variables: null },
      { variables: [] },
      { variables: new Date() },
      { executables: 'git' },
      { executables: ['git', 'git'] },
      { stateDirectories: {} },
      { stateDirectories: [{ id: 'state', containerPath: 'relative' }] },
      {
        stateDirectories: [
          {
            id: 'state',
            containerPath: '/home/forge/state',
            sealAfterSetup: 'yes',
          },
        ],
      },
      {
        stateDirectories: [
          { id: 'one', containerPath: '/home/forge/state' },
          { id: 'two', containerPath: '/home/forge/state/nested' },
        ],
      },
      { credentials: null },
      { credentials: [] },
      { credentials: { setup: null } },
      { credentials: { agent: [] } },
      { credentials: { setup: new Date() } },
      Object.assign({}, { [Symbol('unexpected')]: true }),
      {
        credentials: {
          setup: {
            TOKEN: {
              reference: credentialReference('acme.token'),
              extra: true,
            },
          },
        },
      },
    ];

    for (const requirements of malformed) {
      const handler: SetupStepHandler = {
        uses: 'acme/malformed',
        preflight() {
          return {
            requirements: requirements as SetupStepRequirements,
            async apply() {},
          };
        },
      };
      assert.throws(() =>
        createSetupExecutorWithHandlers(
          new Map([[handler.uses, handler]]),
        ).preflight([{ uses: handler.uses, with: {} }], setupTarget),
      );
    }
  });

  it('rejects unknown prepared-step fields instead of discarding them', () => {
    const handler: SetupStepHandler = {
      uses: 'acme/malformed-prepared',
      preflight() {
        return {
          requirements: {},
          async apply() {},
          unknown: true,
        } as unknown as PreparedSetupStep;
      },
    };

    assert.throws(
      () =>
        createSetupExecutorWithHandlers(
          new Map([[handler.uses, handler]]),
        ).preflight([{ uses: handler.uses, with: {} }], setupTarget),
      /invalid prepared step/,
    );
  });

  it('snapshots plain JSON resolutions and rejects invalid output', async () => {
    const source = { nested: { value: 'before' } };
    const valid: SetupStepHandler = {
      uses: 'acme/resolution',
      preflight() {
        return {
          requirements: {},
          async apply() {
            return source;
          },
        };
      },
    };
    const context = {
      runId: 'run-resolution',
      paths: { workspace: '/workspace', home: '/home/forge' },
      workspace: emptyWorkspace(),
      stateDirectories: new Map(),
      commands: inertCommandProjections(),
      inputs: emptyInputs(),
      signal: new AbortController().signal,
    };
    const applied = await createSetupExecutorWithHandlers(
      new Map([[valid.uses, valid]]),
    )
      .preflight([{ uses: valid.uses, with: {} }], setupTarget)
      .apply(context);
    source.nested.value = 'after';
    assert.deepEqual(applied.steps, [
      {
        index: 0,
        uses: valid.uses,
        resolution: { nested: { value: 'before' } },
      },
    ]);
    assert.ok(Object.isFrozen(applied.steps[0]?.resolution));
    assert.ok(Object.isFrozen(applied.steps[0]?.resolution?.nested));

    const invalid: SetupStepHandler = {
      uses: 'acme/invalid-resolution',
      preflight() {
        return {
          requirements: {},
          async apply() {
            return new Date() as unknown as Record<string, never>;
          },
        };
      },
    };
    await assert.rejects(
      createSetupExecutorWithHandlers(new Map([[invalid.uses, invalid]]))
        .preflight([{ uses: invalid.uses, with: {} }], setupTarget)
        .apply(context),
      (error: unknown) => {
        assert.ok(error instanceof SetupActionError);
        assert.match(String(error.cause), /invalid resolution/);
        return true;
      },
    );
  });

  it('keeps the engine registry isolated from the exported registry view', () => {
    const exportedView = firstPartySetupHandlers as Map<
      string,
      SetupStepHandler
    >;
    const snapshot = [...exportedView];
    try {
      exportedView.clear();
      assert.doesNotThrow(() =>
        createSetupExecutor().preflight(
          [
            {
              uses: 'forge/write',
              with: { target: 'ready.txt', source: { content: 'ready' } },
            },
          ],
          setupTarget,
        ),
      );
    } finally {
      for (const [uses, handler] of snapshot) exportedView.set(uses, handler);
    }
  });

  it('does not attach potentially sensitive command output to setup errors', async () => {
    const prepared = createSetupExecutor().preflight(
      [{ uses: 'forge/command', with: { argv: ['false'] } }],
      setupTarget,
    );
    await assert.rejects(
      prepared.apply({
        runId: 'run-1',
        paths: { workspace: '/workspace', home: '/home/forge' },
        workspace: {
          async inspect(path): Promise<WorkspaceEntry> {
            return { path, kind: 'absent' };
          },
          async readFile() {
            return new Uint8Array();
          },
          async listFiles() {
            return [];
          },
          async writeFile() {},
        },
        stateDirectories: new Map(),
        commands: {
          uncredentialed: {
            async run() {
              return {
                stdout: 'TOP_SECRET',
                stderr: 'TOP_SECRET',
                exitCode: 9,
                durationMs: 1,
              };
            },
          },
          setup() {
            throw new Error('forge/command must run uncredentialed');
          },
        },
        inputs: {
          async inspect(path) {
            return { path, kind: 'file' };
          },
          async read() {
            return new Uint8Array();
          },
          async listFiles() {
            return [];
          },
        },
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SetupActionError);
        assert.equal(error.uses, 'forge/command');
        assert.equal(error.stepIndex, 0);
        assert.equal(
          String(error.cause),
          'Error: Setup command exited with status 9.',
        );
        assert.equal(
          inspect(error, { depth: null }).includes('TOP_SECRET'),
          false,
        );
        return true;
      },
    );
  });

  it('stops at the failing action and cannot replay partially applied setup', async () => {
    const mutations: number[] = [];
    const failure = new Error('installation failed');
    const handler: SetupStepHandler = {
      uses: 'acme/fail-stop',
      preflight() {
        return {
          requirements: {},
          async apply(context) {
            mutations.push(context.stepIndex);
            if (context.stepIndex === 1) throw failure;
          },
        };
      },
    };
    const prepared = createSetupExecutorWithHandlers(
      new Map([[handler.uses, handler]]),
    ).preflight(
      Array.from({ length: 3 }, () => ({ uses: handler.uses, with: {} })),
      setupTarget,
    );
    const context = setupApplyContext();

    await assert.rejects(prepared.apply(context), (error: unknown) => {
      assert.ok(error instanceof SetupActionError);
      assert.equal(error.uses, handler.uses);
      assert.equal(error.stepIndex, 1);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.deepEqual(mutations, [0, 1]);
    await assert.rejects(prepared.apply(context), /already been applied/);
    assert.deepEqual(mutations, [0, 1]);
  });

  it('preserves cancellation between actions and skips later mutations', async () => {
    const controller = new AbortController();
    const cancellation = new Error('run cancelled');
    const mutations: number[] = [];
    const handler: SetupStepHandler = {
      uses: 'acme/cancel',
      preflight() {
        return {
          requirements: {},
          async apply(context) {
            mutations.push(context.stepIndex);
            controller.abort(cancellation);
          },
        };
      },
    };
    const prepared = createSetupExecutorWithHandlers(
      new Map([[handler.uses, handler]]),
    ).preflight(
      [
        { uses: handler.uses, with: {} },
        { uses: handler.uses, with: {} },
      ],
      setupTarget,
    );

    await assert.rejects(
      prepared.apply(setupApplyContext({ signal: controller.signal })),
      (error: unknown) => error === cancellation,
    );
    assert.deepEqual(mutations, [0]);
  });

  it('rejects missing declared state before invoking the action or projecting credentials', async () => {
    let invoked = false;
    let projected = false;
    const handler: SetupStepHandler = {
      uses: 'acme/state',
      preflight() {
        return {
          requirements: {
            stateDirectories: [
              { id: 'required-state', containerPath: '/opt/state' },
            ],
            credentials: {
              setup: {
                TOKEN: { reference: credentialReference('acme.token') },
              },
            },
          },
          async apply() {
            invoked = true;
          },
        };
      },
    };
    const prepared = createSetupExecutorWithHandlers(
      new Map([[handler.uses, handler]]),
    ).preflight([{ uses: handler.uses, with: {} }], setupTarget);

    await assert.rejects(
      prepared.apply(
        setupApplyContext({
          stateDirectories: new Map([['unrelated-state', emptyWorkspace()]]),
          commands: {
            uncredentialed: inertCommandProjections().uncredentialed,
            setup() {
              projected = true;
              return inertCommandProjections().uncredentialed;
            },
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof SetupActionError);
        assert.equal(error.uses, handler.uses);
        assert.equal(error.stepIndex, 0);
        assert.match(
          String(error.cause),
          /omitted setup state directory required-state/,
        );
        return true;
      },
    );
    assert.equal(invoked, false);
    assert.equal(projected, false);
  });

  it('copies nested dataset trees to the target with exact bytes and bounded reads', async () => {
    const controller = new AbortController();
    const files = new Map([
      ['fixtures/project/README.md', Buffer.from('héllo\n')],
      ['fixtures/project/src/data.bin', Buffer.from([0, 255, 1])],
    ]);
    const writes = new Map<string, Uint8Array>();
    const prepared = createSetupExecutor().preflight(
      [
        {
          uses: 'forge/write',
          with: {
            target: 'repo',
            source: { dataset_path: 'fixtures/project' },
          },
        },
      ],
      setupTarget,
    );

    const applied = await prepared.apply(
      setupApplyContext({
        signal: controller.signal,
        workspace: {
          ...emptyWorkspace(),
          async writeFile(target, body) {
            writes.set(target, body);
          },
        },
        inputs: {
          async inspect(datasetPath) {
            assert.equal(datasetPath, 'fixtures/project');
            return { path: datasetPath, kind: 'directory' };
          },
          async listFiles(datasetPath, options) {
            assert.equal(datasetPath, 'fixtures/project');
            assert.equal(options?.signal, controller.signal);
            assert.equal(options?.maxEntries, 100_000);
            return [...files].map(([path, body]) => ({
              path,
              kind: 'file',
              size: body.length,
            }));
          },
          async read(datasetPath, options) {
            assert.equal(options?.signal, controller.signal);
            assert.equal(options?.maxBytes, 64 * 1024 * 1024);
            assert.ok(files.has(datasetPath));
            return files.get(datasetPath)!;
          },
        },
      }),
    );

    assert.deepEqual(
      [...writes],
      [
        ['repo/README.md', files.get('fixtures/project/README.md')],
        ['repo/src/data.bin', files.get('fixtures/project/src/data.bin')],
      ],
    );
    assert.deepEqual(applied.steps, [{ index: 0, uses: 'forge/write' }]);
  });

  it('rejects empty dataset directories instead of silently skipping a write', async () => {
    const prepared = createSetupExecutor().preflight(
      [
        {
          uses: 'forge/write',
          with: {
            target: 'out.txt',
            source: { dataset_path: 'fixtures/source.txt' },
          },
        },
      ],
      setupTarget,
    );
    await assert.rejects(
      prepared.apply(
        setupApplyContext({
          inputs: {
            async inspect(path) {
              return { path, kind: 'directory' };
            },
            async listFiles() {
              return [];
            },
            async read() {
              throw new Error('Must not read an empty tree');
            },
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof SetupActionError);
        assert.match(
          String(error.cause),
          /directory contains no files: fixtures\/source.txt/,
        );
        return true;
      },
    );
  });

  it('rejects an oversized dataset tree before reading or writing any file', async () => {
    let read = false;
    let written = false;
    const prepared = createSetupExecutor().preflight(
      [
        {
          uses: 'forge/write',
          with: {
            target: 'repo',
            source: { dataset_path: 'fixtures/project' },
          },
        },
      ],
      setupTarget,
    );

    await assert.rejects(
      prepared.apply(
        setupApplyContext({
          workspace: {
            ...emptyWorkspace(),
            async writeFile() {
              written = true;
            },
          },
          inputs: {
            async inspect(path) {
              return { path, kind: 'directory' };
            },
            async listFiles() {
              return [
                {
                  path: 'fixtures/project/large.bin',
                  kind: 'file',
                  size: 64 * 1024 * 1024,
                },
                { path: 'fixtures/project/one.bin', kind: 'file', size: 1 },
              ];
            },
            async read() {
              read = true;
              return new Uint8Array();
            },
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof SetupActionError);
        assert.match(
          String(error.cause),
          /Setup input tree exceeds 67108864 bytes/,
        );
        return true;
      },
    );
    assert.equal(read, false);
    assert.equal(written, false);
  });

  it('honors cancellation after a dataset read before file or directory handler writes', async () => {
    for (const kind of ['file', 'directory'] as const) {
      const controller = new AbortController();
      const cancellation = new Error(`cancelled after ${kind} read`);
      const writes: string[] = [];
      const prepared = createSetupExecutor().preflight(
        [
          {
            uses: 'forge/write',
            with: {
              target: 'out',
              source: { dataset_path: 'fixtures/source' },
            },
          },
        ],
        setupTarget,
      );

      await assert.rejects(
        prepared.apply(
          setupApplyContext({
            signal: controller.signal,
            workspace: {
              ...emptyWorkspace(),
              async writeFile(path) {
                writes.push(path);
              },
            },
            inputs: {
              async inspect(path) {
                return { path, kind };
              },
              async listFiles() {
                return [
                  { path: 'fixtures/source/one.txt', kind: 'file', size: 1 },
                ];
              },
              async read(_path, options) {
                assert.equal(options?.signal, controller.signal);
                options?.signal?.throwIfAborted();
                const body = Buffer.from('x');
                // Deliver cancellation after read completion and before the
                // awaiting handler resumes to write the returned bytes.
                queueMicrotask(() => controller.abort(cancellation));
                return body;
              },
            },
          }),
        ),
        (error: unknown) => error === cancellation,
      );
      assert.deepEqual(writes, [], kind);
    }
  });
});

function setupApplyContext(
  overrides: Partial<SetupApplyContext> = {},
): SetupApplyContext {
  return {
    runId: 'run-setup-boundary',
    paths: { workspace: '/workspace', home: '/home/forge' },
    workspace: emptyWorkspace(),
    stateDirectories: new Map(),
    commands: inertCommandProjections(),
    inputs: emptyInputs(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function emptyWorkspace(): MutableWorkspace {
  return {
    async inspect(path): Promise<WorkspaceEntry> {
      return { path, kind: 'absent' };
    },
    async readFile() {
      return new Uint8Array();
    },
    async listFiles() {
      return [];
    },
    async writeFile() {},
  };
}

function emptyInputs() {
  return {
    async inspect(path: string) {
      return { path, kind: 'file' as const };
    },
    async read() {
      return new Uint8Array();
    },
    async listFiles() {
      return [];
    },
  };
}

function inertCommandProjections() {
  return {
    uncredentialed: {
      async run() {
        return result();
      },
    },
    setup: () => ({
      async run() {
        return result();
      },
    }),
  };
}
