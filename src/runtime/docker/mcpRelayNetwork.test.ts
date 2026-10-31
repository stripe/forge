import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { resolveMcpRelayNetwork } from './mcpRelayNetwork.ts';

describe('Docker MCP relay routing', () => {
  for (const hostPlatform of ['darwin', 'win32'] as const)
    it(`binds loopback behind Docker Desktop on ${hostPlatform}`, async () => {
      const route = await resolveMcpRelayNetwork({
        hostPlatform,
        dockerExecutable: 'docker',
        hostCommands: {
          async run() {
            throw new Error('Unexpected network lookup');
          },
        },
        timeoutMs: 100,
        signal: new AbortController().signal,
      });
      assert.deepEqual(route, {
        listenHost: '127.0.0.1',
        connectHost: 'host.docker.internal',
      });
    });

  it('binds loopback for host networking without inspecting the bridge', async () => {
    const route = await resolveMcpRelayNetwork({
      hostPlatform: 'linux',
      network: 'host',
      dockerExecutable: 'docker',
      hostCommands: {
        async run() {
          throw new Error('Unexpected network lookup');
        },
      },
      timeoutMs: 100,
      signal: new AbortController().signal,
    });
    assert.deepEqual(route, {
      listenHost: '127.0.0.1',
      connectHost: '127.0.0.1',
    });
  });

  it('uses the inspected bridge gateway for both the Linux bind and container mapping', async () => {
    const route = await resolveMcpRelayNetwork({
      hostPlatform: 'linux',
      dockerExecutable: 'docker',
      timeoutMs: 100,
      signal: new AbortController().signal,
      hostCommands: {
        async run(argv, options) {
          assert.deepEqual(argv.slice(0, 4), [
            'docker',
            'network',
            'inspect',
            'bridge',
          ]);
          assert.equal(options.timeoutMs, 100);
          assert.equal(options.maxOutputBytes, 1024);
          return {
            stdout: '172.19.0.1\n',
            stderr: '',
            exitCode: 0,
            durationMs: 0,
          };
        },
      },
    });
    assert.deepEqual(route, {
      listenHost: '172.19.0.1',
      connectHost: 'host.docker.internal',
      hostMapping: 'host.docker.internal:172.19.0.1',
    });
  });

  for (const stdout of ['', 'invalid', '0.0.0.0', '172.19.0.1\n172.20.0.1'])
    it(`fails closed for an unavailable or ambiguous IPv4 gateway (${JSON.stringify(stdout)})`, async () => {
      await assert.rejects(
        resolveMcpRelayNetwork({
          hostPlatform: 'linux',
          dockerExecutable: 'docker',
          timeoutMs: 100,
          signal: new AbortController().signal,
          hostCommands: {
            async run() {
              return { stdout, stderr: '', exitCode: 0, durationMs: 0 };
            },
          },
        }),
        /gateway is unavailable/,
      );
    });
});
