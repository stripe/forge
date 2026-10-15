import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { credentialReference } from '../contracts/credentials.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from './fakes.js';
import { createMemoryRunInputProvider } from './memoryInputs.js';
import { createTestResolvedRunPlan } from './plans.js';

describe('createMemoryArtifactStore', () => {
  it('keeps staged bytes private and snapshots artifacts and committed results', async () => {
    const fixture = createMemoryArtifactStore();
    const transaction = await fixture.store.begin('run/1');
    const body = Buffer.from('artifact');
    await transaction.write({
      path: 'nested/data.bin',
      mediaType: 'application/octet-stream',
      body,
      sensitivity: 'restricted',
    });
    body.fill(0);
    assert.equal(fixture.runs.size, 0);
    await assert.rejects(fixture.store.begin('run/1'), /already exists/);
    await assert.rejects(
      transaction.write({
        path: 'nested/data.bin',
        mediaType: 'text/plain',
        body,
      }),
      /Duplicate/,
    );
    const result = { nested: { status: 'passed' } };
    const committed = await transaction.commit(result);
    result.nested.status = 'changed';
    (committed.result.nested as { status: string }).status = 'also changed';
    const stored = fixture.runs.get('run/1')!;
    assert.deepEqual(stored.result, { nested: { status: 'passed' } });
    assert.equal(committed.location, 'memory://forge/runs/run%2F1');
    assert.equal(
      Buffer.from(stored.artifacts.get('nested/data.bin')!.body).toString(),
      'artifact',
    );
    assert.equal(
      stored.artifacts.get('nested/data.bin')!.sensitivity,
      'restricted',
    );
    await assert.rejects(
      transaction.write({ path: 'late.txt', mediaType: 'text/plain', body }),
      /closed/,
    );
    await assert.rejects(transaction.commit({}), /closed/);
    await transaction.rollback();
    await assert.rejects(fixture.store.begin('run/1'), /already exists/);
    assert.deepEqual(fixture.events, [
      'begin:run/1',
      'write:run/1:nested/data.bin',
      'commit:run/1',
    ]);
  });

  it('rolls back once, closes the transaction, and releases the run ID for retry', async () => {
    const fixture = createMemoryArtifactStore();
    const transaction = await fixture.store.begin('retry');
    await transaction.write({
      path: 'old.txt',
      mediaType: 'text/plain',
      body: Buffer.from('old'),
    });
    await transaction.rollback();
    await transaction.rollback();
    await assert.rejects(transaction.commit({}), /closed/);
    const retry = await fixture.store.begin('retry');
    await retry.commit({ status: 'passed' });
    assert.equal(fixture.runs.get('retry')!.artifacts.size, 0);
    assert.deepEqual(fixture.events, [
      'begin:retry',
      'write:retry:old.txt',
      'rollback:retry',
      'begin:retry',
      'commit:retry',
    ]);
  });
});

describe('createScriptedAgentAdapter', () => {
  it('copies turn records, preserves an aborted step, and fails on exhaustion', async () => {
    const turn = {
      text: 'first',
      sessionId: 'session-1',
      toolCalls: [{ name: 'write' }],
      costUsd: 0.1,
    };
    const fixture = createScriptedAgentAdapter({ turns: [turn] });
    turn.text = 'changed';
    turn.toolCalls[0]!.name = 'changed';
    const plan = createTestResolvedRunPlan();
    const runtime = await createFakeRuntimeAdapter().adapter.prepare({
      runId: 'agent-test',
      plan,
      environment: { variables: {}, credentials: {} },
      requirements: { executables: [], stateDirectories: [] },
      signal: new AbortController().signal,
    });
    const session = await fixture.adapter.openSession({
      runId: 'agent-test',
      plan,
      selection: plan.agent,
      inputs: createMemoryRunInputProvider(),
      runtime,
      signal: new AbortController().signal,
    });
    assert.equal(session.sessionId(), undefined);
    const cancelled = new AbortController();
    cancelled.abort(new Error('agent cancelled'));
    await assert.rejects(
      session.send('unused', { signal: cancelled.signal }),
      /agent cancelled/,
    );
    assert.deepEqual(fixture.messages, []);
    const completed = await session.send('task', {
      signal: new AbortController().signal,
    });
    assert.deepEqual(completed, {
      text: 'first',
      sessionId: 'session-1',
      toolCalls: [{ name: 'write' }],
      costUsd: 0.1,
    });
    assert.equal(session.sessionId(), 'session-1');
    await assert.rejects(
      session.send('extra', { signal: new AbortController().signal }),
      /no remaining turn/,
    );
    assert.deepEqual(fixture.messages, ['task']);
    assert.deepEqual(fixture.events, ['open-session', 'send:1']);
    await runtime.dispose();
  });
});

