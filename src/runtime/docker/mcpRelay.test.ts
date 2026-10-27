import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { credentialReference } from '../../contracts/credentials.ts';
import type { RuntimePreparation } from '../../contracts/runtime.ts';
import { createTestResolvedRunPlan } from '../../testing/plans.ts';
import type {
  HostCommandOptions,
  HostCommandRunner,
} from '../processCommandRunner.ts';
import {
  createDockerRuntimeAdapter,
  DEFAULT_MCP_CREDENTIAL_RELAY_LIMITS,
  type McpCredentialRelayLimits,
} from './index.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function fakeDocker() {
  const calls: {
    argv: readonly string[];
    options: HostCommandOptions;
    environmentBody?: string;
  }[] = [];
  const runner: HostCommandRunner = {
    async run(argv, options) {
      const index = argv.indexOf('--env-file');
      calls.push({
        argv: [...argv],
        options,
        ...(index < 0
          ? {}
          : { environmentBody: await fs.readFile(argv[index + 1]!, 'utf8') }),
      });
      return {
        stdout:
          argv[1] === 'network'
            ? '127.0.0.1\n'
            : argv[1] === 'image'
              ? `sha256:${'a'.repeat(64)}\n`
              : 'ok\n',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
      };
    },
  };
  return { runner, calls };
}

function preparation(): RuntimePreparation {
  return {
    runId: 'relay-test',
    plan: structuredClone(createTestResolvedRunPlan()),
    environment: { variables: {}, credentials: {} },
    requirements: { executables: [], stateDirectories: [] },
    signal: new AbortController().signal,
  };
}

