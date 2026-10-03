import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {credentialReference} from '../contracts/credentials.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from './fakes.js';
import {createMemoryRunInputProvider} from './memoryInputs.js';
import {createTestResolvedRunPlan} from './plans.js';

describe('createMemoryArtifactStore', () => {
  it('keeps staged bytes private and snapshots artifacts and committed results', async () => {
    const fixture = createMemoryArtifactStore();
    const transaction = await fixture.store.begin('run/1');
    const body = Buffer.from('artifact');
    await transaction.write({path: 'nested/data.bin', mediaType: 'application/octet-stream', body,
      sensitivity: 'restricted'});
    body.fill(0);
    expect(fixture.runs.size).toBe(0);
    await expect(fixture.store.begin('run/1')).rejects.toThrow(/already exists/);
    await expect(transaction.write({path: 'nested/data.bin', mediaType: 'text/plain', body}))
      .rejects.toThrow(/Duplicate/);
    const result = {nested: {status: 'passed'}};
    const committed = await transaction.commit(result);
    result.nested.status = 'changed';
    (committed.result.nested as {status: string}).status = 'also changed';
    const stored = fixture.runs.get('run/1')!;
    expect(stored.result).toEqual({nested: {status: 'passed'}});
    expect(committed.location).toBe('memory://forge/runs/run%2F1');
    expect(Buffer.from(stored.artifacts.get('nested/data.bin')!.body).toString())
      .toBe('artifact');
    expect(stored.artifacts.get('nested/data.bin')!.sensitivity).toBe('restricted');
    await expect(transaction.write({path: 'late.txt', mediaType: 'text/plain', body}))
      .rejects.toThrow(/closed/);
    await expect(transaction.commit({})).rejects.toThrow(/closed/);
    await transaction.rollback();
    await expect(fixture.store.begin('run/1')).rejects.toThrow(/already exists/);
    expect(fixture.events).toEqual([
      'begin:run/1', 'write:run/1:nested/data.bin', 'commit:run/1',
    ]);
  });

  it('rolls back once, closes the transaction, and releases the run ID for retry', async () => {
    const fixture = createMemoryArtifactStore();
    const transaction = await fixture.store.begin('retry');
    await transaction.write({path: 'old.txt', mediaType: 'text/plain', body: Buffer.from('old')});
    await transaction.rollback();
    await transaction.rollback();
    await expect(transaction.commit({})).rejects.toThrow(/closed/);
    const retry = await fixture.store.begin('retry');
    await retry.commit({status: 'passed'});
    expect(fixture.runs.get('retry')!.artifacts.size).toBe(0);
    expect(fixture.events).toEqual([
      'begin:retry', 'write:retry:old.txt', 'rollback:retry', 'begin:retry', 'commit:retry',
    ]);
  });
});

describe('createScriptedAgentAdapter', () => {
  it('copies turn records, preserves an aborted step, and fails on exhaustion', async () => {
    const turn = {text: 'first', sessionId: 'session-1', toolCalls: [{name: 'write'}], costUsd: 0.1};
    const fixture = createScriptedAgentAdapter({turns: [turn]});
    turn.text = 'changed';
    turn.toolCalls[0]!.name = 'changed';
    const plan = createTestResolvedRunPlan();
    const runtime = await createFakeRuntimeAdapter().adapter.prepare({
      runId: 'agent-test', plan, environment: {variables: {}, credentials: {}},
      requirements: {executables: [], stateDirectories: []}, signal: new AbortController().signal,
    });
    const session = await fixture.adapter.openSession({
      runId: 'agent-test', plan, selection: plan.agent, inputs: createMemoryRunInputProvider(),
      runtime, signal: new AbortController().signal,
    });
    expect(session.sessionId()).toBeUndefined();
    const cancelled = new AbortController();
    cancelled.abort(new Error('agent cancelled'));
    await expect(session.send('unused', {signal: cancelled.signal})).rejects.toThrow('agent cancelled');
    expect(fixture.messages).toEqual([]);
    const completed = await session.send('task', {signal: new AbortController().signal});
    expect(completed).toEqual({
      text: 'first', sessionId: 'session-1', toolCalls: [{name: 'write'}], costUsd: 0.1,
    });
    expect(session.sessionId()).toBe('session-1');
    await expect(session.send('extra', {signal: new AbortController().signal}))
      .rejects.toThrow(/no remaining turn/);
    expect(fixture.messages).toEqual(['task']);
    expect(fixture.events).toEqual(['open-session', 'send:1']);
    await runtime.dispose();
  });
});

