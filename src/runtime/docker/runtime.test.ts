import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { CommandResult } from '../../contracts/command.js';
import type { RuntimePreparation } from '../../contracts/runtime.js';
import type { ResolvedRunPlanV1 } from '../../model/types.js';
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
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
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
    executableAvailable?: (executable: string) => boolean | Promise<boolean>;
    beforeResult?: (
      argv: readonly string[],
      options: HostCommandOptions,
    ) => void | Promise<void>;
    hostProbeExitCode?: number;
    hostProbeError?: Error;
  } = {},
): { runner: HostCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    runner: {
      async run(argv, options): Promise<CommandResult> {
        const call: RecordedCall = { argv: [...argv], options };
        const environmentIndex = argv.indexOf('--env-file');
        if (environmentIndex >= 0) {
          call.environmentFile = argv[environmentIndex + 1]!;
          call.environmentBody = await fs.readFile(
            call.environmentFile!,
            'utf8',
          );
        }
        if (argv[1] === 'build') {
          const context = argv.at(-1)!;
          assert.deepEqual((await fs.readdir(context)).sort(), [
            'Dockerfile',
            'entrypoint.sh',
          ]);
          const dockerfile = await fs.readFile(
            path.join(context, 'Dockerfile'),
            'utf8',
          );
          assert.match(
            dockerfile,
            new RegExp(
              `@anthropic-ai/claude-code@${FORGE_CLAUDE_CODE_VERSION}`,
            ),
          );
          assert.ok(
            dockerfile.includes(`@openai/codex@${FORGE_CODEX_VERSION} \\\n`),
          );
          for (const executable of ['claude', 'codex']) {
            assert.ok(
              dockerfile.includes(`test -x /usr/local/bin/${executable}`),
            );
            assert.ok(
              dockerfile.includes(`/usr/local/bin/${executable} --version`),
            );
          }
          assert.match(dockerfile, /ARG FORGE_UID=10001/);
          assert.match(dockerfile, /USER forge:forge/);
        }
        calls.push(call);
        await fixtureOptions.beforeResult?.(argv, options);
        const namedMissingExecutable =
          argv.includes('forge-executable-check') &&
          argv.at(-1) === fixtureOptions.missingExecutable;
        const missingExecutable =
          namedMissingExecutable &&
          !(
            (await fixtureOptions.executableAvailable?.(argv.at(-1)!)) ?? false
          );
        const hostProbe = argv[1] === 'run' && argv.includes('--entrypoint');
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

function preparation(
  overrides: Partial<RuntimePreparation> = {},
): RuntimePreparation {
  const controller = new AbortController();
  return {
    runId: 'run-123',
    plan: {
      runtime: {
        adapter: 'docker',
        image: { kind: 'forge' },
        platform: 'linux/amd64',
        resources: {
          memory_bytes: 1024 * 1024 * 1024,
          cpu_count: 2,
          process_count: 128,
        },
      },
      limits: { run_timeout_ms: 60_000 },
    } as ResolvedRunPlanV1,
    environment: {
      variables: { PUBLIC_VALUE: 'visible' },
      credentials: {
        SETUP_SECRET: { value: 'setup-secret-value', scopes: ['setup'] },
        UNRELATED_SETUP_SECRET: {
          value: 'unrelated-setup-secret-value',
          scopes: ['setup'],
        },
        AGENT_SECRET: { value: 'agent-secret-value', scopes: ['agent'] },
      },
    },
    requirements: {
      executables: ['claude'],
      stateDirectories: [
        {
          id: 'claude-projects',
          containerPath: '/home/forge/.claude/projects',
        },
      ],
    },
    signal: controller.signal,
    ...overrides,
  };
}

describe('Forge Docker runtime', () => {
  it('uses an unversioned built-in adapter identity', () => {
    const adapter = createDockerRuntimeAdapter();
    assert.equal(adapter.id, 'forge/docker');
    assert.equal(Object.hasOwn(adapter, 'version'), false);
  });

  for (const cancelledIndex of [0, 1]) {
    it(`isolates cancellation of image-build ${cancelledIndex === 0 ? 'starter' : 'follower'} from other evals`, async () => {
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-docker-build-test-'),
      );
      roots.push(temporaryRoot);
      const buildStarted = createGate();
      const releaseBuild = createGate();
      const docker = fakeDocker({
        async beforeResult(argv, options) {
          if (argv[1] !== 'build') return;
          buildStarted.resolve();
          await releaseBuild.promise;
          options.signal?.throwIfAborted();
        },
      });
      const adapter = createDockerRuntimeAdapter({
        hostCommands: docker.runner,
        temporaryRoot,
      });
      const controllers = [new AbortController(), new AbortController()];
      const preparing = controllers.map((controller, index) =>
        adapter.prepare(
          preparation({
            runId: `run-${index}`,
            signal: controller.signal,
          }),
        ),
      );
      const outcomes = preparing.map((promise) =>
        promise.then(
          (runtime) => ({ runtime }),
          (error: unknown) => ({ error }),
        ),
      );
      try {
        await waitFor(buildStarted.promise);
        let cancelledFinished = false;
        void outcomes[cancelledIndex]!.then(() => {
          cancelledFinished = true;
        });
        const reason = new Error('This eval timed out.');
        controllers[cancelledIndex]!.abort(reason);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          cancelledFinished,
          true,
          'cancelled eval must stop waiting before the build completes',
        );
        assert.deepEqual(await outcomes[cancelledIndex]!, { error: reason });
        const build = docker.calls.find((call) => call.argv[1] === 'build')!;
        assert.equal(
          build.options.signal!.aborted,
          false,
          'a sibling still needs the shared build',
        );
        assert.equal(
          docker.calls.some((call) => call.argv[1] === 'run'),
          false,
        );

        releaseBuild.resolve();
        const sibling = await preparing[1 - cancelledIndex]!;
        assert.equal(sibling.paths.workspace, '/workspace');
        const reused = adapter.prepare(preparation({ runId: 'reused' }));
        preparing.push(reused);
        await reused;
        assert.equal(
          docker.calls.filter((call) => call.argv[1] === 'build').length,
          1,
        );
      } finally {
        for (const controller of controllers) controller.abort();
        releaseBuild.resolve();
        const settled = await Promise.allSettled(preparing);
        await Promise.all(
          settled.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value.dispose()] : [],
          ),
        );
      }
    });
  }

  it('cancels and drains an unused build without evicting its replacement', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-build-test-'),
    );
    roots.push(temporaryRoot);
    const buildStarted = createGate();
    const buildAborted = createGate();
    const releaseCleanup = createGate();
    const replacementStarted = createGate();
    const releaseReplacement = createGate();
    let builds = 0;
    const docker = fakeDocker({
      async beforeResult(argv, options) {
        if (argv[1] !== 'build') return;
        if (++builds === 1) {
          buildStarted.resolve();
          options.signal!.throwIfAborted();
          await new Promise<void>((resolve) =>
            options.signal!.addEventListener(
              'abort',
              () => {
                buildAborted.resolve();
                resolve();
              },
              { once: true },
            ),
          );
          await releaseCleanup.promise;
        } else {
          replacementStarted.resolve();
          await releaseReplacement.promise;
        }
        options.signal!.throwIfAborted();
      },
    });
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const cancelled = new AbortController();
    const replacement = new AbortController();
    const preparing = [0, 1].map((index) =>
      adapter.prepare(
        preparation({
          runId: `cancelled-${index}`,
          signal: cancelled.signal,
        }),
      ),
    );
    const cancellations = Promise.allSettled(preparing);
    try {
      await waitFor(buildStarted.promise);
      let drained = false;
      void cancellations.then(() => {
        drained = true;
      });
      cancelled.abort(new Error('Experiment run cancelled.'));
      await waitFor(buildAborted.promise);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false, 'the last waiter must await build cleanup');
      const buildRoot = docker.calls
        .find((call) => call.argv[1] === 'build')!
        .argv.at(-1)!;
      assert.ok((await fs.stat(buildRoot)).isDirectory());

      const fresh = adapter.prepare(
        preparation({ runId: 'fresh', signal: replacement.signal }),
      );
      preparing.push(fresh);
      await waitFor(replacementStarted.promise);
      releaseCleanup.resolve();
      const cancelledOutcomes = await cancellations;
      assert.ok(
        cancelledOutcomes.every(
          (result) =>
            result.status === 'rejected' &&
            result.reason === cancelled.signal.reason,
        ),
      );
      await assert.rejects(fs.stat(buildRoot), { code: 'ENOENT' });

      const joined = adapter.prepare(
        preparation({ runId: 'joined', signal: replacement.signal }),
      );
      preparing.push(joined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        builds,
        2,
        'the old build failure must not evict the new build',
      );
      releaseReplacement.resolve();
      await Promise.all([fresh, joined]);
    } finally {
      cancelled.abort();
      replacement.abort();
      releaseCleanup.resolve();
      releaseReplacement.resolve();
      const settled = await Promise.allSettled(preparing);
      await Promise.all(
        settled.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value.dispose()] : [],
        ),
      );
    }
  });

  it('shares genuine build failures and retries with a fresh build', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-build-test-'),
    );
    roots.push(temporaryRoot);
    const releaseBuild = createGate();
    const buildStarted = createGate();
    const failure = new Error('Docker build failed.');
    let builds = 0;
    const docker = fakeDocker({
      async beforeResult(argv) {
        if (argv[1] !== 'build' || ++builds !== 1) return;
        buildStarted.resolve();
        await releaseBuild.promise;
        throw failure;
      },
    });
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const preparing = [0, 1].map((index) =>
      adapter.prepare(preparation({ runId: `failed-${index}` })),
    );
    const failures = preparing.map((promise) =>
      assert.rejects(promise, (error: unknown) => error === failure),
    );
    try {
      await waitFor(buildStarted.promise);
      releaseBuild.resolve();
      await Promise.all(failures);
      const retry = adapter.prepare(preparation({ runId: 'retry' }));
      preparing.push(retry);
      await retry;
      assert.equal(builds, 2);
    } finally {
      releaseBuild.resolve();
      const settled = await Promise.allSettled(preparing);
      await Promise.all(
        settled.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value.dispose()] : [],
        ),
      );
    }
  });

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
        (call) => call.argv[1] === 'image' && call.argv[2] === 'inspect',
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
    const docker = fakeDocker({ hostProbeExitCode: 125 });

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
    const docker = fakeDocker({ hostProbeError: new Error('interrupted') });

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
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
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
    const buildArgIndex = build.argv.indexOf('--build-arg');
    const expectedUserId =
      typeof process.getuid === 'function' && process.getuid() > 0
        ? process.getuid()
        : 10001;
    assert.equal(build.argv[buildArgIndex + 1], `FORGE_UID=${expectedUserId}`);
    await assert.rejects(fs.stat(build.argv.at(-1)!));

    const run = docker.calls.find((call) => call.argv[1] === 'run')!;
    assert.equal(run.argv[0], '/opt/test-docker');
    assert.ok(run.argv.includes('--read-only'));
    assert.ok(run.argv.includes('forge:forge'));
    assert.ok(run.argv.includes('no-new-privileges:true'));
    assert.ok(run.argv.includes(IMAGE_ID));
    assert.ok(
      run.argv.some((argument) =>
        argument.includes('target=/home/forge/.claude/projects'),
      ),
    );

    await prepared.commands.uncredentialed.run(['probe-tool']);
    const setupCommands = prepared.commands.setup(['SETUP_SECRET']);
    await setupCommands.run(['setup-tool'], { timeoutMs: 999_999 });
    await prepared.finalizeSetup();
    assert.equal(
      docker.calls.filter((call) => call.argv[1] === 'run').length,
      1,
    );
    assert.equal(
      docker.calls.some((call) => call.argv[1] === 'stop'),
      false,
    );
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
    const uncredentialed = execs.find((call) =>
      call.argv.includes('probe-tool'),
    )!;
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
    await Promise.all(
      execs.map((call) => assert.rejects(fs.stat(call.environmentFile!))),
    );

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
    assert.equal(sealed.metadata.adapter, 'forge/docker');
    assert.equal(
      sealed.metadata.imageAssetDigest,
      `sha256:${FORGE_RUNTIME_ASSET_DIGEST}`,
    );
    assert.equal(sealed.metadata.claudeCodeVersion, FORGE_CLAUDE_CODE_VERSION);
    assert.equal(sealed.metadata.codexVersion, FORGE_CODEX_VERSION);
    assert.equal(sealed.metadata.containerUserId, String(expectedUserId));
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

    const workspaceMount = run.argv.find((argument) =>
      argument.includes('target=/workspace'),
    )!;
    const runRoot = path.dirname(workspaceMount.match(/source=([^,]+)/)![1]!);
    await Promise.all([prepared.dispose(), prepared.dispose()]);
    assert.equal(
      docker.calls.filter((call) => call.argv[1] === 'rm').length,
      1,
    );
    await assert.rejects(fs.stat(runRoot));
  });

  it('creates writable home mount targets and parents before Docker can create root-owned paths', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
    roots.push(temporaryRoot);
    let starts = 0;
    const expectedUserId =
      typeof process.getuid === 'function'
        ? process.getuid() || 10001
        : undefined;
    const docker = fakeDocker({
      async beforeResult(argv) {
        if (argv[1] !== 'run') return;
        starts += 1;
        const homeMount = argv.find((argument) =>
          argument.endsWith('target=/home/forge'),
        )!;
        const homeRoot = homeMount.match(/source=([^,]+)/)![1]!;
        for (const relativePath of [
          '.claude',
          '.claude/projects',
          '.claude/plugins',
          '.cache',
          '.cache/tool',
          '.cache/tool/state',
        ]) {
          const stat = await fs.stat(path.join(homeRoot, relativePath));
          assert.ok(stat.isDirectory());
          if (process.platform !== 'win32')
            assert.equal(stat.mode & 0o777, 0o777);
          if (expectedUserId !== undefined)
            assert.equal(stat.uid, expectedUserId);
        }
        assert.deepEqual((await fs.readdir(homeRoot)).sort(), [
          '.cache',
          '.claude',
        ]);
      },
    });
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        requirements: {
          executables: [],
          stateDirectories: [
            { id: 'projects', containerPath: '/home/forge/.claude/projects' },
            {
              id: 'plugins',
              containerPath: '/home/forge/.claude/plugins',
              sealAfterSetup: true,
            },
            { id: 'cache', containerPath: '/home/forge/.cache/tool/state' },
            {
              id: 'host-tool',
              containerPath: '/opt/tool',
              sealAfterSetup: true,
            },
          ],
        },
      }),
    );
    try {
      await prepared.finalizeSetup();
      assert.equal(
        starts,
        2,
        'Targets must exist for setup and sealed containers',
      );
    } finally {
      await prepared.dispose();
    }
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  });

  it('rejects unsafe logical state mounts before invoking Docker', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
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
            stateDirectories: [{ id: 'bad', containerPath: '/etc/forge' }],
          },
        }),
      ),
      /canonical child/,
    );
    await assert.rejects(
      adapter.prepare(
        preparation({
          requirements: {
            executables: [],
            stateDirectories: [
              { id: 'bad', containerPath: '/home/forge/..\\escape' },
            ],
          },
        }),
      ),
      /canonical child/,
    );
    assert.equal(docker.calls.length, 0);
  });

  it('rejects equal state mount targets during pure preflight', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
    roots.push(temporaryRoot);
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    for (const sealAfterSetup of [false, true]) {
      assert.throws(
        () =>
          adapter.preflight({
            plan: preparation().plan,
            requirements: {
              executables: [],
              stateDirectories: [
                {
                  id: 'first',
                  containerPath: '/home/forge/state',
                  sealAfterSetup: false,
                },
                {
                  id: 'second',
                  containerPath: '/home/forge/state',
                  sealAfterSetup,
                },
              ],
            },
            environment: {},
          }),
        /may not overlap/,
      );
    }
    assert.deepEqual(docker.calls, []);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  });

  it('supports writable Codex state without weakening Docker isolation', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
    roots.push(temporaryRoot);
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        environment: {
          variables: { CODEX_HOME: '/home/forge/.codex' },
          credentials: {
            CODEX_API_KEY: { value: 'codex-test-secret', scopes: ['agent'] },
          },
        },
        requirements: {
          executables: ['codex'],
          stateDirectories: [
            { id: 'codex-home', containerPath: '/home/forge/.codex' },
          ],
        },
      }),
    );
    const run = docker.calls.find((call) => call.argv[1] === 'run')!;
    assert.ok(run.argv.includes('--read-only'));
    assert.ok(run.argv.includes('forge:forge'));
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
    await prepared.finalizeSetup();
    const executableCheck = docker.calls.find((call) =>
      call.argv.includes('forge-executable-check'),
    )!;
    assert.equal(executableCheck.argv.at(-1), 'codex');
    assert.match(
      executableCheck.environmentBody!,
      /CODEX_HOME=\/home\/forge\/\.codex/,
    );
    assert.doesNotMatch(executableCheck.environmentBody!, /CODEX_API_KEY/);

    await prepared.commands.agent.run(['codex', '--version']);
    const agent = docker.calls.find((call) => call.argv.includes('--version'))!;
    assert.match(agent.environmentBody!, /CODEX_API_KEY=codex-test-secret/);
    await prepared.stateDirectories
      .get('codex-home')!
      .writeFile('session.jsonl', Buffer.from('codex evidence'));
    const sealed = await prepared.quiesce();
    assert.equal(
      Buffer.from(
        await sealed.stateDirectories
          .get('codex-home')!
          .readFile('session.jsonl'),
      ).toString(),
      'codex evidence',
    );
    assert.equal(sealed.metadata.codexVersion, FORGE_CODEX_VERSION);
    await assert.rejects(
      prepared.commands.agent.run(['codex', '--version']),
      /quiesced/,
    );
    await prepared.dispose();
  });

  it('restarts with setup-sealed state read-only before agent commands', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
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
    await assert.rejects(
      prepared.commands.uncredentialed.run(['true']),
      /finalized/,
    );
    await assert.rejects(setupCommands.run(['true']), /finalized/);
    await prepared.commands.agent.run(['claude', '--version']);
    await assert.rejects(prepared.finalizeSetup(), /already been finalized/);

    await prepared.quiesce();
    await prepared.dispose();
  });

  it('streams a host file into sealed state and checks the installed bytes', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-import-test-'),
    );
    roots.push(temporaryRoot);
    const source = path.join(temporaryRoot, 'source-tool');
    const bytes = Buffer.alloc(129 * 1024, 0x5a);
    await fs.writeFile(source, bytes);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let importCompleted = false;
    const docker = fakeDocker({
      missingExecutable: '/opt/example-tool/bin/tool',
      executableAvailable: () => importCompleted,
    });
    const temporaryAlias = path.join(temporaryRoot, 'alias');
    await fs.symlink(temporaryRoot, temporaryAlias);
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot: temporaryAlias,
    });
    const prepareTool = () =>
      adapter.prepare(
        preparation({
          requirements: {
            executables: ['/opt/example-tool/bin/tool'],
            stateDirectories: [
              {
                id: 'tool-bin',
                containerPath: '/opt/example-tool/bin',
                sealAfterSetup: true,
              },
            ],
          },
        }),
      );
    const prepared = await prepareTool();
    assert.equal('importHostFile' in prepared, true);
    const request = {
      sourcePath: source,
      stateDirectoryId: 'tool-bin',
      relativePath: 'tool',
      maxBytes: bytes.byteLength,
      sha256,
      mode: 0o755,
      verifyAfterSetup: true,
    } as const;
    assert.equal(
      docker.calls.some((call) => call.argv.includes('forge-executable-check')),
      false,
    );
    await prepared.importHostFile!(request);
    importCompleted = true;
    const mount = docker.calls
      .find((call) => call.argv[1] === 'run')!
      .argv.find((argument) =>
        argument.includes('target=/opt/example-tool/bin'),
      )!;
    const mountedRoot = mount.match(/source=([^,]+)/)![1]!;
    assert.equal(
      (await fs.stat(path.join(mountedRoot, 'tool'))).mode & 0o777,
      0o755,
    );
    assert.deepEqual(
      Buffer.from(
        await prepared.stateDirectories.get('tool-bin')!.readFile('tool'),
      ),
      bytes,
    );
    await prepared.finalizeSetup();
    await assert.rejects(
      async () => prepared.importHostFile!(request),
      /no longer available/,
    );
    const runs = docker.calls.filter((call) => call.argv[1] === 'run');
    const restartedIndex = docker.calls.lastIndexOf(runs[1]!);
    const executableCheckIndex = docker.calls.findIndex((call) =>
      call.argv.includes('forge-executable-check'),
    );
    assert.ok(executableCheckIndex > restartedIndex);
    assert.match(
      runs[1]!.argv.find((argument) =>
        argument.includes('target=/opt/example-tool/bin'),
      )!,
      /,readonly$/,
    );
    await prepared.dispose();

    const changed = await prepareTool();
    await changed.importHostFile!(request);
    await changed.stateDirectories
      .get('tool-bin')!
      .writeFile('tool', Buffer.from('changed'));
    await assert.rejects(
      changed.finalizeSetup(),
      /differs from its expected SHA-256/,
    );
    await changed.dispose();
  });

  it('rejects unsafe, undeclared, oversized, and unsealed host imports', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-import-test-'),
    );
    roots.push(temporaryRoot);
    const source = path.join(temporaryRoot, 'source');
    await fs.writeFile(source, 'safe');
    const linkedSource = path.join(temporaryRoot, 'linked-source');
    await fs.symlink(source, linkedSource);
    const sha256 = `sha256:${createHash('sha256').update('safe').digest('hex')}`;
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        requirements: {
          executables: [],
          stateDirectories: [
            {
              id: 'sealed',
              containerPath: '/opt/example-tool/bin',
              sealAfterSetup: true,
            },
            { id: 'writable', containerPath: '/home/forge/writable' },
          ],
        },
      }),
    );
    const request = {
      sourcePath: source,
      stateDirectoryId: 'sealed',
      relativePath: 'tool',
      maxBytes: 4,
      sha256,
      verifyAfterSetup: true,
    } as const;
    await assert.rejects(async () =>
      prepared.importHostFile!({ ...request, sourcePath: linkedSource }),
    );
    await assert.rejects(
      async () =>
        prepared.importHostFile!({ ...request, stateDirectoryId: 'missing' }),
      /declared state directory/,
    );
    await assert.rejects(
      async () =>
        prepared.importHostFile!({ ...request, stateDirectoryId: 'writable' }),
      /requires a sealed state directory/,
    );
    await assert.rejects(
      async () =>
        prepared.importHostFile!({ ...request, relativePath: '../escape' }),
      /Invalid host file import/,
    );
    await assert.rejects(
      async () => prepared.importHostFile!({ ...request, maxBytes: 3 }),
      /bounded regular file/,
    );
    await assert.rejects(
      async () =>
        prepared.importHostFile!({
          ...request,
          sha256: `sha256:${'0'.repeat(64)}`,
        }),
      /does not match/,
    );
    const run = docker.calls.find((call) => call.argv[1] === 'run')!;
    const mount = run.argv.find((argument) =>
      argument.includes('target=/opt/example-tool/bin'),
    )!;
    const mountedRoot = mount.match(/source=([^,]+)/)![1]!;
    await assert.rejects(
      async () =>
        prepared.importHostFile!({ ...request, relativePath: 'nested/tool' }),
      /Invalid host file import/,
    );
    await fs.symlink(source, path.join(mountedRoot, 'linked-target'));
    await assert.rejects(
      async () =>
        prepared.importHostFile!({ ...request, relativePath: 'linked-target' }),
      /unsafe destination/,
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      async () => prepared.importHostFile!(request, abort.signal),
      /aborted/i,
    );
    await prepared.importHostFile!(request);
    await prepared.finalizeSetup();
    await prepared.dispose();
  });

  it('propagates an import that fails while setup is finalizing', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-import-test-'),
    );
    roots.push(temporaryRoot);
    const source = path.join(temporaryRoot, 'source');
    await fs.writeFile(source, 'safe');
    const adapter = createDockerRuntimeAdapter({
      hostCommands: fakeDocker().runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        requirements: {
          executables: [],
          stateDirectories: [
            {
              id: 'sealed',
              containerPath: '/opt/tool/bin',
              sealAfterSetup: true,
            },
          ],
        },
      }),
    );
    const abort = new AbortController();
    const importing = prepared.importHostFile!(
      {
        sourcePath: source,
        stateDirectoryId: 'sealed',
        relativePath: 'tool',
        maxBytes: 4,
        sha256: `sha256:${createHash('sha256').update('safe').digest('hex')}`,
      },
      abort.signal,
    );
    abort.abort();
    const importFailure = assert.rejects(importing, /aborted/i);
    await assert.rejects(
      prepared.finalizeSetup(),
      /Active host file imports failed/,
    );
    await importFailure;
    await prepared.dispose();
  });

  it('closes and drains setup commands before validating executables', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
    roots.push(temporaryRoot);
    let releaseSetup!: () => void;
    let reportSetupStarted!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      reportSetupStarted = resolve;
    });
    const setupReleased = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const docker = fakeDocker({
      async beforeResult(argv) {
        if (!argv.includes('slow-setup')) return;
        reportSetupStarted();
        await setupReleased;
      },
    });
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(preparation());
    const activeSetup = prepared.commands.setup([]).run(['slow-setup']);
    await setupStarted;

    const finalizing = prepared.finalizeSetup();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      docker.calls.some((call) => call.argv.includes('forge-executable-check')),
      false,
    );

    releaseSetup();
    await Promise.all([activeSetup, finalizing]);
    const setupIndex = docker.calls.findIndex((call) =>
      call.argv.includes('slow-setup'),
    );
    const validationIndex = docker.calls.findIndex((call) =>
      call.argv.includes('forge-executable-check'),
    );
    assert.ok(setupIndex >= 0 && validationIndex > setupIndex);
    await prepared.dispose();
  });

  it('requires a regular executable file instead of a command-v match', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
    roots.push(temporaryRoot);
    const executable = path.join(temporaryRoot, 'tool');
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const docker = fakeDocker();
    const adapter = createDockerRuntimeAdapter({
      hostCommands: docker.runner,
      temporaryRoot,
    });
    const prepared = await adapter.prepare(
      preparation({
        requirements: { executables: ['claude'], stateDirectories: [] },
      }),
    );
    await prepared.finalizeSetup();
    const check = docker.calls.find((call) =>
      call.argv.includes('forge-executable-check'),
    )!;
    const nodeIndex = check.argv.indexOf('/usr/local/bin/node');
    assert.ok(nodeIndex >= 0);
    const probeArguments = check.argv.slice(nodeIndex + 1, -1);
    const probe = (candidate: string) =>
      spawnSync(process.execPath, [...probeArguments, candidate], {
        cwd: temporaryRoot,
      });
    assert.equal(probe(executable).status, 0);
    assert.notEqual(probe('/etc/passwd').status, 0);
    assert.notEqual(probe('cd').status, 0);
    await prepared.dispose();
  });

  it('rejects missing executable requirements when setup is finalized', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-docker-test-'),
    );
    roots.push(temporaryRoot);
    const docker = fakeDocker({ missingExecutable: 'missing-agent' });
    const adapter = createDockerRuntimeAdapter({
      dockerExecutable: '/opt/test-docker',
      hostCommands: docker.runner,
      temporaryRoot,
    });

    const prepared = await adapter.prepare(
      preparation({
        requirements: {
          executables: ['missing-agent'],
          stateDirectories: [],
        },
      }),
    );
    await assert.rejects(
      prepared.finalizeSetup(),
      /Required runtime executable is unavailable/,
    );
    await prepared.dispose();
    assert.equal(
      docker.calls.filter((call) => call.argv[1] === 'rm').length,
      1,
    );
  });
});

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for test progress.')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
