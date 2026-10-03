import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {CommandExecutionError, type CommandResult} from '../../contracts/command.js';
import type {
  ResolvedCredentialEnvironmentBinding,
  ResolvedEnvironment,
} from '../../contracts/credentials.js';
import type {HostCommandOptions} from '../processCommandRunner.js';
import {DockerCommandController} from './commandRunner.js';

const roots: string[] = [];
const environment: ResolvedEnvironment = {
  variables: {PUBLIC_VALUE: 'visible'},
  credentials: {
    SETUP_TOKEN: {value: 'setup-test-token', scopes: ['setup']},
    UNRELATED_TOKEN: {value: 'unrelated-test-token', scopes: ['setup']},
    AGENT_TOKEN: {value: 'agent-test-token', scopes: ['agent']},
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

interface RecordedCall {
  readonly argv: readonly string[];
  readonly options: HostCommandOptions;
  environmentFile?: string;
  environmentBody?: string;
  environmentMode?: number;
}

async function fixture(options: {
  environment?: ResolvedEnvironment;
  run?: (call: RecordedCall) => Promise<CommandResult>;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docker-command-test-'));
  roots.push(root);
  const calls: RecordedCall[] = [];
  const controller = new DockerCommandController({
    dockerExecutable: '/test/docker',
    containerName: 'test-container',
    environment: options.environment ?? environment,
    environmentFileRoot: root,
    defaultTimeoutMs: 50,
    maximumTimeoutMs: 100,
    maximumOutputBytes: 128,
    hostCommands: {
      async run(argv, commandOptions) {
        const call: RecordedCall = {argv: [...argv], options: commandOptions};
        const environmentIndex = argv.indexOf('--env-file');
        if (environmentIndex >= 0) {
          call.environmentFile = argv[environmentIndex + 1]!;
          call.environmentBody = await fs.readFile(call.environmentFile, 'utf8');
          call.environmentMode = (await fs.stat(call.environmentFile)).mode & 0o777;
        }
        calls.push(call);
        return options.run === undefined ? result() : options.run(call);
      },
    },
  });
  return {controller, calls, root};
}

function result(exitCode = 0): CommandResult {
  return {stdout: 'output', stderr: '', exitCode, durationMs: 1};
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {resolve = complete;});
  return {promise, resolve};
}

describe('Docker command controller', () => {
  it('preserves valid special credential names in only their selected scopes', async () => {
    const credentials = Object.assign(
      Object.create(null) as Record<string, ResolvedCredentialEnvironmentBinding>,
      environment.credentials,
    );
    credentials.__proto__ = {value: 'proto-test-token', scopes: ['setup', 'agent']};
    const {controller, calls, root} = await fixture({
      environment: {variables: environment.variables, credentials},
    });

    await controller.withoutCredentials().run(['probe']);
    await controller.forScope('setup', ['SETUP_TOKEN', '__proto__']).run(['setup']);
    await controller.forScope('agent', ['AGENT_TOKEN', '__proto__']).run(['agent']);

    assert.deepEqual(calls.map((call) => call.environmentBody), [
      'PUBLIC_VALUE=visible',
      'PUBLIC_VALUE=visible\nSETUP_TOKEN=setup-test-token\n__proto__=proto-test-token',
      'AGENT_TOKEN=agent-test-token\nPUBLIC_VALUE=visible\n__proto__=proto-test-token',
    ]);
    for (const call of calls) {
      assert.equal(call.environmentMode, 0o600);
      assert.equal(call.options.environment, undefined);
      assert.equal(call.argv.some((argument) => argument.includes('test-token')), false);
    }
    assert.deepEqual(await fs.readdir(root), []);
  });

  it('closes admission, drains failures, and removes only settled command environment files', {timeout: 5_000}, async () => {
    const failingStarted = gate();
    const keepingStarted = gate();
    const releaseFailing = gate();
    const releaseKeeping = gate();
    const failure = new CommandExecutionError('Synthetic cancellation.', 'command_aborted');
    const {controller, calls, root} = await fixture({async run(call) {
      if (call.argv.includes('failing')) {
        failingStarted.resolve();
        await releaseFailing.promise;
        throw failure;
      }
      keepingStarted.resolve();
      await releaseKeeping.promise;
      return result(7);
    }});
    const signal = new AbortController().signal;
    const lines: string[] = [];
    const onStdoutLine = (line: string) => {lines.push(line);};
    const failing = controller.forScope('setup', ['SETUP_TOKEN']).run(
      ['failing', 'literal $value', 'a value'],
      {cwd: 'nested/directory', timeoutMs: 999, maxOutputBytes: 999, signal, onStdoutLine},
    );
    const failingRejected = assert.rejects(failing, (error: unknown) => error === failure);
    const keeping = controller.forScope('agent', ['AGENT_TOKEN']).run(['keeping']);
    let closing: Promise<void> | undefined;
    try {
      await Promise.all([failingStarted.promise, keepingStarted.promise]);
      const failedCall = calls.find((call) => call.argv.includes('failing'))!;
      const keptCall = calls.find((call) => call.argv.includes('keeping'))!;
      assert.notEqual(failedCall.environmentFile, keptCall.environmentFile);
      assert.equal(failedCall.environmentMode, 0o600);
      assert.equal(keptCall.environmentMode, 0o600);
      assert.deepEqual(failedCall.argv, [
        '/test/docker', 'exec', '--workdir', '/workspace/nested/directory',
        '--env-file', failedCall.environmentFile, 'test-container',
        'failing', 'literal $value', 'a value',
      ]);
      assert.equal(failedCall.options.timeoutMs, 100);
      assert.equal(failedCall.options.maxOutputBytes, 128);
      assert.equal(failedCall.options.signal, signal);
      assert.equal(failedCall.options.onStdoutLine, onStdoutLine);
      failedCall.options.onStdoutLine!('complete line');
      assert.deepEqual(lines, ['complete line']);

      let closed = false;
      closing = controller.closeAndWait();
      const closeRejected = assert.rejects(closing, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [failure]);
        return true;
      });
      void closing.then(() => {closed = true;}, () => {closed = true;});
      for (const commands of [
        controller.withoutCredentials(),
        controller.forScope('setup', ['SETUP_TOKEN']),
        controller.forScope('agent', ['AGENT_TOKEN']),
      ]) {
        await assert.rejects(commands.run(['late']), {code: 'command_runner_closed'});
      }
      await assert.rejects(controller.finalizeSetupAndWait(), {code: 'command_runner_closed'});
      assert.equal(closed, false);
      releaseFailing.resolve();
      await failingRejected;
      await assert.rejects(fs.stat(failedCall.environmentFile!), {code: 'ENOENT'});
      assert.equal(await fs.readFile(keptCall.environmentFile!, 'utf8'), keptCall.environmentBody);
      assert.equal(closed, false, 'closing must wait for the other active command');
      releaseKeeping.resolve();
      assert.equal((await keeping).exitCode, 7);
      await closeRejected;
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      releaseFailing.resolve();
      releaseKeeping.resolve();
      await Promise.allSettled([failing, keeping, ...(closing === undefined ? [] : [closing])]);
    }
  });

  it('finalizes setup admission while draining and retains agent and runtime probe commands', {timeout: 5_000}, async () => {
    const started = gate();
    const release = gate();
    const {controller, root} = await fixture({async run(call) {
      if (call.argv.includes('pending-setup')) {
        started.resolve();
        await release.promise;
      }
      return result();
    }});
    const uncredentialed = controller.withoutCredentials();
    const setup = controller.forScope('setup', ['SETUP_TOKEN']);
    const agent = controller.forScope('agent', ['AGENT_TOKEN']);
    const probe = controller.finalizedWithoutCredentials();
    await assert.rejects(probe.run(['probe']), {code: 'command_runner_closed'});
    const active = setup.run(['pending-setup']);
    let finalizing: Promise<void> | undefined;
    try {
      await started.promise;
      let finalized = false;
      finalizing = controller.finalizeSetupAndWait();
      void finalizing.then(() => {finalized = true;});
      for (const commands of [uncredentialed, setup]) {
        await assert.rejects(commands.run(['late-setup']), {code: 'command_runner_closed'});
      }
      await agent.run(['agent']);
      assert.equal(finalized, false);
      release.resolve();
      await Promise.all([active, finalizing]);
      await probe.run(['probe']);
      await assert.rejects(controller.finalizeSetupAndWait(), {code: 'command_runner_closed'});
      await controller.closeAndWait();
      await assert.rejects(agent.run(['late-agent']), {code: 'command_runner_closed'});
      await assert.rejects(probe.run(['late-probe']), {code: 'command_runner_closed'});
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      release.resolve();
      await Promise.allSettled([active, ...(finalizing === undefined ? [] : [finalizing])]);
    }
  });

  it('propagates an active setup command failure through the finalization barrier', {timeout: 5_000}, async () => {
    const started = gate();
    const release = gate();
    const failure = new Error('Synthetic setup command failure.');
    const {controller, root} = await fixture({async run() {
      started.resolve();
      await release.promise;
      throw failure;
    }});
    const active = controller.forScope('setup', ['SETUP_TOKEN']).run(['pending-setup']);
    const activeRejected = assert.rejects(active, (error: unknown) => error === failure);
    let finalizing: Promise<void> | undefined;
    try {
      await started.promise;
      finalizing = controller.finalizeSetupAndWait();
      const finalizationRejected = assert.rejects(finalizing, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [failure]);
        return true;
      });
      await assert.rejects(controller.withoutCredentials().run(['late']), {code: 'command_runner_closed'});
      release.resolve();
      await Promise.all([activeRejected, finalizationRejected]);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      release.resolve();
      await Promise.allSettled([active, ...(finalizing === undefined ? [] : [finalizing])]);
    }
  });

  it('rejects invalid projections and command inputs before issuing Docker commands', async () => {
    const {controller, calls, root} = await fixture();
    assert.throws(() => controller.forScope('setup', ['SETUP_TOKEN', 'SETUP_TOKEN']), /unique strings/);
    assert.throws(() => controller.forScope('setup', ['AGENT_TOKEN']), /not available/);
    assert.throws(() => controller.forScope('setup', ['missing']), /not available/);
    const commands = controller.withoutCredentials();
    await assert.rejects(commands.run([]), /argv/);
    await assert.rejects(commands.run(['tool', 'bad\0argument']), /argv/);
    await assert.rejects(commands.run(['tool'], {cwd: '../outside'}), /directory/);
    await assert.rejects(commands.run(['tool'], {timeoutMs: 0}), /positive integer/);
    await assert.rejects(commands.run(['tool'], {maxOutputBytes: 0}), /positive integer/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readdir(root), []);

    const unsafe = await fixture({environment: {variables: {VALUE: 'first\nsecond'}, credentials: {}}});
    await assert.rejects(unsafe.controller.withoutCredentials().run(['tool']), /cannot contain a newline/);
    assert.deepEqual(unsafe.calls, []);
    assert.deepEqual(await fs.readdir(unsafe.root), []);
  });
});
