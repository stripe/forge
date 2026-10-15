import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CommandResult } from '../../contracts/command.js';
import type { HostCommandRunner } from '../processCommandRunner.js';
import { detectDockerRuntimePlatform } from './platform.js';

describe('detectDockerRuntimePlatform', () => {
  for (const [architecture, expected] of [
    ['linux/amd64', 'linux/amd64'],
    ['linux/x86_64', 'linux/amd64'],
    ['linux/arm64', 'linux/arm64'],
    ['linux/aarch64', 'linux/arm64'],
  ] as const) {
    it(`maps ${architecture} to ${expected}`, async () => {
      const calls: string[][] = [];
      const runner: HostCommandRunner = {
        async run(argv): Promise<CommandResult> {
          calls.push([...argv]);
          return {
            stdout: `${architecture}\n`,
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          };
        },
      };
      assert.equal(
        await detectDockerRuntimePlatform({
          dockerExecutable: '/test/docker',
          hostCommands: runner,
        }),
        expected,
      );
      assert.deepEqual(calls, [
        ['/test/docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}'],
      ]);
    });
  }

  it('rejects unsupported Docker architectures', async () => {
    const runner: HostCommandRunner = {
      async run(): Promise<CommandResult> {
        return {
          stdout: 'linux/riscv64\n',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        };
      },
    };
    await assert.rejects(
      detectDockerRuntimePlatform({ hostCommands: runner }),
      /unsupported/,
    );
  });

  it('rejects non-Linux Docker servers', async () => {
    const runner: HostCommandRunner = {
      async run(): Promise<CommandResult> {
        return {
          stdout: 'windows/amd64\n',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        };
      },
    };
    await assert.rejects(
      detectDockerRuntimePlatform({ hostCommands: runner }),
      /unsupported/,
    );
  });

  it('forwards cancellation to Docker discovery', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner: HostCommandRunner = {
      async run(_argv, options): Promise<CommandResult> {
        options.signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    };
    await assert.rejects(
      detectDockerRuntimePlatform({
        hostCommands: runner,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
  });
});
