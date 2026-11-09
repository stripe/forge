import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  createMemoryRunInputProvider,
  createMemoryWorkspace,
  createTestResolvedRunPlan,
} from '../../testing/index.ts';
import { createOpenCodeAdapter, OPENCODE_STATE_ID } from './index.ts';
import { OPENCODE_LAUNCHER } from './launcher.ts';
import { MAX_NATIVE_BYTES } from './native.ts';
import {
  PLUGIN_ACTIVATION_PATH,
  writePluginActivation,
} from './pluginActivation.ts';
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
  ) => Promise<CommandResult>,
) {
  const adapter = createOpenCodeAdapter({
    baseUrl: 'https://gateway.example/v1',
  });
  const state = createMemoryWorkspace();
  await writePluginActivation(state.mutable, false);
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
            return command
              ? command(argv, options)
              : result(
                  argv[1] === 'export'
                    ? JSON.stringify(
                        openCodeExport([{ prompt: 'Do it', response: 'Done' }]),
                      )
                    : openCodeStream({ prompt: 'Do it', response: 'Done' }),
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
            return command ? command(argv, options) : result('1.19.0\n');
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
    await writePluginActivation(test.state.mutable, true);
    // The plan has no forge/plugin step: activation belongs to adapter state.
    const session = await test.adapter.openSession(test.context);
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
    await test.state.mutable.writeFile(PLUGIN_CONFIG_PATH, Buffer.from('{}'));
    await writePluginActivation(test.state.mutable, false);
    await session.send('Continue', { signal });
    assert.deepEqual(
      await test.state.readonly.readFile('config.json'),
      original,
    );
    assert.ok(test.calls.some(({ argv }) => argv.includes('--session')));
  });

  it('requires bounded exact activation and a valid active fragment before a turn', async () => {
    const baseline = { format: 'forge-opencode-plugins-v1', plugins: [] };
    const active = { ...baseline, plugins: ['stripe'] };
    for (const state of [
      {},
      { [PLUGIN_ACTIVATION_PATH]: '{}' },
      { [PLUGIN_ACTIVATION_PATH]: JSON.stringify({ ...baseline, format: 'wrong' }) },
      {
        [PLUGIN_ACTIVATION_PATH]: JSON.stringify({ ...baseline, plugins: ['unknown'] }),
      },
      {
        [PLUGIN_ACTIVATION_PATH]: JSON.stringify({ ...baseline, plugins: ['stripe', 'stripe'] }),
      },
      { [PLUGIN_ACTIVATION_PATH]: JSON.stringify({ ...baseline, extra: true }) },
      { [PLUGIN_ACTIVATION_PATH]: '{}'.padEnd(16 * 1024 + 1) },
      {
        [PLUGIN_ACTIVATION_PATH]: JSON.stringify(baseline),
        [PLUGIN_CONFIG_PATH]: '{}',
      },
      { [PLUGIN_ACTIVATION_PATH]: JSON.stringify(active) },
      {
        [PLUGIN_ACTIVATION_PATH]: JSON.stringify(active),
        [PLUGIN_CONFIG_PATH]: '{"model":"override"}',
      },
    ]) {
      const test = await fixture();
      const invalid = createMemoryWorkspace(state);
      await assert.rejects(
        test.adapter.openSession({
          ...test.context,
          runtime: {
            ...test.context.runtime,
            stateDirectories: new Map([[OPENCODE_STATE_ID, invalid.mutable]]),
          },
        }),
      );
      assert.equal(test.calls.length, 0);
    }
    for (const file of [PLUGIN_ACTIVATION_PATH, PLUGIN_CONFIG_PATH]) {
      const test = await fixture();
      await writePluginActivation(test.state.mutable, true);
      const state = {
        ...test.state.mutable,
        async inspect(relative: string) {
          return relative === file
            ? { path: relative, kind: 'symlink' as const }
            : test.state.mutable.inspect(relative);
        },
      };
      await assert.rejects(
        test.adapter.openSession({
          ...test.context,
          runtime: {
            ...test.context.runtime,
            stateDirectories: new Map([[OPENCODE_STATE_ID, state]]),
          },
        }),
        /regular file/,
      );
    }
  });

  it('declares only explicit Chat Completions routing, isolated state, and its credential', () => {
    const adapter = createOpenCodeAdapter({
      baseUrl: 'https://gateway.example/v1',
      credential: 'custom.key',
    });
    const requirements = adapter.requirements(selection);
    assert.deepEqual(requirements.executables, ['opencode', 'node']);
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
    const fresh = createMemoryWorkspace();
    const prepare = {
      ...test.prepare,
      runtime: {
        ...test.prepare.runtime,
        stateDirectories: new Map([[OPENCODE_STATE_ID, fresh.mutable]]),
      },
    };
    await test.adapter.prepare(prepare);
    assert.deepEqual(
      JSON.parse(
        Buffer.from(
          await fresh.readonly.readFile(PLUGIN_ACTIVATION_PATH),
        ).toString(),
      ),
      { format: 'forge-opencode-plugins-v1', plugins: [] },
    );
    assert.equal((await fresh.readonly.inspect('plugins/stripe')).kind, 'absent');
    await assert.rejects(test.adapter.prepare(prepare), /already exists/);
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
    assert.deepEqual(test.calls[1]!.argv, [
      'opencode',
      'export',
      OPEN_CODE_SESSION,
    ]);
    await session.send('-', { signal: test.context.signal });
    assert.deepEqual(
      test.calls[2]!.argv.slice(0, 6),
      test.calls[0]!.argv.slice(0, 6),
    );
    assert.deepEqual(test.calls[2]!.argv.slice(-2), [
      '--session',
      OPEN_CODE_SESSION,
    ]);
    assert.equal(session.sessionId(), OPEN_CODE_SESSION);
    assert.equal(test.calls[0]!.options.signal, test.context.signal);
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
  it('invalidates stale exports and preserves a completed turn when export fails', async () => {
    let exports = 0;
    const test = await fixture(async (argv) => {
      if (argv[1] !== 'export')
        return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
      exports++;
      if (exports === 2) throw new Error('capture failed');
      return result(
        JSON.stringify(openCodeExport([{ prompt: 'Do it', response: 'Done' }])),
      );
    });
    const session = await test.adapter.openSession(test.context);
    await session.send('Do it', { signal: test.context.signal });
    assert.ok((await test.state.readonly.readFile('session.json')).length > 0);
    assert.equal(
      (await session.send('Again', { signal: test.context.signal })).text,
      'Done',
    );
    assert.equal(
      (await test.state.readonly.readFile('session.json')).length,
      0,
    );
  });
  for (const failure of ['non-zero exit', 'oversized export']) {
    it(`uses explicit driver fallback after an export with ${failure}`, async () => {
      let exports = 0;
      const native = JSON.stringify(
        openCodeExport([{ prompt: 'Do it', response: 'Done' }]),
      );
      const test = await fixture(async (argv) => {
        if (argv[1] !== 'export')
          return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
        exports++;
        if (exports === 1) return result(native);
        // Valid JSON in both cases: only the status/byte limit rejects it.
        return failure === 'non-zero exit'
          ? result(native, 1)
          : result(native.padEnd(MAX_NATIVE_BYTES + 1));
      });
      const session = await test.adapter.openSession(test.context);
      const first = await session.send('Do it', {
        signal: test.context.signal,
      });
      assert.ok(
        (await test.state.readonly.readFile('session.json')).length > 0,
      );
      const second = await session.send('Again', {
        signal: test.context.signal,
      });
      assert.equal(second.text, 'Done');
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
  it('propagates cancellation during execution or export', async () => {
    for (const phase of ['run', 'export']) {
      const controller = new AbortController();
      const test = await fixture(async (argv) => {
        if ((argv[1] === 'export') === (phase === 'export')) {
          controller.abort(new Error('cancelled'));
          throw controller.signal.reason;
        }
        return result(openCodeStream({ prompt: 'Do it', response: 'Done' }));
      });
      const session = await test.adapter.openSession(test.context);
      await assert.rejects(
        session.send('Do it', { signal: controller.signal }),
        /cancelled/,
      );
    }
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
        await writePluginActivation(test.state.mutable, true);
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
