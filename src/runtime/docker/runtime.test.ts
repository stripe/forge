import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import type {CommandResult} from '../../contracts/command.js';
import type {RuntimePreparation} from '../../contracts/runtime.js';
import type {ResolvedRunPlanV1} from '../../model/types.js';
import type {
  HostCommandOptions,
  HostCommandRunner,
} from '../processCommandRunner.js';
import {
  FORGE_CLAUDE_CODE_VERSION,
  FORGE_CODEX_VERSION,
  FORGE_RUNTIME_ASSET_DIGEST,
} from './assets.js';
import {
  createDockerRuntimeAdapter,
  validateDockerRuntimeHost,
} from './runtime.js';

const roots: string[] = [];
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

interface RecordedCall {
  argv: readonly string[];
  options: HostCommandOptions;
  environmentFile?: string;
  environmentBody?: string;
}

function fakeDocker(
  fixtureOptions: {
    missingExecutable?: string;
    hostProbeExitCode?: number;
    hostProbeError?: Error;
  } = {},
): {runner: HostCommandRunner; calls: RecordedCall[]} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    runner: {
      async run(argv, options): Promise<CommandResult> {
        const call: RecordedCall = {argv: [...argv], options};
        const environmentIndex = argv.indexOf('--env-file');
        if (environmentIndex >= 0) {
          call.environmentFile = argv[environmentIndex + 1]!;
          call.environmentBody = await fs.readFile(call.environmentFile!, 'utf8');
        }
        if (argv[1] === 'build') {
          const context = argv.at(-1)!;
          assert.deepEqual((await fs.readdir(context)).sort(), [
            'Dockerfile',
            'entrypoint.sh',
          ]);
          const dockerfile = await fs.readFile(path.join(context, 'Dockerfile'), 'utf8');
          assert.match(
            dockerfile,
            new RegExp(`@anthropic-ai/claude-code@${FORGE_CLAUDE_CODE_VERSION}`),
          );
          assert.ok(dockerfile.includes(`@openai/codex@${FORGE_CODEX_VERSION} \\\n`));
          for (const executable of ['claude', 'codex']) {
            assert.ok(dockerfile.includes(`test -x /usr/local/bin/${executable}`));
            assert.ok(dockerfile.includes(`/usr/local/bin/${executable} --version`));
          }
          assert.match(dockerfile, /USER 10001:10001/);
        }
        calls.push(call);
        const missingExecutable =
          argv.includes('forge-executable-check') &&
          argv.at(-1) === fixtureOptions.missingExecutable;
        const hostProbe =
          argv[1] === 'run' && argv.includes('--entrypoint');
        if (hostProbe && fixtureOptions.hostProbeError) {
          throw fixtureOptions.hostProbeError;
        }
        return {
          stdout: argv[1] === 'image' ? `${IMAGE_ID}\n` : 'ok\n',
          stderr: '',
          exitCode: missingExecutable
            ? 127
            : hostProbe
              ? (fixtureOptions.hostProbeExitCode ?? 0)
              : 0,
          durationMs: 1,
        };
      },
    },
  };
}

function preparation(overrides: Partial<RuntimePreparation> = {}): RuntimePreparation {
  const controller = new AbortController();
  return {
    runId: 'run-123',
    plan: {
      runtime: {
        adapter: 'docker',
        image: {kind: 'forge'},
        platform: 'linux/amd64',
        resources: {
          memory_bytes: 1024 * 1024 * 1024,
          cpu_count: 2,
          process_count: 128,
        },
      },
      limits: {run_timeout_ms: 60_000},
    } as ResolvedRunPlanV1,
    environment: {
      variables: {PUBLIC_VALUE: 'visible'},
      credentials: {
        SETUP_SECRET: {value: 'setup-secret-value', scopes: ['setup']},
        UNRELATED_SETUP_SECRET: {
          value: 'unrelated-setup-secret-value',
          scopes: ['setup'],
        },
        AGENT_SECRET: {value: 'agent-secret-value', scopes: ['agent']},
      },
    },
    requirements: {
      executables: ['claude'],
      stateDirectories: [
        {id: 'claude-projects', containerPath: '/home/forge/.claude/projects'},
      ],
    },
    signal: controller.signal,
    ...overrides,
  };
}