describe('createStaticCredentialResolver', () => {
  it('snapshots explicit credentials and fails closed without observing aborted resolutions', async () => {
    const values = {'test.token': 'synthetic-value'};
    const calls: string[] = [];
    const resolver = createStaticCredentialResolver(values, {
      onResolve: (reference, purpose) => calls.push(`${reference}:${purpose}`),
    });
    values['test.token'] = 'changed';
    const context = {runId: 'credential-test', purpose: 'agent', signal: new AbortController().signal};
    await expect(resolver.resolve(credentialReference('test.token'), context))
      .resolves.toBe('synthetic-value');
    await expect(resolver.resolve(credentialReference('test.missing'), context))
      .rejects.toThrow(/No test credential/);
    const controller = new AbortController();
    controller.abort(new Error('credentials cancelled'));
    await expect(resolver.resolve(credentialReference('test.token'), {
      ...context, signal: controller.signal,
    })).rejects.toThrow('credentials cancelled');
    expect(calls).toEqual(['test.token:agent', 'test.missing:agent']);
  });
});

describe('createFakeRuntimeAdapter command barriers', () => {
  it('finalizes setup after its admitted writes while allowing an active agent command', async () => {
    const {fixture, prepared, setup, agent} = await prepareGatedRuntime();
    const activeSetup = prepared.commands.uncredentialed.run(['setup-wait']);
    let agentSettled = false;
    const activeAgent = prepared.commands.agent.run(['agent-wait'])
      .then((result) => { agentSettled = true; return result; });
    await Promise.all([setup.started, agent.started]);
    let finalized = false;
    const finalizing = prepared.finalizeSetup().then(() => { finalized = true; });
    try {
      await nextTurn();
      expect(finalized).toBe(false);
      await expect(prepared.commands.uncredentialed.run(['late']))
        .rejects.toThrow(/finalized/);
      await expect(prepared.commands.setup([]).run(['late']))
        .rejects.toThrow(/finalized/);
      setup.release();
      await activeSetup;
      await finalizing;
      expect(agentSettled).toBe(false);
      const state = prepared.stateDirectories.get('setup-state')!;
      expect(Buffer.from(await state.readFile('completed.txt')).toString()).toBe('setup-wait');
      await expect(state.writeFile('late.txt', Buffer.from('late'))).rejects.toThrow(/sealed/);
    } finally {
      setup.release();
      agent.release();
      await Promise.allSettled([activeSetup, activeAgent, finalizing]);
      await prepared.dispose();
    }
    expect(fixture.runs[0]!.events.filter((event) => event === 'finalizeSetup'))
      .toHaveLength(1);
  });

  it('shares quiescence while draining all admitted commands before exposing sealed bytes', async () => {
    const {fixture, prepared, setup, agent} = await prepareGatedRuntime();
    const activeSetup = prepared.commands.setup([]).run(['setup-wait']);
    const activeAgent = prepared.commands.agent.run(['agent-wait']);
    await Promise.all([setup.started, agent.started]);
    let settled = 0;
    const first = prepared.quiesce().then((sealed) => { settled += 1; return sealed; });
    const second = prepared.quiesce().then((sealed) => { settled += 1; return sealed; });
    try {
      await nextTurn();
      expect(settled).toBe(0);
      for (const commands of [
        prepared.commands.uncredentialed, prepared.commands.setup([]), prepared.commands.agent,
      ]) {
        await expect(commands.run(['late'])).rejects.toThrow(/closed/);
      }
      setup.release();
      await activeSetup;
      await nextTurn();
      expect(settled).toBe(0);
      agent.release();
      await activeAgent;
      const [sealed, concurrent] = await Promise.all([first, second]);
      expect(concurrent).toBe(sealed);
      expect(Buffer.from(await sealed.workspace.readFile('agent-wait.txt')).toString())
        .toBe('agent-wait');
      expect(Buffer.from(await sealed.stateDirectories.get('setup-state')!
        .readFile('completed.txt')).toString()).toBe('setup-wait');
      await expect(prepared.workspace.writeFile('late.txt', Buffer.from('late')))
        .rejects.toThrow(/sealed/);
    } finally {
      setup.release();
      agent.release();
      await Promise.allSettled([activeSetup, activeAgent, first, second]);
      await prepared.dispose();
    }
    expect(fixture.runs[0]!.events.filter((event) => event === 'quiesce'))
      .toHaveLength(1);
  });

  it('shares disposal and drains active command writes before completing cleanup', async () => {
    const {fixture, prepared, setup, agent} = await prepareGatedRuntime();
    const activeSetup = prepared.commands.uncredentialed.run(['setup-wait']);
    const activeAgent = prepared.commands.agent.run(['agent-wait']);
    await Promise.all([setup.started, agent.started]);
    let settled = 0;
    const first = prepared.dispose().then(() => { settled += 1; });
    const second = prepared.dispose().then(() => { settled += 1; });
    try {
      await nextTurn();
      expect(settled).toBe(0);
      await expect(prepared.commands.agent.run(['late'])).rejects.toThrow(/closed/);
      setup.release();
      await activeSetup;
      await nextTurn();
      expect(settled).toBe(0);
      agent.release();
      await activeAgent;
      await Promise.all([first, second]);
      expect(Buffer.from(await prepared.workspace.readFile('agent-wait.txt')).toString())
        .toBe('agent-wait');
      await expect(prepared.workspace.writeFile('late.txt', Buffer.from('late')))
        .rejects.toThrow(/sealed/);
      await expect(prepared.quiesce()).rejects.toThrow(/disposed before quiescence/);
    } finally {
      setup.release();
      agent.release();
      await Promise.allSettled([activeSetup, activeAgent, first, second]);
    }
    expect(fixture.runs[0]!.events.filter((event) => event === 'dispose'))
      .toHaveLength(1);
  });
});

function commandGate() {
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return {started, barrier, release, start};
}

async function prepareGatedRuntime() {
  const setup = commandGate();
  const agent = commandGate();
  const fixture = createFakeRuntimeAdapter({
    async command({argv}) {
      const gate = argv[0] === 'setup-wait' ? setup : agent;
      gate.start();
      await gate.barrier;
      const runtime = fixture.runs[0]!.prepared;
      await runtime.workspace.writeFile(`${argv[0]}.txt`, Buffer.from(argv[0]!));
      if (argv[0] === 'setup-wait') {
        await runtime.stateDirectories.get('setup-state')!
          .writeFile('completed.txt', Buffer.from(argv[0]));
      }
      return {stdout: '', stderr: '', exitCode: 0, durationMs: 0};
    },
  });
  const prepared = await fixture.adapter.prepare({
    runId: 'gated-runtime', plan: createTestResolvedRunPlan(),
    environment: {variables: {}, credentials: {}},
    requirements: {
      executables: [],
      stateDirectories: [{id: 'setup-state', containerPath: '/opt/setup', sealAfterSetup: true}],
    },
    signal: new AbortController().signal,
  });
  return {fixture, prepared, setup, agent};
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
