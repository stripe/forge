import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_MODEL_PROFILE,
  OPEN_CODE_SESSION,
  openCodeExport,
  openCodeStream,
} from '../../../test/support/opencode.ts';
import type {
  AgentPrepareContext,
  AgentSessionContext,
} from '../../contracts/agent.ts';
import type { CommandOptions, CommandResult } from '../../contracts/command.ts';
import { selectAgentEvidence } from '../../evidence/selection.ts';
import { createOwnedWorkspace } from '../../runtime/workspace.ts';
import {
  createMemoryRunInputProvider,
  createMemoryWorkspace,
  createTestResolvedRunPlan,
} from '../../testing/index.ts';
import { createOpenCodeAdapter, OPENCODE_STATE_ID } from './index.ts';
import { OPENCODE_EXPORT_LAUNCHER, OPENCODE_LAUNCHER } from './launcher.ts';
import { MAX_NATIVE_BYTES } from './native.ts';
import {
  PLUGIN_CONFIG_PATH,
  stripeOpenCodeConfiguration,
} from './pluginConfig.ts';

const selection = {
  adapter: 'opencode',
  provider: 'openai-compatible',
  model: OPEN_CODE_MODEL,
  model_profile: OPEN_CODE_MODEL_PROFILE,
};
const result = (stdout: string, exitCode = 0): CommandResult => ({
  stdout,
  stderr: '',
  exitCode,
  durationMs: 1,
});
async function fixture(
  command?: (
    argv: readonly string[],
    options: CommandOptions,
    state: ReturnType<typeof createMemoryWorkspace>,
  ) => Promise<CommandResult>,
) {
  const adapter = createOpenCodeAdapter({
    baseUrl: 'https://gateway.example/v1',
  });
  const state = createMemoryWorkspace();
  const workspace = createMemoryWorkspace();
  const calls: { argv: readonly string[]; options: CommandOptions }[] = [];
  const plan = createTestResolvedRunPlan({ agent: selection });
  const runtime = {
    runtimeId: 'opencode-test',
    paths: { workspace: '/workspace', home: '/home/forge' },
    workspace: workspace.mutable,
    stateDirectories: new Map([[OPENCODE_STATE_ID, state.mutable]]),
  };
  const base = {
    runId: 'opencode-test',
    plan,
    selection,
    inputs: createMemoryRunInputProvider(),
    signal: new AbortController().signal,
  };
  const context: AgentSessionContext = {
    ...base,
    runtime: {
      ...runtime,
      commands: {
        agent: {
          async run(argv, options = {}) {
            calls.push({ argv: [...argv], options });
            if (command) return command(argv, options, state);
            if (argv[2] === OPENCODE_EXPORT_LAUNCHER) {
              await state.mutable.writeFile(
                'session.json.partial',
                Buffer.from(
                  JSON.stringify(
                    openCodeExport([{ prompt: 'Do it', response: 'Done' }]),
                  ),
                ),
              );
              return result('');
            }
            return result(
              openCodeStream({ prompt: 'Do it', response: 'Done' }),
            );
          },
        },
      },
    },
  };
  const prepare: AgentPrepareContext = {
    ...base,
    runtime: {
      ...runtime,
      commands: {
        uncredentialed: {
          async run(argv, options = {}) {
            calls.push({ argv: [...argv], options });
            return command ? command(argv, options, state) : result('1.19.0\n');
          },
        },
      },
    },
  };
  return { adapter, state, workspace, context, prepare, calls };
}

