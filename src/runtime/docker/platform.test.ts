import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {CommandResult} from '../../contracts/command.js';
import type {HostCommandRunner} from '../processCommandRunner.js';
import {detectDockerRuntimePlatform} from './platform.js';

describe('detectDockerRuntimePlatform', () => {
  for (const [architecture, expected] of [
    ['amd64', 'linux/amd64'],
    ['x86_64', 'linux/amd64'],
    ['arm64', 'linux/arm64'],
    ['aarch64', 'linux/arm64'],
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
        ['/test/docker', 'info', '--format', '{{.Architecture}}'],
      ]);
    });
  }

  it('rejects unsupported Docker architectures', async () => {
    const runner: HostCommandRunner = {
      async run(): Promise<CommandResult> {
        return {
          stdout: 'riscv64\n',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        };
      },
    };
    await assert.rejects(
      detectDockerRuntimePlatform({hostCommands: runner}),
      /unsupported/,
    );
  });
});
