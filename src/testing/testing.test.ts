import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  CommandExecutionError,
  type CommandResult,
} from '../contracts/command.ts';
import type { RuntimePreparation } from '../contracts/runtime.ts';
import { executeEval } from '../execution/index.ts';
import {
  assertRuntimeAdapterConforms,
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './index.ts';

describe('@stripe/forge/testing', () => {
  it('runs the runtime lifecycle conformance probe against the fake adapter', async () => {
    const runtime = createFakeRuntimeAdapter();
    const plan = createTestResolvedRunPlan();
    const signal = new AbortController().signal;
    const report = await assertRuntimeAdapterConforms(runtime.adapter, {
      runId: 'conformance-1',
      plan,
      environment: { variables: {}, credentials: {} },
      requirements: {
        executables: [],
        stateDirectories: [
          { id: 'agent-state', containerPath: '/home/forge/.agent' },
          {
            id: 'setup-state',
            containerPath: '/home/forge/.setup',
            sealAfterSetup: true,
          },
        ],
      },
      signal,
    });

    assert.deepEqual(report, {
      runtimeId: 'conformance-1',
      stateDirectoryIds: ['agent-state', 'setup-state'],
    });
    assert.deepEqual(runtime.runs[0]?.events, [
      'prepare',
      'finalizeSetup',
      'quiesce',
      'dispose',
    ]);
  });

  it('supports a complete executeEval unit test without host resources', async () => {
    const plan = createTestResolvedRunPlan({
      caseSetup: [
        {
          uses: 'forge/write',
          with: { target: 'answer.txt', source: { content: 'done' } },
        },
      ],
      checks: { files_created: ['answer.txt'] },
    });
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter();
    const artifacts = createMemoryArtifactStore();

    const completed = await executeEval({
      runId: 'unit-run-1',
      plan,
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: artifacts.store,
      },
      now: incrementingClock(),
    });

    assert.equal(completed.result.evaluation.status, 'passed');
    assert.deepEqual(agent.messages, ['Complete the test task.']);
    assert.ok(runtime.runs[0]!.events.includes('quiesce'));
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
    assert.equal(artifacts.runs.get('unit-run-1')?.artifacts.size, 5);
    assert.equal(artifacts.events.at(-1), 'commit:unit-run-1');
  });

  it('probes successful commands with exactly the selected credential scopes', async () => {
    const input = conformanceInput();
    const runtime = createFakeRuntimeAdapter({
      command(command) {
        const visible = Object.fromEntries(
          command.credentialEnvironmentNames.map((name) => [
            name,
            input.environment.credentials[name]!.value,
          ]),
        );
        return commandResult(JSON.stringify(visible));
      },
    });
    await assertRuntimeAdapterConforms(runtime.adapter, input, {
      commandProbes: [
        {
          scope: 'uncredentialed',
          argv: ['probe-environment'],
          expectedStdout: '{}',
        },
        {
          scope: 'setup',
          credentialEnvironmentNames: ['SETUP_TOKEN'],
          argv: ['probe-environment'],
          expectedStdout: '{"SETUP_TOKEN":"synthetic-setup-value"}',
        },
        {
          scope: 'agent',
          argv: ['probe-environment'],
          expectedStdout: '{"AGENT_TOKEN":"synthetic-agent-value"}',
          expectedStderr: '',
        },
      ],
    });
    assert.deepEqual(runtime.runs[0]?.events, [
      'prepare',
      'command:uncredentialed',
      'command:setup',
      'finalizeSetup',
      'command:agent',
      'quiesce',
      'dispose',
    ]);
  });

  it('fails and disposes when a command exposes an unexpected credential', async () => {
    const runtime = createFakeRuntimeAdapter({
      command: () => commandResult('synthetic-secret-must-not-appear'),
    });
    await assert.rejects(
      assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
        commandProbes: [
          {
            scope: 'uncredentialed',
            argv: ['probe-environment'],
            expectedStdout: '{}',
          },
        ],
      }),
      /expected uncredentialed result/,
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
  });

  it('checks that credentialed setup projections close after finalization', async () => {
    const runtime = createFakeRuntimeAdapter();
    await assert.rejects(
      assertRuntimeAdapterConforms(
        {
          ...runtime.adapter,
          async prepare(input) {
            const prepared = await runtime.adapter.prepare(input);
            return {
              ...prepared,
              commands: {
                ...prepared.commands,
                setup(names) {
                  if (names.length === 0) return prepared.commands.setup(names);
                  // This faulty projection never closes, even though every other
                  // command capability obeys the runtime lifecycle.
                  return { run: async () => commandResult('setup-visible') };
                },
              },
            };
          },
        },
        conformanceInput(),
        {
          commandProbes: [
            {
              scope: 'setup',
              credentialEnvironmentNames: ['SETUP_TOKEN'],
              argv: ['probe-environment'],
              expectedStdout: 'setup-visible',
            },
          ],
        },
      ),
      /Probed setup command runner still accepted work after finalization/,
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
  });

  it('probes cancellation only after the command reports readiness', async () => {
    let observedAbort = false;
    const runtime = createFakeRuntimeAdapter({
      command: ({ options }) =>
        new Promise<CommandResult>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(
                new CommandExecutionError(
                  'Probe was aborted.',
                  'command_aborted',
                ),
              );
            },
            { once: true },
          );
          options.onStdoutLine?.('ready');
        }),
    });
    await assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
      cancellationProbe: { argv: ['probe-wait'], readyLine: 'ready' },
    });
    assert.equal(observedAbort, true);
    assert.deepEqual(runtime.runs[0]?.events, [
      'prepare',
      'finalizeSetup',
      'command:agent',
      'quiesce',
      'dispose',
    ]);
  });

  it('does not mistake startup failure for successful cancellation', async () => {
    const runtime = createFakeRuntimeAdapter({
      command: () => {
        throw new CommandExecutionError(
          'Probe could not start.',
          'command_start_failed',
        );
      },
    });
    await assert.rejects(
      assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
        cancellationProbe: { argv: ['probe-wait'], readyLine: 'ready' },
      }),
      /never reported readiness/,
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
  });

  it('rejects commands which resolve or time out after cancellation', async () => {
    for (const behavior of ['resolve', 'timeout'] as const) {
      const runtime = createFakeRuntimeAdapter({
        command: ({ options }) => {
          options.onStdoutLine?.('ready');
          if (behavior === 'timeout') {
            throw new CommandExecutionError(
              'Probe timed out.',
              'command_timeout',
            );
          }
          return commandResult('');
        },
      });
      await assert.rejects(
        assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
          cancellationProbe: { argv: ['probe-wait'], readyLine: 'ready' },
        }),
        behavior === 'resolve'
          ? /resolved after cancellation/
          : /reason other than cancellation/,
      );
      assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
    }
  });

  it('bounds the wait for a command which ignores cancellation', async () => {
    let stopCommand!: (result: CommandResult) => void;
    const runtime = createFakeRuntimeAdapter({
      command: ({ options }) => {
        options.onStdoutLine?.('ready');
        return new Promise<CommandResult>((resolve) => {
          stopCommand = resolve;
        });
      },
    });
    const ignoresCancellation = {
      ...runtime.adapter,
      async prepare(input: RuntimePreparation) {
        const prepared = await runtime.adapter.prepare(input);
        return {
          ...prepared,
          async dispose() {
            // This faulty runner ignores the command signal, but runtime
            // cleanup still stops its work before draining active commands.
            stopCommand(commandResult(''));
            await prepared.dispose();
          },
        };
      },
    };
    await assert.rejects(
      assertRuntimeAdapterConforms(ignoresCancellation, conformanceInput(), {
        cancellationProbe: {
          argv: ['probe-wait'],
          readyLine: 'ready',
          deadlineMs: 10,
        },
      }),
      /did not settle before its deadline/,
    );
    assert.equal(runtime.runs[0]?.events.at(-1), 'dispose');
  });

  it('detects changed sealed bytes and still disposes the runtime', async () => {
    const runtime = createFakeRuntimeAdapter();
    await assert.rejects(
      assertRuntimeAdapterConforms(
        {
          ...runtime.adapter,
          async prepare(input) {
            const prepared = await runtime.adapter.prepare(input);
            return {
              ...prepared,
              async quiesce() {
                const sealed = await prepared.quiesce();
                return {
                  ...sealed,
                  workspace: {
                    ...sealed.workspace,
                    readFile: async () => new Uint8Array([9, 9, 9]),
                  },
                };
              },
            };
          },
        },
        conformanceInput(),
      ),
      /Sealed workspace did not preserve probe bytes/,
    );
    assert.deepEqual(runtime.runs[0]?.events, [
      'prepare',
      'finalizeSetup',
      'quiesce',
      'dispose',
    ]);
  });
});

function conformanceInput(): RuntimePreparation {
  return {
    runId: 'command-conformance',
    plan: createTestResolvedRunPlan(),
    environment: {
      variables: {},
      credentials: {
        SETUP_TOKEN: { value: 'synthetic-setup-value', scopes: ['setup'] },
        OTHER_SETUP_TOKEN: {
          value: 'synthetic-other-setup-value',
          scopes: ['setup'],
        },
        AGENT_TOKEN: { value: 'synthetic-agent-value', scopes: ['agent'] },
      },
    },
    requirements: { executables: [], stateDirectories: [] },
    signal: new AbortController().signal,
  };
}

function commandResult(stdout: string): CommandResult {
  return { stdout, stderr: '', exitCode: 0, durationMs: 0 };
}

function incrementingClock(): () => Date {
  let timestamp = Date.parse('2026-09-15T00:00:00.000Z');
  return () => {
    const value = new Date(timestamp);
    timestamp += 1_000;
    return value;
  };
}