describe('Docker plugin credential relays', () => {
  it('rejects unsupported relays and credential-backed proxy bypass before allocation', () => {
    const fake = fakeDocker();
    const adapter = createDockerRuntimeAdapter({ hostCommands: fake.runner });
    const input = preparation();
    for (const mcpRelays of [['stripe', 'stripe'], ['unknown']])
      assert.throws(() =>
        adapter.preflight({
          plan: input.plan,
          requirements: {
            ...input.requirements,
            mcpRelays,
          } as RuntimePreparation['requirements'],
          environment: {},
        }),
      );
    assert.throws(() =>
      adapter.preflight({
        plan: input.plan,
        requirements: { ...input.requirements, mcpRelays: ['stripe'] },
        environment: {
          credentials: {
            NO_PROXY: {
              reference: credentialReference('proxy-token'),
              scopes: ['agent'],
            },
          },
        },
      }),
    );
    assert.equal(fake.calls.length, 0);
  });
  for (const { hostPlatform, network, mapping } of [
    {
      hostPlatform: 'linux',
      network: 'default',
      mapping: 'host.docker.internal:127.0.0.1',
    },
    { hostPlatform: 'darwin', network: 'default', mapping: undefined },
    { hostPlatform: 'linux', network: 'host', mapping: undefined },
  ] as const)
    it(`owns a host MCP relay across setup replacement on ${hostPlatform}/${network}`, async () => {
      const fake = fakeDocker();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-relay-'));
      roots.push(root);
      const adapter = createDockerRuntimeAdapter({
        hostCommands: fake.runner,
        temporaryRoot: root,
        hostPlatform,
      });
      const input = preparation();
      if (!('image' in input.plan.runtime)) throw new Error('expected Docker');
      if (network === 'host')
        input.plan.runtime = { ...input.plan.runtime, network };
      const runtime = await adapter.prepare({
        ...input,
        requirements: {
          executables: [],
          stateDirectories: [
            {
              id: 'plugin',
              containerPath: '/home/forge/plugin',
              sealAfterSetup: true,
            },
          ],
          mcpRelays: ['stripe'],
        },
        mcpRelayCredentials: [
          { server: 'stripe', value: 'synthetic-host-only-key' },
        ],
      });
      try {
        const connection = runtime.pluginMcpConnections?.stripe;
        assert.ok(connection);
        const url = new URL(connection.url);
        assert.equal(
          url.hostname,
          network === 'host' ? '127.0.0.1' : 'host.docker.internal',
        );
        url.hostname = '127.0.0.1';
        assert.equal((await fetch(url)).status, 401);
        await runtime.finalizeSetup();
        assert.equal((await fetch(url)).status, 401);
        const starts = fake.calls.filter(({ argv }) => argv[1] === 'run');
        assert.equal(starts.length, 2);
        for (const { argv } of starts)
          assert.equal(argv.includes('--add-host'), mapping !== undefined);
        if (mapping)
          for (const { argv } of starts) assert.ok(argv.includes(mapping));
        assert.ok(
          fake.calls
            .filter(({ argv }) => argv[1] !== 'run')
            .every(({ argv }) => !argv.includes('--add-host')),
        );
        await runtime.commands.agent.run(['probe']);
        const command = fake.calls.find(
          ({ environmentBody }) => environmentBody !== undefined,
        )!;
        assert.ok(
          command.environmentBody?.includes(
            `NO_PROXY=${network === 'host' ? '127.0.0.1' : 'host.docker.internal'}`,
          ),
        );
        assert.ok(
          !command.environmentBody?.includes('synthetic-host-only-key'),
        );
        assert.ok(
          !JSON.stringify(fake.calls).includes('synthetic-host-only-key'),
        );
        const sealed = await runtime.quiesce();
        assert.equal(sealed.metadata.pluginMcpRequests, '0');
        assert.equal(sealed.metadata.pluginMcpErrors, '0');
        await assert.rejects(fetch(url));
      } finally {
        await runtime.dispose();
      }
    });

  it('adds no host mapping or network lookup without a relay on Linux', async () => {
    const fake = fakeDocker();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-no-relay-'));
    roots.push(root);
    const runtime = await createDockerRuntimeAdapter({
      hostCommands: fake.runner,
      temporaryRoot: root,
      hostPlatform: 'linux',
    }).prepare(preparation());
    await runtime.dispose();
    assert.ok(
      fake.calls.every(
        ({ argv }) => argv[1] !== 'network' && !argv.includes('--add-host'),
      ),
    );
  });

  it('enforces explicit host bounds and records the resolved policy with completed counts', async () => {
    const fake = fakeDocker();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-relay-limits-'),
    );
    roots.push(root);
    let upstreamCalls = 0;
    const limits: Partial<McpCredentialRelayLimits> = { requestBytes: 4 };
    const runtime = await createDockerRuntimeAdapter({
      hostCommands: fake.runner,
      temporaryRoot: root,
      mcpRelayLimits: limits,
      mcpRelayFetch: async () => {
        upstreamCalls += 1;
        return new Response('ok');
      },
    }).prepare({
      ...preparation(),
      requirements: {
        executables: [],
        stateDirectories: [],
        mcpRelays: ['stripe'],
      },
      mcpRelayCredentials: [
        { server: 'stripe', value: 'synthetic-host-only-key' },
      ],
    });
    try {
      const connection = runtime.pluginMcpConnections!.stripe!;
      const url = new URL(connection.url);
      url.hostname = '127.0.0.1';
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.token}` },
        body: '12345',
      });
      assert.equal(response.status, 413);
      assert.equal(upstreamCalls, 0);
      const sealed = await runtime.quiesce();
      assert.equal(sealed.metadata.pluginMcpRequests, '1');
      assert.equal(sealed.metadata.pluginMcpErrors, '1');
      assert.deepEqual(JSON.parse(sealed.metadata.pluginMcpLimits!), {
        ...DEFAULT_MCP_CREDENTIAL_RELAY_LIMITS,
        requestBytes: 4,
      });
    } finally {
      await runtime.dispose();
    }
  });

  for (const reason of ['abort', 'dispose'] as const)
    it(`revokes the relay capability on ${reason} before quiescence`, async () => {
      const fake = fakeDocker();
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-relay-cleanup-'),
      );
      roots.push(root);
      const controller = new AbortController();
      const input = preparation();
      const runtime = await createDockerRuntimeAdapter({
        hostCommands: fake.runner,
        temporaryRoot: root,
      }).prepare({
        ...input,
        signal: controller.signal,
        requirements: { ...input.requirements, mcpRelays: ['stripe'] },
        mcpRelayCredentials: [
          { server: 'stripe', value: 'synthetic-host-only-key' },
        ],
      });
      const url = new URL(runtime.pluginMcpConnections!.stripe!.url);
      url.hostname = '127.0.0.1';
      assert.equal((await fetch(url)).status, 401);
      if (reason === 'abort') controller.abort();
      await runtime.dispose();
      await assert.rejects(fetch(url));
    });
});