describe('OpenCode adapter', () => {
  it('restores the installed plugin configuration on initial and resumed turns', async () => {
    const test = await fixture();
    const config = stripeOpenCodeConfiguration(
      {
        mcpServers: {
          stripe: { type: 'http', url: 'https://mcp.stripe.com' },
        },
      },
      '/home/forge/.opencode-forge',
    );
    await test.state.mutable.writeFile(
      PLUGIN_CONFIG_PATH,
      Buffer.from(JSON.stringify(config)),
    );
    const plan = createTestResolvedRunPlan({
      agent: selection,
      treatment: 'stripe-plugin',
      treatmentSetup: [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }],
    });
    const session = await test.adapter.openSession({ ...test.context, plan });
    const signal = new AbortController().signal;
    await session.send('Do it', { signal });
    const original = await test.state.readonly.readFile('config.json');
    assert.deepEqual(
      JSON.parse(Buffer.from(original).toString()).mcp,
      config.mcp,
    );
    await test.state.mutable.writeFile(
      'config.json',
      Buffer.from('{"model":"wrong"}'),
    );
    await session.send('Continue', { signal });
    assert.deepEqual(
      await test.state.readonly.readFile('config.json'),
      original,
    );
    assert.ok(test.calls.some(({ argv }) => argv.includes('--session')));
  });

  it('declares only explicit Chat Completions routing, isolated state, and its credential', () => {
    const adapter = createOpenCodeAdapter({
      baseUrl: 'https://gateway.example/v1',
      credential: 'custom.key',
    });
    const requirements = adapter.requirements(selection);
    assert.deepEqual(requirements.executables, ['opencode', 'node', 'sh']);
    assert.deepEqual(requirements.environment.credentials, {
      OPENCODE_API_KEY: { reference: 'custom.key' },
    });
    const config = JSON.parse(
      requirements.environment.variables!.OPENCODE_CONFIG_CONTENT!,
    );
    assert.equal(config.provider.forge.npm, '@ai-sdk/openai-compatible');
    assert.equal(
      config.provider.forge.options.baseURL,
      'https://gateway.example/v1',
    );
    assert.equal(
      config.provider.forge.options.apiKey,
      '{env:OPENCODE_API_KEY}',
    );
    assert.equal(config.model, `forge/${OPEN_CODE_MODEL}`);
    assert.equal(config.small_model, config.model);
    assert.deepEqual(config.enabled_providers, ['forge']);
    for (const key of [
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
    ])
      assert.ok(
        requirements.environment.variables![key]!.startsWith(
          '/home/forge/.opencode-forge/',
        ),
      );
    assert.throws(
      () => adapter.requirements({ ...selection, provider: 'openai' }),
      /openai-compatible/,
    );
    assert.throws(
      () => adapter.requirements({ ...selection, provider: 'openrouter' }),
      /openai-compatible/,
    );
    assert.throws(
      () => createOpenCodeAdapter().requirements(selection),
      /baseUrl/,
    );
    for (const url of [
      'invalid',
      'https://user:secret@example.com',
      'https://example.com?k=secret',
      'file:///tmp',
      'https://example.com/#secret',
    ])
      assert.throws(() => createOpenCodeAdapter({ baseUrl: url }));
  });
  it('verifies the exact executable version without credentials', async () => {
    const test = await fixture();
    await test.adapter.prepare(test.prepare);
    assert.deepEqual(test.calls[0]!.argv, ['opencode', '--version']);
    for (const output of [
      result('1.18.0'),
      result('1.19.0', 1),
      result('1.19.0\nother'),
    ]) {
      const invalid = await fixture(async () => output);
      await assert.rejects(invalid.adapter.prepare(invalid.prepare), /version/);
    }
  });
  it('preserves prompt bytes and resumes only the observed session', async () => {
    const test = await fixture();
    const session = await test.adapter.openSession(test.context);
    const prompt = '  "quotes"\n\n$HOME $(touch bad) `x` \\ - 世界\n';
    await session.send(prompt, { signal: test.context.signal });
    assert.equal(
      Buffer.from(await test.state.readonly.readFile('prompt.txt')).toString(),
      prompt,
    );
    assert.equal(test.calls[0]!.argv.includes(prompt), false);
    assert.deepEqual(test.calls[0]!.argv.slice(0, 6), [
      'node',
      '-e',
      OPENCODE_LAUNCHER,
      '/home/forge/.opencode-forge/prompt.txt',
      'opencode',
      'run',
    ]);
    assert.equal(test.calls[0]!.argv.includes('--session'), false);
    assert.equal(test.calls.length, 1);
    await session.send('-', { signal: test.context.signal });
    assert.deepEqual(
      test.calls[1]!.argv.slice(0, 6),
      test.calls[0]!.argv.slice(0, 6),
    );
    assert.deepEqual(test.calls[1]!.argv.slice(-2), [
      '--session',
      OPEN_CODE_SESSION,
    ]);
    assert.equal(test.calls.length, 2);
    await session.finalize!(test.context.signal);
    assert.deepEqual(test.calls[2]!.argv, [
      'node',
      '-e',
      OPENCODE_EXPORT_LAUNCHER,
      '/home/forge/.opencode-forge/session.json',
      String(MAX_NATIVE_BYTES),
      'opencode',
      OPEN_CODE_SESSION,
    ]);
    assert.equal(test.calls[2]!.options.signal, test.context.signal);
    assert.equal(test.calls[2]!.options.timeoutMs, 30_000);
    assert.equal(test.calls[2]!.options.maxOutputBytes, 64 * 1024);
    assert.ok((await test.state.readonly.readFile('session.json')).length > 0);
    assert.equal(session.sessionId(), OPEN_CODE_SESSION);
    assert.equal(test.calls[0]!.options.signal, test.context.signal);
  });
  it('removes the partial after publishing the exact native bytes', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'forge-opencode-publish-'),
    );
    try {
      const state = await createOwnedWorkspace(directory);
      const native = JSON.stringify(
        openCodeExport([{ prompt: 'Do it', response: 'Done' }]),
      );
      const executable = path.join(directory, 'opencode');
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(native)});\n`,
        { mode: 0o700 },
      );
      const test = await fixture();
      const adapter = createOpenCodeAdapter({
        baseUrl: 'https://gateway.example/v1',
        executable,
        layout: { ...test.context.runtime.paths, stateDirectory: directory },
      });
      const session = await adapter.openSession({
        ...test.context,
        runtime: {
          ...test.context.runtime,
          stateDirectories: new Map([[OPENCODE_STATE_ID, state]]),
          commands: {
            agent: {
              async run(argv) {
                if (argv[2] === OPENCODE_LAUNCHER)
                  return result(
                    openCodeStream({ prompt: 'Do it', response: 'Done' }),
                  );
                if (argv[2] !== OPENCODE_EXPORT_LAUNCHER)
                  assert.equal(
                    Buffer.from(
                      await state.readFile('session.json'),
                    ).toString(),
                    native,
                  );
                const launched = spawnSync(process.execPath, argv.slice(1));
                assert.equal(launched.status, 0, launched.stderr.toString());
                return result(launched.stdout.toString(), launched.status ?? 1);
              },
            },
          },
        },
      });
      await session.send('Do it', { signal: test.context.signal });
      await session.finalize!(test.context.signal);
      assert.equal(
        Buffer.from(await state.readFile('session.json')).toString(),
        native,
      );
      assert.equal(
        (await stat(path.join(directory, 'session.json'))).mode & 0o777,
        0o600,
      );
      assert.equal(
        (await state.inspect('session.json.partial')).kind,
        'absent',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('preserves published native evidence when partial cleanup fails', async () => {
    const native = JSON.stringify(
      openCodeExport([{ prompt: 'Do it', response: 'Done' }]),
    );
    const test = await fixture(async (argv, _options, state) => {
      if (argv[2] === OPENCODE_LAUNCHER)
        return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
      if (argv[2] === OPENCODE_EXPORT_LAUNCHER) {
        await state.mutable.writeFile(
          'session.json.partial',
          Buffer.from(native),
        );
        return result('');
      }
      throw new Error('cleanup failed');
    });
    const session = await test.adapter.openSession(test.context);
    await session.send('Do it', { signal: test.context.signal });
    await session.finalize!(test.context.signal);
    assert.equal(
      Buffer.from(
        await test.state.readonly.readFile('session.json'),
      ).toString(),
      native,
    );
  });
  it('passes a declared prompt file unchanged through real Node stdin', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'forge-opencode-launcher-'),
    );
    try {
      const prompt = '  "quoted"\n$HOME `no` $(no) \\ 世界\n';
      await writeFile(path.join(directory, 'prompt'), prompt);
      const launched = spawnSync(process.execPath, [
        '-e',
        OPENCODE_LAUNCHER,
        path.join(directory, 'prompt'),
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], require("node:fs").readFileSync(0))',
        path.join(directory, 'captured'),
      ]);
      assert.equal(launched.status, 0);
      assert.equal(
        await readFile(path.join(directory, 'captured'), 'utf8'),
        prompt,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('refuses global config and discovered extensions before invoking the native CLI', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'forge-opencode-global-'),
    );
    try {
      await writeFile(path.join(directory, 'prompt'), 'Use the selected model');
      for (const relative of [
        'config/opencode/config.json',
        'config/opencode/opencode.json',
        'config/opencode/opencode.jsonc',
        'config/opencode/config',
        'config/opencode/agents/override.md',
        'config/opencode/plugins/override.js',
        'config/opencode/skill/override/SKILL.md',
        'config/opencode/AGENTS.md',
        'home/.opencode/opencode.json',
        'data/opencode/auth.json',
      ]) {
        const target = path.join(directory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(
          target,
          JSON.stringify({
            provider: {
              forge: {
                models: {
                  [OPEN_CODE_MODEL]: {
                    id: 'unselected-model',
                    provider: { npm: '@ai-sdk/anthropic' },
                  },
                },
              },
            },
          }),
        );
        const launched = spawnSync(
          process.execPath,
          [
            '-e',
            OPENCODE_LAUNCHER,
            path.join(directory, 'prompt'),
            process.execPath,
            '-e',
            'process.stdout.write("must-not-run")',
          ],
          {
            env: {
              HOME: path.join(directory, 'home'),
              XDG_CONFIG_HOME: path.join(directory, 'config'),
              XDG_DATA_HOME: path.join(directory, 'data'),
            },
          },
        );
        assert.equal(launched.status, 1, relative);
        assert.equal(launched.stdout.toString(), '');
        assert.match(
          launched.stderr.toString(),
          /implicit global configuration/,
        );
        for (const child of ['home', 'config', 'data'])
          await rm(path.join(directory, child), {
            recursive: true,
            force: true,
          });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('writes native bytes through a regular file descriptor without stdout capture', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'forge-opencode-export-'),
    );
    try {
      const destination = path.join(directory, 'session.json');
      const payload = JSON.stringify({
        info: { id: OPEN_CODE_SESSION },
        text: '世界'.repeat(100_000),
      });
      const source = path.join(directory, 'native.json');
      const executable = path.join(directory, 'opencode');
      await writeFile(source, payload);
      await writeFile(
        executable,
        `#!${process.execPath}\nrequire('node:fs').createReadStream(${JSON.stringify(source)}).pipe(process.stdout);\n`,
        { mode: 0o700 },
      );
      await writeFile(destination, 'old bytes', { mode: 0o644 });
      const launched = spawnSync(
        process.execPath,
        [
          '-e',
          OPENCODE_EXPORT_LAUNCHER,
          destination,
          String(MAX_NATIVE_BYTES),
          executable,
          OPEN_CODE_SESSION,
        ],
        { maxBuffer: 64 * 1024 },
      );
      assert.equal(launched.status, 0);
      assert.equal(launched.stdout.length, 0);
      assert.equal(await readFile(destination, 'utf8'), 'old bytes');
      assert.equal(await readFile(`${destination}.partial`, 'utf8'), payload);
      assert.equal((await stat(`${destination}.partial`)).mode & 0o777, 0o600);
      await rm(`${destination}.partial`);
      await rm(destination);
      for (const createLink of [symlink, link]) {
        await createLink(source, `${destination}.partial`);
        const unsafe = spawnSync(process.execPath, [
          '-e',
          OPENCODE_EXPORT_LAUNCHER,
          destination,
          String(MAX_NATIVE_BYTES),
          executable,
          OPEN_CODE_SESSION,
        ]);
        assert.notEqual(unsafe.status, 0);
        assert.equal(await readFile(source, 'utf8'), payload);
        await rm(`${destination}.partial`);
      }
      await writeFile(destination, '');
      for (const failure of ['non-zero', 'oversized']) {
        if (failure === 'non-zero')
          await writeFile(
            executable,
            `#!${process.execPath}\nprocess.stdout.write('{}'); process.exitCode = 1;\n`,
            { mode: 0o700 },
          );
        else
          await writeFile(
            executable,
            `#!${process.execPath}\nrequire('node:fs').createReadStream(${JSON.stringify(source)}).pipe(process.stdout);\n`,
            { mode: 0o700 },
          );
        const rejected = spawnSync(process.execPath, [
          '-e',
          OPENCODE_EXPORT_LAUNCHER,
          destination,
          String(failure === 'oversized' ? 1024 : MAX_NATIVE_BYTES),
          executable,
          OPEN_CODE_SESSION,
        ]);
        assert.equal(rejected.status, 1);
        assert.equal((await readFile(destination)).length, 0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('bounds the file while the exporter is still running', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'forge-opencode-bound-'),
    );
    try {
      const executable = path.join(directory, 'opencode');
      const destination = path.join(directory, 'session.json');
      await writeFile(
        executable,
        [
          `#!${process.execPath}`,
          "require('node:fs').writeSync(1, Buffer.alloc(64 * 1024));",
          "process.stderr.write('ready');",
          'setTimeout(() => {}, 300);',
        ].join('\n'),
        { mode: 0o700 },
      );
      const child = spawn(process.execPath, [
        '-e',
        OPENCODE_EXPORT_LAUNCHER,
        destination,
        '1024',
        executable,
        OPEN_CODE_SESSION,
      ]);
      const closed = once(child, 'close');
      await once(child.stderr, 'data');
      const size = (await stat(`${destination}.partial`)).size;
      // Shells use 512- or 1024-byte blocks. Neither can exceed this ceiling.
      assert.ok(size <= 2048, `capture reached ${size} bytes`);
      assert.equal(child.exitCode, null);
      await closed;
      await assert.rejects(stat(destination), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('keeps a late export ineligible after a command rejection', async () => {
    const test = await fixture(async (argv) => {
      if (argv[2] === OPENCODE_EXPORT_LAUNCHER) throw new Error('timeout');
      return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
    });
    const session = await test.adapter.openSession(test.context);
    await session.send('Do it', { signal: test.context.signal });
    await session.finalize!(test.context.signal);
    // Simulate an exporter completing during runtime shutdown after rejection.
    await test.state.mutable.writeFile(
      'session.json.partial',
      Buffer.from(
        JSON.stringify(openCodeExport([{ prompt: 'Do it', response: 'Done' }])),
      ),
    );
    assert.equal(
      (await test.state.readonly.readFile('session.json')).length,
      0,
    );
    const evidenceContext = {
      ...test.context,
      sessionId: OPEN_CODE_SESSION,
      runtime: {
        runtimeId: test.context.runtime.runtimeId,
        paths: test.context.runtime.paths,
        workspace: test.workspace.readonly,
        stateDirectories: new Map([[OPENCODE_STATE_ID, test.state.readonly]]),
        metadata: {},
      },
    };
    assert.equal(
      (await test.adapter.collectEvidence(evidenceContext)).kind,
      'unavailable',
    );
    assert.equal(
      await test.adapter.collectNativeArtifact!(evidenceContext),
      undefined,
    );
  });
  it('does not export a session without completed turns', async () => {
    const test = await fixture();
    const session = await test.adapter.openSession(test.context);
    await session.finalize!(test.context.signal);
    assert.equal(test.calls.length, 0);
  });
  for (const failure of [
    'command rejection',
    'non-zero exit',
    'oversized export',
  ]) {
    it(`uses explicit driver fallback after an export with ${failure}`, async () => {
      let exports = 0;
      const native = JSON.stringify(
        openCodeExport([{ prompt: 'Do it', response: 'Done' }]),
      );
      const test = await fixture(async (argv, _options, state) => {
        if (argv[2] !== OPENCODE_EXPORT_LAUNCHER)
          return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
        exports++;
        // Valid JSON: only the command failure or byte limit rejects it.
        await state.mutable.writeFile(
          'session.json.partial',
          Buffer.from(
            failure === 'oversized export'
              ? native.padEnd(MAX_NATIVE_BYTES + 1)
              : native,
          ),
        );
        if (failure === 'command rejection') throw new Error('capture failed');
        return result('', failure === 'non-zero exit' ? 1 : 0);
      });
      await test.state.mutable.writeFile('session.json', Buffer.from(native));
      const session = await test.adapter.openSession(test.context);
      const first = await session.send('Do it', {
        signal: test.context.signal,
      });
      assert.equal(
        (await test.state.readonly.readFile('session.json')).length,
        0,
      );
      const second = await session.send('Again', {
        signal: test.context.signal,
      });
      assert.equal(second.text, 'Done');
      assert.equal(exports, 0);
      await session.finalize!(test.context.signal);
      assert.equal(exports, 1);
      assert.equal(session.sessionId(), OPEN_CODE_SESSION);
      assert.equal(
        (await test.state.readonly.readFile('session.json')).length,
        0,
      );
      const evidenceContext = {
        ...test.context,
        sessionId: OPEN_CODE_SESSION,
        runtime: {
          runtimeId: test.context.runtime.runtimeId,
          paths: test.context.runtime.paths,
          workspace: test.workspace.readonly,
          stateDirectories: new Map([[OPENCODE_STATE_ID, test.state.readonly]]),
          metadata: {},
        },
      };
      const collected = await test.adapter.collectEvidence(evidenceContext);
      assert.equal(collected.kind, 'unavailable');
      const evidence = selectAgentEvidence({
        agent: test.adapter,
        identity: test.adapter.evidenceIdentity(selection),
        model: selection.model,
        sessionId: OPEN_CODE_SESSION,
        completedTurns: [first, second].map((turn, index) => ({
          user: index === 0 ? 'Do it' : 'Again',
          assistant: turn.text,
          toolCalls: turn.toolCalls,
        })),
        collected,
      });
      assert.equal(evidence.completeness, 'fallback');
      assert.equal(evidence.provenance.source.kind, 'driver_fallback');
      assert.deepEqual(
        evidence.warnings.map(({ code }) => code),
        ['source_unavailable', 'fallback_used'],
      );
      assert.deepEqual(
        evidence.trajectory.steps.map(({ message }) => message),
        ['Do it', 'Done', 'Again', 'Done'],
      );
      assert.equal(
        await test.adapter.collectNativeArtifact!(evidenceContext),
        undefined,
      );
    });
  }
  it('propagates cancellation during execution or final export', async () => {
    for (const phase of ['run', 'export']) {
      const controller = new AbortController();
      const test = await fixture(async (argv) => {
        if ((argv[2] === OPENCODE_EXPORT_LAUNCHER) === (phase === 'export')) {
          controller.abort(new Error('cancelled'));
          throw controller.signal.reason;
        }
        return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
      });
      const session = await test.adapter.openSession(test.context);
      if (phase === 'run') {
        await assert.rejects(
          session.send('Do it', { signal: controller.signal }),
          /cancelled/,
        );
      } else {
        await session.send('Do it', { signal: controller.signal });
        await assert.rejects(session.finalize!(controller.signal), /cancelled/);
        assert.equal(
          (await test.state.readonly.readFile('session.json')).length,
          0,
        );
      }
    }
  });
  it('passes cancellation through the capture read and invalidates rejected bytes', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel capture read');
    const test = await fixture();
    let readCapture = false;
    const state = {
      ...test.state.mutable,
      async readFile(
        relativePath: string,
        options?: { maxBytes?: number; signal?: AbortSignal },
      ) {
        if (relativePath === 'session.json.partial') {
          readCapture = true;
          assert.equal(options?.signal, controller.signal);
          controller.abort(reason);
        }
        return test.state.mutable.readFile(relativePath, options);
      },
    };
    const session = await test.adapter.openSession({
      ...test.context,
      runtime: {
        ...test.context.runtime,
        stateDirectories: new Map([[OPENCODE_STATE_ID, state]]),
      },
    });
    await session.send('Do it', { signal: controller.signal });

    await assert.rejects(
      session.finalize!(controller.signal),
      (error) => error === reason,
    );
    assert.equal(readCapture, true);
    assert.equal((await test.state.readonly.readFile('session.json')).length, 0);
  });
  it('requires a model profile during pure capability preflight', () => {
    const { model_profile: _, ...missing } = selection;
    const adapter = createOpenCodeAdapter({
      baseUrl: 'https://gateway.example/v1',
    });
    assert.throws(() => adapter.requirements(missing), /model_profile/);
    assert.throws(() => adapter.evidenceIdentity(missing), /model_profile/);
  });
  it('ignores workspace opencode.json and writes the same model for baseline and Stripe plugin arms', async () => {
    const definitions: unknown[] = [];
    for (const treatment of ['baseline', 'stripe-plugin']) {
      const test = await fixture();
      await test.context.runtime.workspace.writeFile(
        'opencode.json',
        Buffer.from(
          JSON.stringify({
            model: 'other/model',
            provider: {
              forge: {
                models: {
                  [OPEN_CODE_MODEL]: { limit: { context: 1, output: 1 } },
                },
              },
            },
            mcp: { stripe: { enabled: false } },
            skills: { paths: ['./ignored'] },
            agent: { build: { model: 'other/model' } },
          }),
        ),
      );
      if (treatment === 'stripe-plugin') {
        await test.state.mutable.writeFile(
          PLUGIN_CONFIG_PATH,
          Buffer.from(
            JSON.stringify(
              stripeOpenCodeConfiguration(
                {
                  mcpServers: {
                    stripe: { type: 'http', url: 'https://mcp.stripe.com' },
                  },
                },
                '/home/forge/.opencode-forge',
              ),
            ),
          ),
        );
      }
      const plan = createTestResolvedRunPlan({
        agent: selection,
        treatment,
        treatmentSetup:
          treatment === 'stripe-plugin'
            ? [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }]
            : [],
      });
      const variables =
        test.adapter.requirements(selection).environment.variables!;
      assert.equal(variables.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
      assert.equal(
        variables.OPENCODE_CONFIG,
        '/home/forge/.opencode-forge/config.json',
      );
      const session = await test.adapter.openSession({ ...test.context, plan });
      await session.send('Do it', { signal: test.context.signal });
      const config = JSON.parse(
        Buffer.from(
          await test.state.readonly.readFile('config.json'),
        ).toString(),
      );
      definitions.push(config.provider.forge.models);
      assert.equal(config.model, `forge/${OPEN_CODE_MODEL}`);
      assert.deepEqual(config.provider.forge.models, {
        [OPEN_CODE_MODEL]: { ...OPEN_CODE_MODEL_PROFILE, tool_call: true },
      });
      assert.equal(
        config.mcp?.stripe.enabled,
        treatment === 'stripe-plugin' ? true : undefined,
      );
      assert.deepEqual(
        config.skills?.paths,
        treatment === 'stripe-plugin'
          ? ['/home/forge/.opencode-forge/plugins/stripe/bundle/skills']
          : undefined,
      );
    }
    assert.deepEqual(definitions[0], definitions[1]);
  });
});
