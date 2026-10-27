import { isIPv4 } from 'node:net';
import type { HostCommandRunner } from '../processCommandRunner.ts';

export interface McpRelayNetwork {
  readonly listenHost: string;
  readonly connectHost: string;
  readonly hostMapping?: string;
}

export async function resolveMcpRelayNetwork(input: {
  readonly hostPlatform: NodeJS.Platform;
  readonly network?: 'host';
  readonly dockerExecutable: string;
  readonly hostCommands: HostCommandRunner;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<McpRelayNetwork> {
  if (input.network === 'host')
    return Object.freeze({ listenHost: '127.0.0.1', connectHost: '127.0.0.1' });
  if (input.hostPlatform !== 'linux')
    return Object.freeze({
      listenHost: '127.0.0.1',
      connectHost: 'host.docker.internal',
    });
  const result = await input.hostCommands.run(
    [
      input.dockerExecutable,
      'network',
      'inspect',
      'bridge',
      '--format',
      '{{range .IPAM.Config}}{{println .Gateway}}{{end}}',
    ],
    { timeoutMs: input.timeoutMs, maxOutputBytes: 1024, signal: input.signal },
  );
  const gateways = result.stdout.trim().split(/\s+/).filter(isIPv4);
  if (
    result.exitCode !== 0 ||
    gateways.length !== 1 ||
    gateways[0] === '0.0.0.0'
  )
    throw new Error(
      'Docker bridge IPv4 gateway is unavailable for the MCP relay.',
    );
  return Object.freeze({
    listenHost: gateways[0]!,
    connectHost: 'host.docker.internal',
    hostMapping: `host.docker.internal:${gateways[0]}`,
  });
}
