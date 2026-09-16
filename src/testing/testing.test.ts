import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
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
        ],
      },
      signal,
    });

    expect(report).toEqual({
      runtimeId: 'conformance-1',
      stateDirectoryIds: ['agent-state'],
    });
    expect(runtime.runs[0]?.events).toEqual(['prepare', 'quiesce', 'dispose']);
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
        setupHandlers: new Map(),
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
    expect(artifacts.runs.get('unit-run-1')?.artifacts.size).toBe(4);
    expect(artifacts.events.at(-1)).toBe('commit:unit-run-1');
  });
});

function incrementingClock(): () => Date {
  let timestamp = Date.parse('2026-09-15T00:00:00.000Z');
  return () => {
    const value = new Date(timestamp);
    timestamp += 1_000;
    return value;
  };
}
