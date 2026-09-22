import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {
  CommandExecutionError,
  type CommandResult,
} from '../contracts/command.js';
import type {RuntimePreparation} from '../contracts/runtime.js';
import {executeEval} from '../execution/index.js';
import {
  assertRuntimeAdapterConforms,
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createMemoryWorkspace,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './index.js';

describe('@stripe/forge/testing', () => {
  it('provides isolated in-memory workspace and dataset bytes', async () => {
    const workspace = createMemoryWorkspace({'src/a.txt': 'alpha'});
    const firstRead = await workspace.mutable.readFile('src/a.txt');
    firstRead[0] = 0;
    expect(Buffer.from(await workspace.readonly.readFile('src/a.txt')).toString())
      .toBe('alpha');
    await workspace.mutable.writeFile('src/b.txt', Buffer.from('beta'));
    workspace.seal();
    await expect(
      workspace.mutable.writeFile('src/c.txt', Buffer.from('gamma')),
    ).rejects.toThrow(/sealed/);
    await expect(workspace.readonly.listFiles()).resolves.toEqual([
      {path: 'src', kind: 'directory'},
      {path: 'src/a.txt', kind: 'file', size: 5},
      {path: 'src/b.txt', kind: 'file', size: 4},
    ]);

    const inputs = createMemoryRunInputProvider({
      'fixtures/a.txt': 'fixture-a',
      'fixtures/nested/b.txt': 'fixture-b',
    });
    await expect(inputs.listFiles('fixtures')).resolves.toEqual([
      {path: 'fixtures/a.txt', kind: 'file', size: 9},
      {path: 'fixtures/nested/b.txt', kind: 'file', size: 9},
    ]);
  });

  it('runs the runtime lifecycle conformance probe against the fake adapter', async () => {
    const runtime = createFakeRuntimeAdapter();
    const plan = createTestResolvedRunPlan();
    const signal = new AbortController().signal;
    const report = await assertRuntimeAdapterConforms(runtime.adapter, {
      runId: 'conformance-1',
      plan,
      environment: {variables: {}, credentials: {}},
      requirements: {
        executables: [],
        stateDirectories: [
          {id: 'agent-state', containerPath: '/home/forge/.agent'},
          {
            id: 'setup-state',
            containerPath: '/home/forge/.setup',
            sealAfterSetup: true,
          },
        ],
      },
      signal,
    });

    expect(report).toEqual({
      runtimeId: 'conformance-1',
      stateDirectoryIds: ['agent-state', 'setup-state'],
    });
    expect(runtime.runs[0]?.events).toEqual([
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
          uses: 'forge/write@1',
          with: {target: 'answer.txt', source: {content: 'done'}},
        },
      ],
      checks: {files_created: ['answer.txt']},
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

    expect(completed.result.evaluation.status).toBe('passed');
    expect(agent.messages).toEqual(['Complete the test task.']);
    expect(runtime.runs[0]?.events).toContain('quiesce');
    expect(runtime.runs[0]?.events.at(-1)).toBe('dispose');
    expect(artifacts.runs.get('unit-run-1')?.artifacts.size).toBe(5);
    expect(artifacts.events.at(-1)).toBe('commit:unit-run-1');
  });

  it('probes successful commands with exactly the selected credential scopes', async () => {
    const input = conformanceInput();
    const runtime = createFakeRuntimeAdapter({
      command(command) {
        const visible = Object.fromEntries(command.credentialEnvironmentNames.map(
          (name) => [name, input.environment.credentials[name]!.value],
        ));
        return commandResult(JSON.stringify(visible));
      },
    });
    await assertRuntimeAdapterConforms(runtime.adapter, input, {
      commandProbes: [
        {scope: 'uncredentialed', argv: ['probe-environment'], expectedStdout: '{}'},
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
    expect(runtime.runs[0]?.events).toEqual([
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
    await expect(assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
      commandProbes: [{
        scope: 'uncredentialed',
        argv: ['probe-environment'],
        expectedStdout: '{}',
      }],
    })).rejects.toThrow('expected uncredentialed result');
    expect(runtime.runs[0]?.events.at(-1)).toBe('dispose');
  });

  it('checks that credentialed setup projections close after finalization', async () => {
    const runtime = createFakeRuntimeAdapter();
    await expect(assertRuntimeAdapterConforms({
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
              return {run: async () => commandResult('setup-visible')};
            },
          },
        };
      },
    }, conformanceInput(), {
      commandProbes: [{
        scope: 'setup',
        credentialEnvironmentNames: ['SETUP_TOKEN'],
        argv: ['probe-environment'],
        expectedStdout: 'setup-visible',
      }],
    })).rejects.toThrow('Probed setup command runner still accepted work after finalization');
    expect(runtime.runs[0]?.events.at(-1)).toBe('dispose');
  });

  it('probes cancellation only after the command reports readiness', async () => {
    let observedAbort = false;
    const runtime = createFakeRuntimeAdapter({
      command: ({options}) => new Promise<CommandResult>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => {
          observedAbort = true;
          reject(new CommandExecutionError('Probe was aborted.', 'command_aborted'));
        }, {once: true});
        options.onStdoutLine?.('ready');
      }),
    });
    await assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
      cancellationProbe: {argv: ['probe-wait'], readyLine: 'ready'},
    });
    expect(observedAbort).toBe(true);
    expect(runtime.runs[0]?.events).toEqual([
      'prepare', 'finalizeSetup', 'command:agent', 'quiesce', 'dispose',
    ]);
  });

  it('does not mistake startup failure for successful cancellation', async () => {
    const runtime = createFakeRuntimeAdapter({
      command: () => {
        throw new CommandExecutionError('Probe could not start.', 'command_start_failed');
      },
    });
    await expect(assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
      cancellationProbe: {argv: ['probe-wait'], readyLine: 'ready'},
    })).rejects.toThrow('never reported readiness');
    expect(runtime.runs[0]?.events.at(-1)).toBe('dispose');
  });

  it('rejects commands which resolve or time out after cancellation', async () => {
    for (const behavior of ['resolve', 'timeout'] as const) {
      const runtime = createFakeRuntimeAdapter({
        command: ({options}) => {
          options.onStdoutLine?.('ready');
          if (behavior === 'timeout') {
            throw new CommandExecutionError('Probe timed out.', 'command_timeout');
          }
          return commandResult('');
        },
      });
      await expect(assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
        cancellationProbe: {argv: ['probe-wait'], readyLine: 'ready'},
      })).rejects.toThrow(behavior === 'resolve'
        ? 'resolved after cancellation'
        : 'reason other than cancellation');
      expect(runtime.runs[0]?.events.at(-1)).toBe('dispose');
    }
  });

  it('bounds the wait for a command which ignores cancellation', async () => {
    const runtime = createFakeRuntimeAdapter({
      command: ({options}) => {
        options.onStdoutLine?.('ready');
        return new Promise<CommandResult>(() => undefined);
      },
    });
    await expect(assertRuntimeAdapterConforms(runtime.adapter, conformanceInput(), {
      cancellationProbe: {argv: ['probe-wait'], readyLine: 'ready', deadlineMs: 10},
    })).rejects.toThrow('did not settle before its deadline');
    expect(runtime.runs[0]?.events.at(-1)).toBe('dispose');
  });
});

function conformanceInput(): RuntimePreparation {
  return {
    runId: 'command-conformance',
    plan: createTestResolvedRunPlan(),
    environment: {
      variables: {},
      credentials: {
        SETUP_TOKEN: {value: 'synthetic-setup-value', scopes: ['setup']},
        OTHER_SETUP_TOKEN: {value: 'synthetic-other-setup-value', scopes: ['setup']},
        AGENT_TOKEN: {value: 'synthetic-agent-value', scopes: ['agent']},
      },
    },
    requirements: {executables: [], stateDirectories: []},
    signal: new AbortController().signal,
  };
}

function commandResult(stdout: string): CommandResult {
  return {stdout, stderr: '', exitCode: 0, durationMs: 0};
}

function incrementingClock(): () => Date {
  let timestamp = Date.parse('2026-09-15T00:00:00.000Z');
  return () => {
    const value = new Date(timestamp);
    timestamp += 1_000;
    return value;
  };
}