describe('createStaticCredentialResolver', () => {
  it('snapshots explicit credentials and fails closed without observing aborted resolutions', async () => {
    const values = { 'test.token': 'synthetic-value' };
    const calls: string[] = [];
    const resolver = createStaticCredentialResolver(values, {
      onResolve: (reference, purpose) => calls.push(`${reference}:${purpose}`),
    });
    values['test.token'] = 'changed';
    const context = {
      runId: 'credential-test',
      purpose: 'agent',
      signal: new AbortController().signal,
    };
    assert.equal(
      await resolver.resolve(credentialReference('test.token'), context),
      'synthetic-value',
    );
    await assert.rejects(
      resolver.resolve(credentialReference('test.missing'), context),
      /No test credential/,
    );
    const controller = new AbortController();
    controller.abort(new Error('credentials cancelled'));
    await assert.rejects(
      resolver.resolve(credentialReference('test.token'), {
        ...context,
        signal: controller.signal,
      }),
      /credentials cancelled/,
    );
    assert.deepEqual(calls, ['test.token:agent', 'test.missing:agent']);
  });
});

describe('createFakeRuntimeAdapter command barriers', () => {
  it('finalizes setup after its admitted writes while allowing an active agent command', async () => {
    const { fixture, prepared, setup, agent } = await prepareGatedRuntime();
    const activeSetup = prepared.commands.uncredentialed.run(['setup-wait']);
    let agentSettled = false;
    const activeAgent = prepared.commands.agent
      .run(['agent-wait'])
      .then((result) => {
        agentSettled = true;
        return result;
      });
    await Promise.all([setup.started, agent.started]);
    let finalized = false;
    const finalizing = prepared.finalizeSetup().then(() => {
      finalized = true;
    });
    try {
      await nextTurn();
      assert.equal(finalized, false);
      await assert.rejects(
        prepared.commands.uncredentialed.run(['late']),
        /finalized/,
      );
      await assert.rejects(
        prepared.commands.setup([]).run(['late']),
        /finalized/,
      );
      setup.release();
      await activeSetup;
      await finalizing;
      assert.equal(agentSettled, false);
      const state = prepared.stateDirectories.get('setup-state')!;
      assert.equal(
        Buffer.from(await state.readFile('completed.txt')).toString(),
        'setup-wait',
      );
      await assert.rejects(
        state.writeFile('late.txt', Buffer.from('late')),
        /sealed/,
      );
    } finally {
      setup.release();
      agent.release();
      await Promise.allSettled([activeSetup, activeAgent, finalizing]);
      await prepared.dispose();
    }
    assert.equal(
      fixture.runs[0]!.events.filter((event) => event === 'finalizeSetup')
        .length,
      1,
    );
  });

  it('shares quiescence while draining all admitted commands before exposing sealed bytes', async () => {
    const { fixture, prepared, setup, agent } = await prepareGatedRuntime();
    const activeSetup = prepared.commands.setup([]).run(['setup-wait']);
    const activeAgent = prepared.commands.agent.run(['agent-wait']);
    await Promise.all([setup.started, agent.started]);
    let settled = 0;
    const first = prepared.quiesce().then((sealed) => {
      settled += 1;
      return sealed;
    });
    const second = prepared.quiesce().then((sealed) => {
      settled += 1;
      return sealed;
    });
    try {
      await nextTurn();
      assert.equal(settled, 0);
      for (const commands of [
        prepared.commands.uncredentialed,
        prepared.commands.setup([]),
        prepared.commands.agent,
      ]) {
        await assert.rejects(commands.run(['late']), /closed/);
      }
      setup.release();
      await activeSetup;
      await nextTurn();
      assert.equal(settled, 0);
      agent.release();
      await activeAgent;
      const [sealed, concurrent] = await Promise.all([first, second]);
      assert.equal(concurrent, sealed);
      assert.equal(
        Buffer.from(
          await sealed.workspace.readFile('agent-wait.txt'),
        ).toString(),
        'agent-wait',
      );
      assert.equal(
        Buffer.from(
          await sealed.stateDirectories
            .get('setup-state')!
            .readFile('completed.txt'),
        ).toString(),
        'setup-wait',
      );
      await assert.rejects(
        prepared.workspace.writeFile('late.txt', Buffer.from('late')),
        /sealed/,
      );
    } finally {
      setup.release();
      agent.release();
      await Promise.allSettled([activeSetup, activeAgent, first, second]);
      await prepared.dispose();
    }
    assert.equal(
      fixture.runs[0]!.events.filter((event) => event === 'quiesce').length,
      1,
    );
  });

  it('shares disposal and drains active command writes before completing cleanup', async () => {
    const { fixture, prepared, setup, agent } = await prepareGatedRuntime();
    const activeSetup = prepared.commands.uncredentialed.run(['setup-wait']);
    const activeAgent = prepared.commands.agent.run(['agent-wait']);
    await Promise.all([setup.started, agent.started]);
    let settled = 0;
    const first = prepared.dispose().then(() => {
      settled += 1;
    });
    const second = prepared.dispose().then(() => {
      settled += 1;
    });
    try {
      await nextTurn();
      assert.equal(settled, 0);
      await assert.rejects(prepared.commands.agent.run(['late']), /closed/);
      setup.release();
      await activeSetup;
      await nextTurn();
      assert.equal(settled, 0);
      agent.release();
      await activeAgent;
      await Promise.all([first, second]);
      assert.equal(
        Buffer.from(
          await prepared.workspace.readFile('agent-wait.txt'),
        ).toString(),
        'agent-wait',
      );
      await assert.rejects(
        prepared.workspace.writeFile('late.txt', Buffer.from('late')),
        /sealed/,
      );
      await assert.rejects(prepared.quiesce(), /disposed before quiescence/);
    } finally {
      setup.release();
      agent.release();
      await Promise.allSettled([activeSetup, activeAgent, first, second]);
    }
    assert.equal(
      fixture.runs[0]!.events.filter((event) => event === 'dispose').length,
      1,
    );
  });
});

function commandGate() {
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, barrier, release, start };
}

async function prepareGatedRuntime() {
  const setup = commandGate();
  const agent = commandGate();
  const fixture = createFakeRuntimeAdapter({
    async command({ argv }) {
      const gate = argv[0] === 'setup-wait' ? setup : agent;
      gate.start();
      await gate.barrier;
      const runtime = fixture.runs[0]!.prepared;
      await runtime.workspace.writeFile(
        `${argv[0]}.txt`,
        Buffer.from(argv[0]!),
      );
      if (argv[0] === 'setup-wait') {
        await runtime.stateDirectories
          .get('setup-state')!
          .writeFile('completed.txt', Buffer.from(argv[0]));
      }
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
    },
  });
  const prepared = await fixture.adapter.prepare({
    runId: 'gated-runtime',
    plan: createTestResolvedRunPlan(),
    environment: { variables: {}, credentials: {} },
    requirements: {
      executables: [],
      stateDirectories: [
        {
          id: 'setup-state',
          containerPath: '/opt/setup',
          sealAfterSetup: true,
        },
      ],
    },
    signal: new AbortController().signal,
  });
  return { fixture, prepared, setup, agent };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