describe('Forge Docker runtime', () => {
  it('validates a host by building and inspecting the selected image', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-host-test-'),
    );
    roots.push(temporaryRoot);
    const docker = fakeDocker();

    const validated = await validateDockerRuntimeHost({
      platform: 'linux/arm64',
      dockerExecutable: '/opt/test-docker',
      hostCommands: docker.runner,
      temporaryRoot,
    });

    assert.deepEqual(validated, {
      platform: 'linux/arm64',
      imageId: IMAGE_ID,
    });
    const build = docker.calls.find((call) => call.argv[1] === 'build')!;
    assert.ok(build.argv.includes('linux/arm64'));
    assert.ok(
      docker.calls.some(
        (call) =>
          call.argv[1] === 'image' && call.argv[2] === 'inspect',
      ),
    );
    const probe = docker.calls.find(
      (call) => call.argv[1] === 'run' && call.argv.includes('--entrypoint'),
    )!;
    assert.deepEqual(probe.argv.slice(0, 4), [
      '/opt/test-docker',
      'run',
      '--rm',
      '--name',
    ]);
    const probeName = probe.argv[4]!;
    assert.match(probeName, /^stripe-forge-host-probe-[0-9a-f-]+$/);
    assert.deepEqual(probe.argv.slice(5), [
      '--platform',
      'linux/arm64',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--entrypoint',
      '/bin/sh',
      IMAGE_ID,
      '-c',
      'exit 0',
    ]);
    assert.ok(
      docker.calls.some(
        (call) =>
          call.argv[1] === 'rm' &&
          call.argv.includes('--force') &&
          call.argv.at(-1) === probeName,
      ),
    );
  });

  it('rejects a built image that the Docker host cannot execute', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-host-failure-test-'),
    );
    roots.push(temporaryRoot);
    const docker = fakeDocker({hostProbeExitCode: 125});

    await assert.rejects(
      validateDockerRuntimeHost({
        platform: 'linux/amd64',
        dockerExecutable: '/opt/test-docker',
        hostCommands: docker.runner,
        temporaryRoot,
      }),
      /could not execute/,
    );
  });

  it('force-removes the probe container when its command is interrupted', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-host-interrupted-test-'),
    );
    roots.push(temporaryRoot);
    const docker = fakeDocker({hostProbeError: new Error('interrupted')});

    await assert.rejects(
      validateDockerRuntimeHost({
        platform: 'linux/arm64',
        dockerExecutable: '/opt/test-docker',
        hostCommands: docker.runner,
        temporaryRoot,
      }),
      /interrupted/,
    );
    const probe = docker.calls.find(
      (call) => call.argv[1] === 'run' && call.argv.includes('--entrypoint'),
    )!;
    const probeName = probe.argv[probe.argv.indexOf('--name') + 1]!;
    assert.ok(
      docker.calls.some(
        (call) =>
          call.argv[1] === 'rm' &&
          call.argv.includes('--force') &&
          call.argv.at(-1) === probeName,
      ),
    );
  });

  it('builds isolated Forge assets and enforces non-root, bounded, sealed execution', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docker-test-'));
    roots.push(temporaryRoot);
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      dockerExecutable: '/opt/test-docker',
      hostCommands: docker.runner,
      temporaryRoot,
      maximumCommandOutputBytes: 4096,
    });

    const prepared = await adapter.prepare(preparation());
    assert.equal(prepared.paths.workspace, '/workspace');
    assert.equal(prepared.paths.home, '/home/forge');
    assert.ok(prepared.stateDirectories.has('claude-projects'));

    const build = docker.calls.find((call) => call.argv[1] === 'build')!;
    assert.deepEqual(build.argv.slice(0, 4), [
      '/opt/test-docker',
      'build',
      '--platform',
      'linux/amd64',
    ]);
    await assert.rejects(fs.stat(build.argv.at(-1)!));

    const run = docker.calls.find((call) => call.argv[1] === 'run')!;
    assert.equal(run.argv[0], '/opt/test-docker');
    assert.ok(run.argv.includes('--read-only'));
    assert.ok(run.argv.includes('10001:10001'));
    assert.ok(run.argv.includes('no-new-privileges:true'));
    assert.ok(run.argv.includes(IMAGE_ID));
    assert.ok(
      run.argv.some((argument) =>
        argument.includes('target=/home/forge/.claude/projects'),
      ),
    );

    await prepared.commands.uncredentialed.run(['probe-tool']);
    const setupCommands = prepared.commands.setup(['SETUP_SECRET']);
    await setupCommands.run(['setup-tool'], {timeoutMs: 999_999});
    await prepared.finalizeSetup();
    assert.equal(docker.calls.filter((call) => call.argv[1] === 'run').length, 1);
    assert.equal(docker.calls.some((call) => call.argv[1] === 'stop'), false);
    await prepared.commands.agent.run(['claude', '--version']);
    assert.throws(
      () => prepared.commands.setup(['AGENT_SECRET']),
      /not available in setup scope/,
    );
    const execs = docker.calls.filter((call) => call.argv[1] === 'exec');
    assert.equal(execs.length, 4);
    const executableCheck = execs.find((call) =>
      call.argv.includes('forge-executable-check'),
    )!;
    const uncredentialed = execs.find((call) => call.argv.includes('probe-tool'))!;
    const setup = execs.find((call) => call.argv.includes('setup-tool'))!;
    const agent = execs.find((call) => call.argv.includes('--version'))!;
    for (const call of [executableCheck, uncredentialed]) {
      assert.match(call.environmentBody!, /PUBLIC_VALUE=visible/);
      assert.doesNotMatch(call.environmentBody!, /SETUP_SECRET|AGENT_SECRET/);
    }
    assert.match(setup.environmentBody!, /SETUP_SECRET=setup-secret-value/);
    assert.doesNotMatch(setup.environmentBody!, /UNRELATED_SETUP_SECRET/);
    assert.doesNotMatch(setup.environmentBody!, /AGENT_SECRET/);
    assert.match(agent.environmentBody!, /AGENT_SECRET=agent-secret-value/);
    assert.doesNotMatch(agent.environmentBody!, /SETUP_SECRET/);
    assert.equal(setup.options.timeoutMs, 60_000);
    assert.equal(setup.options.environment, undefined);
    assert.equal(
      docker.calls.some((call) =>
        call.argv.some((argument) => argument.includes('secret-value')),
      ),
      false,
    );
    await Promise.all(execs.map((call) => assert.rejects(fs.stat(call.environmentFile!))));

    await prepared.stateDirectories
      .get('claude-projects')!
      .writeFile('session.jsonl', Buffer.from('evidence'));
    const sealed = await prepared.quiesce();
    assert.equal(
      Buffer.from(
        await sealed.stateDirectories
          .get('claude-projects')!
          .readFile('session.jsonl'),
      ).toString(),
      'evidence',
    );
    assert.equal(sealed.metadata.imageId, IMAGE_ID);
    assert.equal(
      sealed.metadata.imageAssetDigest,
      `sha256:${FORGE_RUNTIME_ASSET_DIGEST}`,
    );
    assert.equal(sealed.metadata.claudeCodeVersion, FORGE_CLAUDE_CODE_VERSION);
    assert.equal(sealed.metadata.codexVersion, FORGE_CODEX_VERSION);
    for (const commands of [
      prepared.commands.uncredentialed,
      setupCommands,
      prepared.commands.agent,
    ]) {
      await assert.rejects(commands.run(['true']), /quiesced/);
    }
    await assert.rejects(
      prepared.workspace.writeFile('late.txt', Buffer.from('late')),
      /quiesced/,
    );
    await assert.rejects(
      prepared.stateDirectories
        .get('claude-projects')!
        .writeFile('late.jsonl', Buffer.from('late')),
      /quiesced/,
    );
    assert.equal('writeFile' in sealed.workspace, false);

    const workspaceMount = run.argv.find(
      (argument) => argument.includes('target=/workspace'),
    )!;
    const runRoot = path.dirname(
      workspaceMount.match(/source=([^,]+)/)![1]!,
    );
    await Promise.all([prepared.dispose(), prepared.dispose()]);
    assert.equal(
      docker.calls.filter((call) => call.argv[1] === 'rm').length,
      1,
    );
    await assert.rejects(fs.stat(runRoot));
  });

  it('rejects unsafe logical state mounts before invoking Docker', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docker-test-'));
    roots.push(temporaryRoot);
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    await assert.rejects(
      adapter.prepare(
        preparation({
          requirements: {
            executables: [],
            stateDirectories: [{id: 'bad', containerPath: '/etc/forge'}],
          },
        }),
      ),
      /canonical child/,
    );
    assert.equal(docker.calls.length, 0);
  });

  it('supports writable Codex state without weakening Docker isolation', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docker-test-'));
    roots.push(temporaryRoot);
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        environment: {
          variables: {CODEX_HOME: '/home/forge/.codex'},
          credentials: {
            CODEX_API_KEY: {value: 'codex-test-secret', scopes: ['agent']},
          },
        },
        requirements: {
          executables: ['codex'],
          stateDirectories: [{id: 'codex-home', containerPath: '/home/forge/.codex'}],
        },
      }),
    );
    const run = docker.calls.find((call) => call.argv[1] === 'run')!;
    assert.ok(run.argv.includes('--read-only'));
    assert.ok(run.argv.includes('10001:10001'));
    assert.ok(run.argv.includes('no-new-privileges:true'));
    assert.equal(run.argv[run.argv.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(
      run.argv[run.argv.indexOf('--tmpfs') + 1],
      '/tmp:rw,nosuid,nodev,noexec,size=268435456',
    );
    const codexMount = run.argv.find((argument) =>
      argument.includes('target=/home/forge/.codex'),
    )!;
    assert.ok(codexMount);
    assert.doesNotMatch(codexMount, /,readonly$/);
    const executableCheck = docker.calls.find((call) =>
      call.argv.includes('forge-executable-check'),
    )!;
    assert.equal(executableCheck.argv.at(-1), 'codex');
    assert.match(executableCheck.environmentBody!, /CODEX_HOME=\/home\/forge\/\.codex/);
    assert.doesNotMatch(executableCheck.environmentBody!, /CODEX_API_KEY/);

    await prepared.finalizeSetup();
    await prepared.commands.agent.run(['codex', '--version']);
    const agent = docker.calls.find((call) => call.argv.includes('--version'))!;
    assert.match(agent.environmentBody!, /CODEX_API_KEY=codex-test-secret/);
    await prepared.stateDirectories
      .get('codex-home')!
      .writeFile('session.jsonl', Buffer.from('codex evidence'));
    const sealed = await prepared.quiesce();
    assert.equal(
      Buffer.from(await sealed.stateDirectories.get('codex-home')!.readFile('session.jsonl'))
        .toString(),
      'codex evidence',
    );
    assert.equal(sealed.metadata.codexVersion, FORGE_CODEX_VERSION);
    await assert.rejects(prepared.commands.agent.run(['codex', '--version']), /quiesced/);
    await prepared.dispose();
  });

  it('restarts with setup-sealed state read-only before agent commands', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docker-test-'));
    roots.push(temporaryRoot);
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      dockerExecutable: '/opt/test-docker',
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        requirements: {
          executables: ['claude'],
          stateDirectories: [
            {
              id: 'immutable-fixture',
              containerPath: '/home/forge/.forge/immutable-fixture',
              sealAfterSetup: true,
            },
            {
              id: 'claude-projects',
              containerPath: '/home/forge/.claude/projects',
            },
          ],
        },
      }),
    );
    const setupCommands = prepared.commands.setup(['SETUP_SECRET']);
    await prepared.stateDirectories
      .get('immutable-fixture')!
      .writeFile('fixture.txt', Buffer.from('pinned'));
    await prepared.finalizeSetup();

    const runs = docker.calls.filter((call) => call.argv[1] === 'run');
    assert.equal(runs.length, 2);
    const initialFixtureMount = runs[0]!.argv.find((argument) =>
      argument.includes('target=/home/forge/.forge/immutable-fixture'),
    )!;
    const sealedFixtureMount = runs[1]!.argv.find((argument) =>
      argument.includes('target=/home/forge/.forge/immutable-fixture'),
    )!;
    const interactionProjectsMount = runs[1]!.argv.find((argument) =>
      argument.includes('target=/home/forge/.claude/projects'),
    )!;
    assert.doesNotMatch(initialFixtureMount, /,readonly$/);
    assert.match(sealedFixtureMount, /,readonly$/);
    assert.doesNotMatch(interactionProjectsMount, /,readonly$/);
    assert.equal(
      docker.calls.filter((call) => call.argv[1] === 'stop').length,
      1,
    );
    await assert.rejects(
      prepared.stateDirectories
        .get('immutable-fixture')!
        .writeFile('late.txt', Buffer.from('late')),
      /quiesced/,
    );
    await prepared.stateDirectories
      .get('claude-projects')!
      .writeFile('session.jsonl', Buffer.from('mutable'));
    await assert.rejects(prepared.commands.uncredentialed.run(['true']), /finalized/);
    await assert.rejects(setupCommands.run(['true']), /finalized/);
    await prepared.commands.agent.run(['claude', '--version']);
    await assert.rejects(prepared.finalizeSetup(), /already been finalized/);

    await prepared.quiesce();
    await prepared.dispose();
  });

  it('rejects missing executable requirements and disposes the runtime', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docker-test-'));
    roots.push(temporaryRoot);
    const docker = fakeDocker({missingExecutable: 'missing-agent'});
    const adapter = createDockerRuntimeAdapter({
      dockerExecutable: '/opt/test-docker',
      hostCommands: docker.runner,
      temporaryRoot,
    });

    await assert.rejects(
      adapter.prepare(
        preparation({
          requirements: {
            executables: ['missing-agent'],
            stateDirectories: [],
          },
        }),
      ),
      /Required runtime executable is unavailable/,
    );
    assert.equal(
      docker.calls.filter((call) => call.argv[1] === 'rm').length,
      1,
    );
  });
});
