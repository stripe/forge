import type {RuntimePlatform} from '../../contracts/runtime.js';
import {
  createHostCommandRunner,
  type HostCommandRunner,
} from '../processCommandRunner.js';

export interface DetectDockerRuntimePlatformOptions {
  readonly dockerExecutable?: string;
  readonly hostCommands?: HostCommandRunner;
  readonly timeoutMs?: number;
}

/** Resolve Docker's server architecture to a concrete Forge runtime platform. */
export async function detectDockerRuntimePlatform(
  options: DetectDockerRuntimePlatformOptions = {},
): Promise<RuntimePlatform> {
  const dockerExecutable = options.dockerExecutable ?? 'docker';
  if (!dockerExecutable || dockerExecutable.includes('\0')) {
    throw new TypeError('dockerExecutable must be a non-empty command path.');
  }
  const result = await (options.hostCommands ?? createHostCommandRunner()).run(
    [dockerExecutable, 'info', '--format', '{{.Architecture}}'],
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error('Docker server architecture could not be detected.');
  }
  switch (result.stdout.trim()) {
    case 'amd64':
    case 'x86_64':
      return 'linux/amd64';
    case 'arm64':
    case 'aarch64':
      return 'linux/arm64';
    default:
      throw new Error('Docker server architecture is unsupported by Forge.');
  }
}
