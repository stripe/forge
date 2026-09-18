import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {CommandResult} from '../contracts/command.js';
import {credentialReference} from '../contracts/credentials.js';
import type {AgentPluginInstaller} from '../contracts/plugin.js';
import type {MutableWorkspace, WorkspaceEntry} from '../contracts/runtime.js';
import type {SetupStepV1} from '../model/types.js';
import {parseSetupStep} from '../model/parse.js';
import {
  createSetupExecutor,
  createSetupExecutorWithHandlers,
  firstPartySetupHandlers,
} from './executor.js';
import type {
  PreparedSetupStep,
  SetupStepHandler,
  SetupStepRequirements,
} from './types.js';

const setupTarget = Object.freeze({
  selection: Object.freeze({
    adapter: 'test-agent',
    provider: 'test-provider',
    model: 'test-model',
  }),
  runtime: Object.freeze({
    adapter: 'docker' as const,
    image: Object.freeze({kind: 'forge' as const}),
    platform: 'linux/amd64' as const,
    resources: Object.freeze({
      memory_bytes: 1024,
      cpu_count: 1,
      process_count: 8,
    }),
  }),
});

function result(exitCode = 0): CommandResult {
  return {stdout: '', stderr: '', exitCode, durationMs: 1};
}

describe('portable setup actions', () => {
  it('applies forge/write@1 and forge/command@1 in source order', async () => {
    const events: string[] = [];
    const writes = new Map<string, Uint8Array>();
    const workspace: MutableWorkspace = {
      async inspect(relativePath): Promise<WorkspaceEntry> {
        return {path: relativePath, kind: writes.has(relativePath) ? 'file' : 'absent'};
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
        uses: 'forge/write@1',
        with: {target: 'notes/inline.txt', source: {content: 'inline'}},
      },
      {
        uses: 'forge/write@1',
        with: {
          target: 'notes/fixture.txt',
          source: {dataset_path: 'fixtures/source.txt'},
        },
      },
      {
        uses: 'forge/command@1',
        with: {argv: ['node', '--version'], cwd: '.', timeout_ms: 1234},
      },
    ];

    const prepared = createSetupExecutor().preflight(steps, setupTarget);
    await prepared.apply({
      runId: 'run-1',
      paths: {workspace: '/workspace', home: '/home/forge'},
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
          throw new Error('credential-free commands must not use setup credentials');
        },
      },
      inputs: {
        async inspect(datasetPath) {
          return {path: datasetPath, kind: 'file', size: 7};
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
    assert.equal(Buffer.from(writes.get('notes/fixture.txt')!).toString(), 'fixture');
  });

  it('routes forge/plugin@1 through only the selected agent capability', async () => {
    const events: string[] = [];
    const pluginState = emptyWorkspace();
    const installer: AgentPluginInstaller = {
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
            assert.deepEqual([...installContext.stateDirectories.keys()], [
              'plugin-state',
            ]);
            assert.equal(
              installContext.stateDirectories.get('plugin-state'),
              pluginState,
            );
            events.push('install');
          },
        };
      },
    };
    const step = parseSetupStep({
      uses: 'forge/plugin@1',
      with: {
        agents: {
          'test-agent': {
            plugin: 'formatter@example-marketplace',
            marketplace: 'example/marketplace',
          },
          'other-agent': {
            plugin: 'other@other-marketplace',
            marketplace: 'other/marketplace',
          },
        },
      },
    });
    const prepared = createSetupExecutor().preflight([step], {
      ...setupTarget,
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

    await prepared.apply({
      runId: 'run-plugin',
      paths: {workspace: '/workspace', home: '/home/forge'},
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
      'preflight:test-agent:formatter@example-marketplace',
      'install',
    ]);
  });

  it('rejects an unsupported or missing selected plugin realization in preflight', () => {
    const step = parseSetupStep({
      uses: 'forge/plugin@1',
      with: {
        agents: {
          'other-agent': {
            plugin: 'formatter@example-marketplace',
            marketplace: 'example/marketplace',
          },
        },
      },
    });
    assert.throws(
      () => createSetupExecutor().preflight([step], setupTarget),
      /does not define a distribution/,
    );
  });

  it('preflights all handlers before performing mutations', async () => {
    let mutated = false;
    const mutatingHandler: SetupStepHandler = {
      uses: 'acme/mutate@1',
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
      {uses: mutatingHandler.uses, with: {}} as unknown as SetupStepV1,
      {uses: 'example/missing@1', with: {}} as unknown as SetupStepV1,
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
      uses: 'acme/configure@1',
      preflight(_step, context) {
        assert.equal(Object.isFrozen(context.selection), true);
        assert.equal(Object.isFrozen(context.runtime), true);
        assert.equal(Object.isFrozen(context.runtime.resources), true);
        events.push(
          `preflight:${context.stepIndex}:${context.selection.adapter}:${context.runtime.platform}`,
        );
        return {
          requirements: {
            variables: {FEATURE_MODE: 'enabled'},
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
      [{uses: handler.uses, with: {}} as unknown as SetupStepV1],
      setupTarget,
    );

    assert.deepEqual(prepared.requirements, {
      variables: {FEATURE_MODE: 'enabled'},
      credentials: {
        setup: {
          PACKAGE_TOKEN: {reference: 'acme.package-token'},
        },
        agent: {
          SERVICE_TOKEN: {reference: 'acme.service-token'},
        },
      },
    });
    assert.equal(Object.isFrozen(prepared.requirements), true);

    await prepared.apply({
      runId: 'run-requirements',
      paths: {workspace: '/workspace', home: '/home/forge'},
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
        paths: {workspace: '/workspace', home: '/home/forge'},
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
      uses: 'acme/conflict@1',
      preflight() {
        return {
          requirements: {
            credentials: {
              setup: {
                SHARED_TOKEN: {reference: credentialReference('setup-token')},
              },
              agent: {
                SHARED_TOKEN: {reference: credentialReference('agent-token')},
              },
            },
          },
          async apply() {},
        };
      },
    };

    assert.throws(
      () => createSetupExecutorWithHandlers(
        new Map([[handler.uses, handler]]),
      ).preflight(
        [{uses: handler.uses, with: {}} as unknown as SetupStepV1],
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
      uses: 'acme/install@1',
      preflight(step) {
        const payload = step.with as unknown as Readonly<{
          credential_name: string;
          credential_reference: string;
        }>;
        const credentialName = payload.credential_name;
        return {
          requirements: {
            credentials: {
              setup: {
                [credentialName]: {
                  reference: credentialReference(
                    payload.credential_reference,
                  ),
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
      ],
      setupTarget,
    );

    await prepared.apply({
      runId: 'run-projected-credentials',
      paths: {workspace: '/workspace', home: '/home/forge'},
      workspace: emptyWorkspace(),
      stateDirectories: new Map(),
      commands: {
        uncredentialed: {
          async run() {
            throw new Error('credentialed steps must use a credential projection');
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
      {credentialEnvironmentNames: ['TOKEN_A'], argv: ['install', 'TOKEN_A']},
      {credentialEnvironmentNames: ['TOKEN_B'], argv: ['install', 'TOKEN_B']},
    ]);
  });

  it('binds prepared operations to an immutable setup-step snapshot', async () => {
    const inputStep = {
      uses: 'acme/capture@1',
      with: {value: 'before'},
    };
    let frozenDuringPreflight = false;
    let appliedValue: string | undefined;
    const handler: SetupStepHandler = {
      uses: inputStep.uses,
      preflight(step) {
        const payload = step.with as unknown as Readonly<{value: string}>;
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
      paths: {workspace: '/workspace', home: '/home/forge'},
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
      uses: 'acme/unsafe-scope@1',
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
      () => createSetupExecutorWithHandlers(
        new Map([[handler.uses, handler]]),
      ).preflight(
        [{uses: handler.uses, with: {}} as unknown as SetupStepV1],
        setupTarget,
      ),
      /binding TOKEN is invalid/,
    );
  });

  it('strictly rejects malformed extension requirement collections and bindings', () => {
    const malformed: unknown[] = [
      new Date(),
      {variables: null},
      {variables: []},
      {variables: new Date()},
      {executables: 'git'},
      {executables: ['git', 'git']},
      {stateDirectories: {}},
      {stateDirectories: [{id: 'state', containerPath: 'relative'}]},
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
          {id: 'one', containerPath: '/home/forge/state'},
          {id: 'two', containerPath: '/home/forge/state/nested'},
        ],
      },
      {credentials: null},
      {credentials: []},
      {credentials: {setup: null}},
      {credentials: {agent: []}},
      {credentials: {setup: new Date()}},
      Object.assign({}, {[Symbol('unexpected')]: true}),
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
        uses: 'acme/malformed@1',
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
        ).preflight(
          [{uses: handler.uses, with: {}}],
          setupTarget,
        ),
      );
    }
  });

  it('rejects unknown prepared-step fields instead of discarding them', () => {
    const handler: SetupStepHandler = {
      uses: 'acme/malformed-prepared@1',
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
        ).preflight([{uses: handler.uses, with: {}}], setupTarget),
      /invalid prepared step/,
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
      assert.doesNotThrow(() => createSetupExecutor().preflight(
        [
          {
            uses: 'forge/write@1',
            with: {target: 'ready.txt', source: {content: 'ready'}},
          },
        ],
        setupTarget,
      ));
    } finally {
      for (const [uses, handler] of snapshot) exportedView.set(uses, handler);
    }
  });

  it('does not attach potentially sensitive command output to setup errors', async () => {
    const prepared = createSetupExecutor().preflight(
      [{uses: 'forge/command@1', with: {argv: ['false']}}],
      setupTarget,
    );
    await assert.rejects(
      prepared.apply({
        runId: 'run-1',
        paths: {workspace: '/workspace', home: '/home/forge'},
        workspace: {
          async inspect(path): Promise<WorkspaceEntry> {
            return {path, kind: 'absent'};
          },
          async readFile() { return new Uint8Array(); },
          async listFiles() { return []; },
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
            throw new Error('forge/command@1 must run uncredentialed');
          },
        },
        inputs: {
          async inspect(path) { return {path, kind: 'file'}; },
          async read() { return new Uint8Array(); },
          async listFiles() { return []; },
        },
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(String(error).includes('TOP_SECRET'), false);
        return true;
      },
    );
  });
});

function emptyWorkspace(): MutableWorkspace {
  return {
    async inspect(path): Promise<WorkspaceEntry> { return {path, kind: 'absent'}; },
    async readFile() { return new Uint8Array(); },
    async listFiles() { return []; },
    async writeFile() {},
  };
}

function emptyInputs() {
  return {
    async inspect(path: string) { return {path, kind: 'file' as const}; },
    async read() { return new Uint8Array(); },
    async listFiles() { return []; },
  };
}

function inertCommandProjections() {
  return {
    uncredentialed: {async run() { return result(); }},
    setup: () => ({async run() { return result(); }}),
  };
}
