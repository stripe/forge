import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';
import { createSetupExecutor } from '../../setup/executor.ts';
import { createTestResolvedRunPlan } from '../../testing/plans.ts';
import { OPENCODE_LAUNCHER } from './launcher.ts';
import {
  WEB_SEARCH_PLUGIN,
  WEB_SEARCH_PLUGIN_PATH,
} from './webSearchPlugin.ts';

it('disables OpenCode native search for all agents through explicit action variables only when selected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-search-launcher-'));
  const prompt = path.join(root, 'prompt.txt');
  await writeFile(prompt, 'Task');
  try {
    for (const disabled of [false, true]) {
      const baseRuntime = createTestResolvedRunPlan().runtime;
      if ('config' in baseRuntime) throw new Error('Expected Docker');
      const plan = createTestResolvedRunPlan({
        agent: {
          adapter: 'opencode',
          provider: 'openai-compatible',
          model: 'test',
        },
        runtime: { ...baseRuntime, network: 'host' },
        treatmentSetup: disabled
          ? [{ uses: 'forge/web-search', with: {} }]
          : [],
      });
      const prepared = createSetupExecutor().preflight(plan.setup, {
        selection: plan.agent,
        runtime: plan.runtime,
      });
      const flags = [
        'OPENCODE_EXPERIMENTAL',
        'OPENCODE_ENABLE_EXA',
        'OPENCODE_EXPERIMENTAL_EXA',
        'OPENCODE_ENABLE_PARALLEL',
        'OPENCODE_EXPERIMENTAL_PARALLEL',
      ];
      const env = {
        HOME: root,
        ...Object.fromEntries(flags.map((key) => [key, 'true'])),
        ...prepared.requirements.variables,
      };
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          OPENCODE_LAUNCHER,
          prompt,
          process.execPath,
          '-e',
          `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(flags)}.map(key => [key, process.env[key]]))))`,
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
          env,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(result.stdout);
      for (const flag of flags)
        assert.equal(actual[flag], disabled ? 'false' : 'true');
      // Pinned v1.19.0 effect/runtime-flags.ts combines these flags; its tool
      // registry's webSearchEnabled(providerID, flags) runs before permissions.
      // The adapter fixes every selected agent/subagent to providerID forge.
      const enabled = (name: string) => actual[name] === 'true';
      const exa =
        enabled('OPENCODE_EXPERIMENTAL') ||
        enabled('OPENCODE_ENABLE_EXA') ||
        enabled('OPENCODE_EXPERIMENTAL_EXA');
      const parallel =
        enabled('OPENCODE_ENABLE_PARALLEL') ||
        enabled('OPENCODE_EXPERIMENTAL_PARALLEL');
      const providerID: string = 'forge';
      const nativeSearchEnabled =
        providerID === 'opencode' ||
        providerID === 'opencode-go' ||
        exa ||
        parallel;
      assert.equal(nativeSearchEnabled, !disabled);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

it('starts OpenCode only with the exact shipped search plugin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-search-plugin-'));
  const prompt = path.join(root, 'prompt.txt');
  const plugin = path.join(root, WEB_SEARCH_PLUGIN_PATH);
  const entry = (file = plugin) => [
    [pathToFileURL(file).href, { engine: 'exa' }],
  ];
  const launch = (plugins: unknown) =>
    spawnSync(
      process.execPath,
      [
        '-e',
        OPENCODE_LAUNCHER,
        prompt,
        process.execPath,
        '-e',
        'process.stdout.write("ran")',
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify(
            plugins === undefined ? {} : { plugin: plugins },
          ),
        },
      },
    );
  await writeFile(prompt, 'Task');
  try {
    await writeFile(plugin, WEB_SEARCH_PLUGIN);
    assert.equal(launch(entry()).stdout, 'ran');
    assert.equal(launch(undefined).stdout, 'ran');
    for (const rejected of [
      entry(path.join(root, 'other.mjs')),
      [...entry(), ...entry()],
      [[pathToFileURL(plugin).href, { engine: 'auto' }]],
      [[pathToFileURL(plugin).href, { engine: 'exa', extra: 1 }]],
      ['file:///elsewhere.mjs'],
    ]) {
      const result = launch(rejected);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /exact Forge web search plugin/);
    }
    await writeFile(plugin, `${WEB_SEARCH_PLUGIN}\n// tampered`);
    assert.equal(launch(entry()).status, 1);
    await rm(plugin);
    assert.equal(launch(entry()).status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
