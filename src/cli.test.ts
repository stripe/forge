import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { createCodexAdapter } from './agents/codex/index.ts';
import {
  createDefaultCliComposition,
  runCli as invokeCli,
  type RunCliOptions,
} from './cli.ts';
import type { AgentAdapter } from './contracts/agent.ts';
import type { CompletionProvider } from './contracts/completion.ts';
import { credentialReference } from './contracts/credentials.ts';
import { createForgeEngine, defaultForgeEngine } from './engine.ts';
import type { ExecuteEvalInput } from './execution/execute.ts';
import { FORGE_VERSION, ForgeExecutionError } from './execution/index.ts';
import {
  type ExperimentConfigV1,
  parseExperimentConfigYaml,
  type SetupStepV1,
} from './model/index.ts';
import { serializeResolvedRunPlan } from './planning/index.ts';
import { type CompletedRunV1, createArtifactStore } from './results/index.ts';
import { defineSetupActionBundle } from './setup/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  type RecordedCompletionCall,
  type ScriptedCompletionHandler,
} from './testing/index.ts';

const temporaryDirectories: string[] = [];

function runCli(argv: readonly string[], options: RunCliOptions = {}) {
  const experiment = argv[argv.indexOf('--experiment') + 1];
  const cwd =
    argv[0] === 'run' && experiment && path.isAbsolute(experiment)
      ? path.dirname(experiment)
      : process.cwd();
  return invokeCli(argv, { cwd, stderr: () => undefined, ...options });
}

async function executeOffline(input: ExecuteEvalInput) {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter({
    id: input.plan.selection.agent.adapter,
  });
  return defaultForgeEngine.executeEval({
    ...input,
    composition: {
      ...input.composition,
      runtime: runtime.adapter,
      agents: new Map([[agent.adapter.id, agent.adapter]]),
    },
  });
}

function createCredentialExecution() {
  const runtime = createFakeRuntimeAdapter();
  const completionCalls: RecordedCompletionCall[] = [];
  const respond: ScriptedCompletionHandler = (request, context) => {
    completionCalls.push({ request, context });
    if (request.purpose === 'judge') {
      return JSON.stringify({
        results: [{ index: 0, passed: true, explanation: 'Task completed.' }],
      });
    }
    return request.responseSchema?.name === 'ava_initial_turn'
      ? JSON.stringify({
          user_needs: [
            { description: 'Complete the task', status: 'remaining' },
          ],
          message: 'Complete the task.',
        })
      : JSON.stringify({ remaining_need_ids: [], message: '' });
  };
  return {
    runtime,
    completionCalls,
    async execute(input: ExecuteEvalInput) {
      const selection = input.plan.selection.agent;
      const builtin = input.composition.agents.get(selection.adapter)!;
      const scripted = createScriptedAgentAdapter({
        id: selection.adapter,
        requirements: builtin.requirements(selection),
      });
      const agent: AgentAdapter = {
        ...scripted.adapter,
        ...(builtin.pluginInstaller === undefined
          ? {}
          : { pluginInstaller: builtin.pluginInstaller }),
        async openSession(context) {
          await context.runtime.commands.agent.run(['probe-agent']);
          return scripted.adapter.openSession(context);
        },
      };
      const completionProviders = new Map(
        [
          ...(input.composition.completionProviders as ReadonlyMap<
            string,
            CompletionProvider
          >),
        ].map(([id, provider]) => [
          id,
          createScriptedCompletionProvider({
            id,
            requirements: (request) => provider.requirements(request),
            responses: [respond, respond, respond],
          }).provider,
        ]),
      );
      return defaultForgeEngine.executeEval({
        ...input,
        composition: {
          ...input.composition,
          runtime: runtime.adapter,
          agents: new Map([[agent.id, agent]]),
          completionProviders,
        },
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('Forge CLI', () => {
  it('targets named groups, intersects selectors, and preserves saved group identity on resume', async () => {
    const fixture = await createGroupedBenchmarkFixture();
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    assert.ok(config.matrix.groups !== undefined);
    config.matrix.groups[0]!.id = 'sonnet';
    config.matrix.groups[1]!.id = 'opus';
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    const output = path.join(fixture.root, 'group-results');
    let stdout = '';
    let stderr = '';
    let executed = 0;
    const options: RunCliOptions = {
      environment: {},
      experimentRunIdFactory: () => 'group-run',
      runIdFactory: () => 'group-eval',
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      execute: async (input) => {
        executed += 1;
        assert.equal(input.plan.selection.group_id, 'opus');
        assert.equal(input.plan.selection.treatment, 'enhanced');
        return executeOffline(input);
      },
    };
    const base = ['--experiment', fixture.experimentPath, '--output', output];
    assert.equal(
      await runCli(
        ['run', ...base, '--group', 'opus', '--treatment', 'enhanced'],
        options,
      ),
      0,
      stderr,
    );
    const checkpoint = JSON.parse(
      await fs.readFile(
        path.join(output, 'experiments/group-run/experiment.json'),
        'utf8',
      ),
    );
    const report = JSON.parse(
      await fs.readFile(
        path.join(output, 'experiments/group-run/report.json'),
        'utf8',
      ),
    );
    assert.equal(checkpoint.entries[0].selection.group_id, 'opus');
    assert.equal(report.runs[0].selection.group_id, 'opus');
    assert.equal(report.runs.length, 1);
    assert.equal(
      await runCli(['run', ...base, '--resume', 'group-run'], options),
      0,
      stderr,
    );
    assert.equal(executed, 1);
    for (const selectors of [
      ['--group', 'missing'],
      ['--group', 'sonnet', '--treatment', 'enhanced'],
    ]) {
      assert.equal(await runCli(['run', ...base, ...selectors], options), 2);
    }
    assert.equal(
      await runCli(
        ['run', ...base, '--resume', 'group-run', '--group', 'sonnet'],
        options,
      ),
      2,
    );
    stdout = '';
    assert.equal(
      await runCli(
        ['plan', '--experiment', fixture.experimentPath, '--group', 'sonnet'],
        options,
      ),
      0,
      stderr,
    );
    assert.equal(JSON.parse(stdout).selection.group_id, 'sonnet');
    config.matrix.groups[1]!.id = 'renamed';
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    assert.equal(
      await runCli(['run', ...base, '--resume', 'group-run'], options),
      1,
    );
    assert.equal(executed, 1);
  });

  it('reports the installed package version', async () => {
    let stdout = '';
    const exitCode = await runCli(['--version'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout, `${FORGE_VERSION}\n`);
  });

  it('prints an experiment run summary and resumes its checkpoint', async () => {
    const fixture = await createBenchmarkFixture();
    const output = path.join(fixture.root, 'results');
    let stdout = '';
    let executed = 0;
    const options: RunCliOptions = {
      environment: {},
      experimentRunIdFactory: () => 'public-experiment',
      runIdFactory: () => 'public-eval',
      stdout: (text) => {
        stdout += text;
      },
      execute: async (input) => {
        executed += 1;
        return executeOffline(input);
      },
    };
    assert.equal(
      await runCli(
        ['run', '--experiment', fixture.experimentPath, '--output', output],
        options,
      ),
      0,
    );
    const summary = JSON.parse(stdout) as {
      experiment_run_id: string;
      location: string;
      checkpoint: string;
      report: string;
    };
    assert.equal(summary.experiment_run_id, 'public-experiment');
    assert.equal(
      summary.checkpoint,
      path.join(summary.location, 'experiment.json'),
    );
    assert.equal(summary.report, path.join(summary.location, 'report.json'));
    stdout = '';
    assert.equal(
      await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--output',
          output,
          '--resume',
          summary.experiment_run_id,
        ],
        options,
      ),
      0,
    );
    assert.equal(executed, 1);
    const resumed = JSON.parse(stdout) as {
      checkpoint: string;
      skipped: number;
      executed: number;
    };
    assert.equal(resumed.checkpoint, summary.checkpoint);
    assert.equal(resumed.skipped, 1);
    assert.equal(resumed.executed, 0);
    assert.ok((await fs.stat(summary.checkpoint)).isFile());
  });

  it('resumes a saved selection without expanding unrelated matrix entries', async () => {
    const fixture = await createBenchmarkFixture();
    const output = path.join(fixture.root, 'results');
    let stdout = '';
    let executed = 0;
    const options: RunCliOptions = {
      environment: {},
      experimentRunIdFactory: () => 'saved-subset',
      runIdFactory: () => 'saved-eval',
      stdout: (text) => {
        stdout += text;
      },
      execute: async (input) => {
        executed += 1;
        return executeOffline(input);
      },
    };
    assert.equal(
      await runCli(
        ['run', '--experiment', fixture.experimentPath, '--output', output],
        options,
      ),
      0,
    );
    const summary = JSON.parse(stdout) as { experiment_run_id: string };

    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    assert.ok(config.matrix.groups === undefined);
    const selectedAgent = config.matrix.agents[0]!;
    config.matrix.agents = [
      selectedAgent,
      ...Array.from({ length: 999 }, (_, index) => ({
        ...selectedAgent,
        model: `unselected-${index}`,
      })),
    ];
    config.matrix.repetitions = 10_000;
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));

    let agentEnumerations = 0;
    const engine = {
      ...defaultForgeEngine,
      loadExperimentConfig: async (experimentPath: string) => {
        const experiment =
          await defaultForgeEngine.loadExperimentConfig(experimentPath);
        assert.ok(experiment.config.matrix.groups === undefined);
        // Stop an accidental ten-million-selection expansion immediately. Matrix
        // membership checks use array.some and do not enumerate Cartesian axes.
        Object.defineProperty(
          experiment.config.matrix.agents,
          Symbol.iterator,
          {
            value: () => {
              agentEnumerations += 1;
              throw new Error(
                'Resume must not expand unsaved matrix combinations.',
              );
            },
          },
        );
        return experiment;
      },
    };
    stdout = '';
    let stderr = '';
    assert.equal(
      await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--output',
          output,
          '--resume',
          summary.experiment_run_id,
        ],
        {
          ...options,
          engine,
          stderr: (text) => {
            stderr += text;
          },
        },
      ),
      0,
      stderr,
    );
    const resumed = JSON.parse(stdout) as {
      total: number;
      skipped: number;
      executed: number;
    };
    assert.equal(resumed.total, 1);
    assert.equal(resumed.skipped, 1);
    assert.equal(resumed.executed, 0);
    assert.equal(executed, 1);
    assert.equal(agentEnumerations, 0);
  });

  it('supplies the selected external runtime to the host factory for validation and execution', async () => {
    const fixture = await createBenchmarkFixture();
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    const descriptor = {
      adapter: 'acme/process',
      platform: 'linux/amd64' as const,
      config: { profile: 'test-worker' },
    };
    await fs.writeFile(
      fixture.experimentPath,
      JSON.stringify({ ...config, runtime: descriptor }),
    );
    const runtime = createFakeRuntimeAdapter({ id: descriptor.adapter });
    const agent = createScriptedAgentAdapter({ id: 'claude-code' });
    let factoryCalls = 0;
    for (const command of ['validate', 'run']) {
      let stderr = '';
      const exitCode = await runCli(
        [command, '--experiment', fixture.experimentPath],
        {
          compositionFactory: async (options) => {
            factoryCalls += 1;
            assert.deepEqual(options.runtime, descriptor);
            return {
              runtime: runtime.adapter,
              agents: new Map([[agent.adapter.id, agent.adapter]]),
              credentialResolver: createStaticCredentialResolver(),
              inputProvider: createMemoryRunInputProvider(),
              artifactStore: createArtifactStore({ root: options.resultsRoot }),
            };
          },
          stdout: () => undefined,
          stderr: (text) => {
            stderr += text;
          },
        },
      );
      assert.ok(!stderr.includes('forge:'));
      assert.equal(exitCode, 0);
    }
    assert.equal(factoryCalls, 2);
    assert.equal(runtime.runs.length, 1);
    let stderr = '';
    const exitCode = await runCli(
      ['validate', '--experiment', fixture.experimentPath],
      {
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('host-supplied compositionFactory'));
  });

  it('validates a dataset/experiment pair and emits its resolved run count', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      ['validate', '--experiment', 'experiments/default.yaml'],
      {
        cwd: fixture.root,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    {
      const actual = JSON.parse(stdout);
      assert.ok(actual);
      assert.equal(actual.dataset.id, 'example-dataset');
      assert.equal(actual.dataset.version, '2026.09.0');
      assert.equal(actual.experiment.id, 'experiment/default');
      assert.equal(actual.experiment.version, '2026.09.0');
      assert.equal(actual.run_count, 1);
      assert.equal(actual.valid, true);
    }
  });

  it('validates grouped selections without combining coordinates across groups', async () => {
    const fixture = await createGroupedBenchmarkFixture();
    const selections: Array<readonly string[]> = [];
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(
      ['validate', '--experiment', fixture.experimentPath],
      {
        environment: {},
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        engine: {
          ...defaultForgeEngine,
          preflightEval: (input) => {
            const { case_id, treatment, agent } = input.plan.selection;
            selections.push([case_id, treatment, agent.model]);
            return defaultForgeEngine.preflightEval(input);
          },
        },
      },
    );
    assert.equal(exitCode, 0, stderr);
    assert.equal(JSON.parse(stdout).run_count, 3);
    assert.deepEqual(selections, [
      ['case/example', 'baseline', 'claude-sonnet'],
      ['case/unselected', 'baseline', 'claude-opus-4-6'],
      ['case/unselected', 'enhanced', 'claude-opus-4-6'],
    ]);
  });

  it('filters grouped plans by case file, treatment, and model without inventing combinations', async () => {
    const fixture = await createGroupedBenchmarkFixture();
    for (const [caseFile, treatment, model, expectedCode] of [
      [fixture.caseFilePath, 'baseline', 'claude-sonnet', 0],
      [fixture.unselectedCaseFilePath!, 'enhanced', 'claude-opus-4-6', 0],
      [fixture.caseFilePath, 'enhanced', 'claude-opus-4-6', 2],
      [fixture.caseFilePath, 'baseline', 'claude-opus-4-6', 2],
      [fixture.unselectedCaseFilePath!, 'enhanced', 'claude-sonnet', 2],
    ] as const) {
      let stdout = '';
      let stderr = '';
      const exitCode = await runCli(
        [
          'plan',
          '--experiment',
          fixture.experimentPath,
          '--case-file',
          caseFile,
          '--treatment',
          treatment,
          '--model',
          model,
        ],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );
      assert.equal(exitCode, expectedCode, stderr);
      if (expectedCode === 0) {
        const plan = defaultForgeEngine.parseResolvedRunPlan(
          JSON.parse(stdout),
        );
        assert.equal(plan.selection.treatment, treatment);
        assert.equal(plan.selection.agent.model, model);
        assert.equal(
          plan.selection.case_id,
          caseFile === fixture.caseFilePath
            ? 'case/example'
            : 'case/unselected',
        );
      } else {
        assert.equal(stdout, '');
        assert.ok(
          stderr.includes('Selection does not match the benchmark matrix'),
        );
      }
    }
  });

  it('checks references in all matrix groups before allocating a filtered run', async () => {
    const fixture = await createGroupedBenchmarkFixture();
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    assert.ok(config.matrix.groups !== undefined);
    config.matrix.groups[1]!.cases = ['cases/not-in-dataset.case.yaml'];
    assert.equal(config.runtime.adapter, 'docker');
    config.runtime.platform = 'native';
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    let preparations = 0;
    let executions = 0;
    let detections = 0;
    let stderr = '';
    const exitCode = await runCli(
      ['run', '--experiment', fixture.experimentPath, '--case', 'case/example'],
      {
        environment: {},
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
        detectDockerPlatform: async () => {
          detections += 1;
          return 'linux/amd64';
        },
        compositionFactory: async (options) => {
          preparations += 1;
          return createDefaultCliComposition(options);
        },
        execute: async (input) => {
          executions += 1;
          return executeOffline(input);
        },
      },
    );
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes(
        'references a case file absent from the loaded dataset manifest',
      ),
    );
    assert.equal(detections, 0);
    assert.equal(preparations, 0);
    assert.equal(executions, 0);
  });

  it('validates both native platforms without contacting Docker', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment.replace('platform: linux/amd64', 'platform: native'),
    );
    const platforms: string[] = [];
    let stderr = '';

    const exitCode = await runCli(
      ['validate', '--experiment', fixture.experimentPath],
      {
        detectDockerPlatform: async () => {
          throw new Error('Docker must not be contacted');
        },
        compositionFactory: async (options) => {
          if (options.runtime !== undefined) {
            platforms.push(options.runtime.platform);
          }
          return createDefaultCliComposition(options);
        },
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    assert.deepEqual(platforms, ['linux/amd64', 'linux/arm64']);
  });

  it('validates Docker host readiness only when requested', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment.replace('platform: linux/amd64', 'platform: native'),
    );
    const validatedPlatforms: string[] = [];
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      ['validate', '--experiment', fixture.experimentPath, '--host'],
      {
        detectDockerPlatform: async () => 'linux/arm64',
        validateDockerHost: async ({ platform }) => {
          validatedPlatforms.push(platform);
          return {
            platform,
            imageId: `sha256:${'a'.repeat(64)}`,
          };
        },
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    assert.deepEqual(validatedPlatforms, ['linux/arm64']);
    assert.deepEqual(JSON.parse(stdout).host, {
      docker_platform: 'linux/arm64',
      image_id: `sha256:${'a'.repeat(64)}`,
      runtime_platform: 'linux/arm64',
    });
  });

  it('does not build the host image when pure preflight fails', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment
        .replace('platform: linux/amd64', 'platform: native')
        .replace('adapter: claude-code', 'adapter: missing-agent'),
    );
    let hostValidationCalled = false;
    let stderr = '';

    const exitCode = await runCli(
      ['validate', '--experiment', fixture.experimentPath, '--host'],
      {
        detectDockerPlatform: async () => 'linux/arm64',
        validateDockerHost: async ({ platform }) => {
          hostValidationCalled = true;
          return { platform, imageId: `sha256:${'a'.repeat(64)}` };
        },
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('agent adapter'));
    assert.equal(hostValidationCalled, false);
  });

  for (const adapter of ['claude-code', 'codex'] as const) {
    it(`validates and plans the named plugin for ${adapter} without fetching it`, async () => {
      const fixture = await createBenchmarkFixture();
      const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
      await fs.writeFile(
        fixture.experimentPath,
        experiment
          .replace(
            'treatments:\n  baseline:\n    setup: []',
            `treatments:
  baseline:
    setup: []
  stripe-plugin:
    setup:
      - uses: forge/plugin
        with:
          plugin: stripe`,
          )
          .replace('treatments: [baseline]', 'treatments: [stripe-plugin]')
          .replace('adapter: claude-code', `adapter: ${adapter}`)
          .replace(
            'provider: anthropic',
            `provider: ${adapter === 'codex' ? 'openai' : 'anthropic'}`,
          ),
      );
      let stdout = '';
      let stderr = '';

      const exitCode = await runCli(
        ['validate', '--experiment', fixture.experimentPath],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );

      assert.equal(exitCode, 0);
      assert.ok(!stderr.includes('forge:'));
      {
        const actual = JSON.parse(stdout);
        assert.ok(actual);
        assert.equal(actual.valid, true);
        assert.equal(actual.run_count, 1);
      }
      stdout = '';
      assert.equal(
        await runCli(['plan', '--experiment', fixture.experimentPath], {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        }),
        0,
      );
      const plan = JSON.parse(stdout);
      assert.deepEqual(plan.setup, [
        { uses: 'forge/plugin', with: { plugin: 'stripe' } },
      ]);
      assert.deepEqual(plan.treatment.setup, plan.setup);
      assert.equal(plan.agent.adapter, adapter);
    });
  }

  it('prints the canonical resolved plan for one matrix selection', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case',
        'case/example',
        '--treatment',
        'baseline',
        '--agent',
        'claude-code',
        '--provider',
        'anthropic',
        '--model',
        'claude-sonnet',
        '--repetition',
        '0',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      serializeResolvedRunPlan(
        defaultForgeEngine.parseResolvedRunPlan(JSON.parse(stdout)),
      ),
    );
    {
      const actual = JSON.parse(stdout);
      assert.ok(actual);
      assert.equal(Object.hasOwn(actual, 'schema_version'), false);
      assert.equal(actual.selection.case_id, 'case/example');
      assert.equal(actual.selection.treatment, 'baseline');
      assert.equal(actual.selection.agent.adapter, 'claude-code');
      assert.equal(actual.selection.agent.provider, 'anthropic');
      assert.equal(actual.selection.agent.model, 'claude-sonnet');
      assert.equal(actual.selection.repetition, 0);
      assert.equal(actual.interaction.mode, 'one_shot');
      assert.equal(actual.interaction.effective_prompt, 'Do the thing');
    }
  });

  it('materializes a native Docker platform before printing a plan', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment.replace('platform: linux/amd64', 'platform: native'),
    );
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      ['plan', '--experiment', fixture.experimentPath],
      {
        runtimePlatform: 'linux/arm64',
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    assert.equal(JSON.parse(stdout).runtime.platform, 'linux/arm64');
  });

  it('uses an explicitly supplied engine for host action bundles', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment
        .replace(
          'runtime:',
          `forge:\n  action_bundles:\n    - namespace: acme-evals\n      version: 1.0.0\n      sha256: sha256:${'a'.repeat(64)}\nruntime:`,
        )
        .replace(
          'treatments:\n  baseline:\n    setup: []',
          'treatments:\n  baseline:\n    setup: []\n  with-tool:\n    setup:\n      - uses: acme-evals/tool\n        with: {name: formatter}',
        )
        .replace('treatments: [baseline]', 'treatments: [with-tool]'),
    );
    const engine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: {
            namespace: 'acme-evals',
            version: '1.0.0',
            sha256: `sha256:${'a'.repeat(64)}`,
          },
          actions: [
            {
              uses: 'acme-evals/tool',
              parseWith(input) {
                if (
                  input === null ||
                  typeof input !== 'object' ||
                  typeof (input as { name?: unknown }).name !== 'string'
                ) {
                  throw new TypeError('invalid tool');
                }
                return { name: (input as { name: string }).name };
              },
              preflight() {
                return { requirements: {}, async apply() {} };
              },
            },
          ],
        }),
      ],
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      ['plan', '--experiment', fixture.experimentPath],
      {
        engine,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    {
      const actual = JSON.parse(stdout);
      assert.ok(actual);
      assert.deepEqual(
        actual.setup.map((item: { uses: string; with: { name: string } }) => ({
          uses: item.uses,
          with: { name: item.with.name },
        })),
        [{ uses: 'acme-evals/tool', with: { name: 'formatter' } }],
      );
      assert.deepEqual(
        actual.provenance.forge.action_bundles.map(
          (item: { namespace: string; version: string }) => ({
            namespace: item.namespace,
            version: item.version,
          }),
        ),
        [{ namespace: 'acme-evals', version: '1.0.0' }],
      );
    }
  });

  it('runs a host action bundle through an explicitly supplied engine', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment
        .replace(
          'runtime:',
          `forge:\n  action_bundles:\n    - namespace: acme-evals\n      version: 1.0.0\n      sha256: sha256:${'a'.repeat(64)}\nruntime:`,
        )
        .replace(
          'treatments:\n  baseline:\n    setup: []',
          'treatments:\n  baseline:\n    setup: []\n  with-tool:\n    setup:\n      - uses: acme-evals/tool\n        with: {name: formatter}',
        )
        .replace('treatments: [baseline]', 'treatments: [with-tool]'),
    );
    let applied = false;
    const engine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: {
            namespace: 'acme-evals',
            version: '1.0.0',
            sha256: `sha256:${'a'.repeat(64)}`,
          },
          actions: [
            {
              uses: 'acme-evals/tool',
              parseWith(input) {
                if (
                  input === null ||
                  typeof input !== 'object' ||
                  typeof (input as { name?: unknown }).name !== 'string'
                ) {
                  throw new TypeError('invalid tool');
                }
                return { name: (input as { name: string }).name };
              },
              preflight() {
                return {
                  requirements: {},
                  async apply() {
                    applied = true;
                  },
                };
              },
            },
          ],
        }),
      ],
    });
    const runtime = createFakeRuntimeAdapter({ id: 'forge/docker' });
    const agent = createScriptedAgentAdapter({ id: 'claude-code' });
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--run-id',
        'host-action-run',
      ],
      {
        engine,
        compositionFactory: async ({ resultsRoot }) => ({
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root: resultsRoot }),
        }),
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    assert.equal(applied, true);
    const completed = await engine.verifyCompletedRun(
      path.join(JSON.parse(stdout).location, 'runs', 'host-action-run'),
    );
    {
      const actual = completed;
      assert.ok(actual);
      assert.equal(actual.runId, 'host-action-run');
      assert.deepEqual(
        actual.result.forge.action_bundles!.map((item) => ({
          namespace: item.namespace,
          version: item.version,
        })),
        [{ namespace: 'acme-evals', version: '1.0.0' }],
      );
    }
  });

  it('selects a manifest case by file within the configured dataset', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.caseFilePath,
        '--agent',
        'claude-code',
        '--model',
        'claude-sonnet',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!stderr.includes('forge:'));
    {
      const actual = JSON.parse(stdout).selection;
      assert.ok(actual);
      assert.equal(actual.case_id, 'case/example');
      assert.equal(actual.agent.adapter, 'claude-code');
      assert.equal(actual.agent.model, 'claude-sonnet');
    }
  });

  it('resolves dataset.path relative to the experiment file', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        'experiments/default.yaml',
        '--case-file',
        'dataset/cases/example.case.yaml',
      ],
      {
        cwd: fixture.root,
        stdout: (text) => {
          stdout += text;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout).selection.case_id, 'case/example');
  });

  it('accepts case-file selection for run without changing plan provenance', async () => {
    const fixture = await createBenchmarkFixture();
    let selectedCaseId: string | undefined;
    let stdout = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.caseFilePath,
        '--run-id',
        'case-file-run',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        execute: async (input) => {
          const { plan } = input;
          selectedCaseId = plan.selection.case_id;
          return executeOffline(input);
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(selectedCaseId, 'case/example');
    {
      const actual = JSON.parse(stdout);
      assert.ok(actual);
      assert.equal(actual.completed, 1);
      assert.equal(actual.errored, 0);
    }
    let expectedPlan = '';
    assert.equal(
      await runCli(
        [
          'plan',
          '--experiment',
          fixture.experimentPath,
          '--case',
          'case/example',
        ],
        {
          stdout: (text) => {
            expectedPlan += text;
          },
        },
      ),
      0,
    );
    const experimentRun = JSON.parse(stdout) as { location: string };
    const storedPlan = await fs.readFile(
      path.join(experimentRun.location, 'runs', 'case-file-run', 'plan.json'),
      'utf8',
    );
    assert.equal(storedPlan, expectedPlan);
    assert.ok(!storedPlan.includes(fixture.caseFilePath));
  });

  it('rejects combining case ID and case file selectors', async () => {
    const fixture = await createBenchmarkFixture();
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case',
        'case/example',
        '--case-file',
        fixture.caseFilePath,
      ],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.ok(stderr.includes('--case and --case-file cannot be combined'));
  });

  it('rejects a case-file traversal that resolves outside the dataset', async () => {
    const fixture = await createBenchmarkFixture();
    const outside = path.join(fixture.root, 'outside.yaml');
    await fs.writeFile(outside, 'id: outside\n');
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        path.join(fixture.datasetRoot, 'cases', '..', '..', 'outside.yaml'),
      ],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.match(stderr, /outside.*dataset/i);
  });

  it('rejects a file that is not a case entry in the manifest', async () => {
    const fixture = await createBenchmarkFixture();
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        path.join(fixture.datasetRoot, 'manifest.json'),
      ],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.match(stderr, /manifest.*case|case.*manifest/i);
  });

  it('rejects a manifest case that is not an experiment matrix member', async () => {
    const fixture = await createBenchmarkFixture({
      includeUnselectedCase: true,
    });
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.unselectedCaseFilePath!,
      ],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.ok(stderr.includes('Selection does not match the benchmark matrix'));
  });

  it('assembles the public Docker/Claude/Codex defaults with explicit credentials', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: { 'anthropic.api-key': 'ANTHROPIC_API_KEY' },
      environment: { ANTHROPIC_API_KEY: 'test-api-key' },
    });

    assert.equal(composition.runtime.id, 'forge/docker');
    assert.deepEqual([...composition.agents.keys()], ['claude-code', 'codex']);
    assert.equal(composition.agents.get('claude-code')?.version, FORGE_VERSION);
    assert.equal(composition.agents.get('codex')?.version, FORGE_VERSION);
    assert.deepEqual(
      [
        ...(
          composition.completionProviders as ReadonlyMap<string, unknown>
        ).keys(),
      ],
      ['anthropic', 'openai'],
    );
    assert.equal(
      (
        composition.completionProviders as ReadonlyMap<
          string,
          { version: string }
        >
      ).get('anthropic')?.version,
      FORGE_VERSION,
    );
    assert.equal(
      await composition.credentialResolver.resolve(
        credentialReference('anthropic.api-key'),
        {
          runId: 'run-1',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
      'test-api-key',
    );
  });

  it('does not authorize exported provider or Stripe secrets without explicit bindings', async () => {
    const fixture = await createBenchmarkFixture();
    let secretReads = 0;
    const environment = Object.fromEntries(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'STRIPE_API_KEY',
      ].map((name) => [name, 'ambient-secret']),
    );
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      environment: new Proxy(environment, {
        get(target, name, receiver) {
          if (typeof name === 'string' && Object.hasOwn(target, name)) {
            secretReads += 1;
          }
          return Reflect.get(target, name, receiver);
        },
      }),
    });
    for (const reference of [
      'anthropic.api-key',
      'anthropic.auth-token',
      'anthropic.completion-api-key',
      'anthropic.completion-auth-token',
      'openai.api-key',
      'openai.completion-api-key',
      'env:STRIPE_API_KEY',
    ]) {
      await assert.rejects(
        composition.credentialResolver.resolve(credentialReference(reference), {
          runId: 'unbound',
          purpose: 'test',
          signal: new AbortController().signal,
        }),
        /No environment binding exists/,
      );
    }
    assert.equal(secretReads, 0);
  });

  it('uses separate explicit grants for OpenAI host completions and the Codex agent', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: {
        'openai.api-key': 'OPENAI_API_KEY',
        'openai.completion-api-key': 'OPENAI_API_KEY',
      },
      environment: {
        OPENAI_API_KEY: 'shared-key',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
      },
    });
    const provider = (
      composition.completionProviders as ReadonlyMap<
        string,
        import('./contracts/completion.ts').CompletionProvider
      >
    ).get('openai')!;
    assert.deepEqual(provider.metadata, { endpoint_mode: 'custom' });
    assert.deepEqual(
      provider.requirements({
        model: { provider: 'openai', model: 'gpt-6.1-sol' },
        purpose: 'judge',
      }),
      { credentials: { apiKey: { reference: 'openai.completion-api-key' } } },
    );
    const scope = {
      runId: 'run-1',
      purpose: 'judge',
      signal: new AbortController().signal,
    };
    assert.equal(
      await composition.credentialResolver.resolve(
        credentialReference('openai.completion-api-key'),
        scope,
      ),
      'shared-key',
    );
    assert.equal(
      await composition.credentialResolver.resolve(
        credentialReference('openai.api-key'),
        scope,
      ),
      'shared-key',
    );
    const noHostKey = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'other-results'),
      environment: {},
    });
    await assert.rejects(
      noHostKey.credentialResolver.resolve(
        credentialReference('openai.completion-api-key'),
        scope,
      ),
    );
  });

  it('validates and plans the Codex fixture without credentials or Docker', async () => {
    for (const command of ['validate', 'plan']) {
      let stdout = '';
      let stderr = '';
      const code = await runCli(
        [command, '--experiment', 'test/fixtures/codex/experiment.yaml'],
        {
          environment: {},
          stdout: (value) => {
            stdout += value;
          },
          stderr: (value) => {
            stderr += value;
          },
        },
      );
      assert.ok(!stderr.includes('forge:'));
      assert.equal(code, 0);
      if (command === 'validate') assert.equal(JSON.parse(stdout).valid, true);
      else
        assert.deepEqual(JSON.parse(stdout).selection.agent, {
          adapter: 'codex',
          provider: 'openai',
          model: 'gpt-5.4',
          hook_trust: 'native',
        });
    }
  });

  it('delivers an explicitly bound Codex credential as OPENAI_API_KEY', async () => {
    const fixture = await createBenchmarkFixture();
    for (const compatible of [false, true]) {
      const composition = await createDefaultCliComposition({
        datasetRoot: fixture.datasetRoot,
        resultsRoot: path.join(fixture.root, 'results'),
        credentialBindings: { 'openai.api-key': 'OPENAI_API_KEY' },
        environment: {
          OPENAI_API_KEY: 'codex-test-key',
          ...(compatible
            ? { OPENAI_BASE_URL: 'https://gateway.example.test/v1' }
            : {}),
        },
      });
      const codex = composition.agents.get('codex')!;
      assert.equal(codex.version, FORGE_VERSION);
      {
        const actual = codex.requirements({
          adapter: 'codex',
          provider: 'openai',
          model: 'gpt-5.4',
        });
        assert.ok(actual);
        assert.equal(
          actual.environment.variables!.CODEX_HOME,
          '/home/forge/.codex',
        );
        assert.equal(
          actual.environment.credentials!.OPENAI_API_KEY!.reference,
          'openai.api-key',
        );
      }
      assert.equal(
        await composition.credentialResolver.resolve(
          credentialReference('openai.api-key'),
          {
            runId: 'codex-cli',
            purpose: 'agent',
            signal: new AbortController().signal,
          },
        ),
        'codex-test-key',
      );
    }
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: { 'openai.api-key': 'MY_CODEX_KEY' },
      environment: { MY_CODEX_KEY: 'explicit-key' },
    });
    assert.equal(
      await composition.credentialResolver.resolve(
        credentialReference('openai.api-key'),
        {
          runId: 'codex-cli',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
      'explicit-key',
    );
  });

  it('selects standard gateway authentication when ANTHROPIC_BASE_URL is set', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: { 'anthropic.auth-token': 'ANTHROPIC_AUTH_TOKEN' },
      environment: {
        ANTHROPIC_API_KEY: 'direct-key-must-not-be-selected',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic/',
      },
    });
    const claude = composition.agents.get('claude-code');
    assert.notEqual(claude, undefined);
    assert.equal(claude!.version, FORGE_VERSION);
    assert.equal(
      (
        composition.completionProviders as ReadonlyMap<
          string,
          { version: string }
        >
      ).get('anthropic')?.version,
      FORGE_VERSION,
    );
    const requirements = claude!.requirements({
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet',
    });

    assert.deepEqual(requirements.environment.variables, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic/',
    });
    assert.deepEqual(requirements.environment.credentials, {
      ANTHROPIC_AUTH_TOKEN: {
        reference: 'anthropic.auth-token',
      },
    });
    assert.ok(!('ANTHROPIC_API_KEY' in requirements.environment.credentials));
    assert.equal(
      await composition.credentialResolver.resolve(
        credentialReference('anthropic.auth-token'),
        {
          runId: 'run-1',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
      'gateway-token',
    );
    await assert.rejects(
      composition.credentialResolver.resolve(
        credentialReference('anthropic.api-key'),
        {
          runId: 'run-1',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
      /No environment binding exists/,
    );
  });

  for (const variant of [
    {
      label: 'Codex',
      agent: 'codex' as const,
      name: 'OPENAI_API_KEY',
      reference: 'openai.api-key',
      completionReference: 'openai.completion-api-key',
      environment: {},
    },
    {
      label: 'Claude Code',
      agent: 'claude-code' as const,
      name: 'ANTHROPIC_API_KEY',
      reference: 'anthropic.api-key',
      completionReference: 'anthropic.completion-api-key',
      environment: {},
    },
    {
      label: 'Claude Code gateway',
      agent: 'claude-code' as const,
      name: 'ANTHROPIC_AUTH_TOKEN',
      reference: 'anthropic.auth-token',
      completionReference: 'anthropic.completion-auth-token',
      environment: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
      },
    },
  ]) {
    it(`validates duplicate ${variant.label} credential declarations without secrets and merges explicit same-source grants`, async () => {
      const fixture = await createBenchmarkFixture({
        agent: variant.agent,
        caseSetup: [
          { uses: 'forge/credentials', with: { env: [variant.name] } },
          { uses: 'forge/command', with: { argv: ['probe-setup'] } },
        ],
      });
      for (const command of ['validate', 'plan']) {
        let stderr = '';
        assert.equal(
          await runCli([command, '--experiment', fixture.experimentPath], {
            environment: variant.environment,
            stdout: () => undefined,
            stderr: (text) => {
              stderr += text;
            },
          }),
          0,
          stderr,
        );
      }
      for (const grants of [
        [variant.name, 'UNDECLARED_TOKEN'],
        [`${variant.reference}=SHARED_KEY`, `env:${variant.name}=SHARED_KEY`],
      ]) {
        const execution = createCredentialExecution();
        let output = '';
        const exitCode = await runCli(
          [
            'run',
            '--experiment',
            fixture.experimentPath,
            ...grants.flatMap((grant) => ['--credential-env', grant]),
          ],
          {
            environment: {
              ...variant.environment,
              [variant.name]: 'explicit-shared-key',
              SHARED_KEY: 'explicit-shared-key',
              UNDECLARED_TOKEN: 'must-not-be-forwarded',
            },
            stdout: (text) => {
              output += text;
            },
            stderr: (text) => {
              output += text;
            },
            execute: async (input) => {
              await assert.rejects(
                input.composition.credentialResolver.resolve(
                  credentialReference(variant.completionReference),
                  {
                    runId: input.runId,
                    purpose: 'judge',
                    signal: input.signal ?? new AbortController().signal,
                  },
                ),
                /No environment binding exists/,
              );
              return execution.execute(input);
            },
          },
        );
        assert.equal(exitCode, 0, output);
        assert.equal(execution.runtime.runs.length, 1);
        const run = execution.runtime.runs[0]!;
        assert.deepEqual(run.input.environment.credentials, {
          [variant.name]: {
            value: 'explicit-shared-key',
            scopes: ['agent'],
          },
        });
        assert.deepEqual(
          run.commands.map(({ argv, credentialEnvironmentNames }) => ({
            argv,
            credentialEnvironmentNames,
          })),
          [
            { argv: ['probe-setup'], credentialEnvironmentNames: [] },
            {
              argv: ['probe-agent'],
              credentialEnvironmentNames: [variant.name],
            },
          ],
        );
        assert.ok(!output.includes('explicit-shared-key'));
      }
    });

    it(`shares one ${variant.label} grant across the agent, application, Ava, and judge`, async () => {
      const provider = variant.agent === 'codex' ? 'openai' : 'anthropic';
      const model = {
        provider,
        model: provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6',
      };
      const fixture = await createBenchmarkFixture({
        agent: variant.agent,
        withHostCompletions: true,
        ...(provider === 'openai'
          ? {}
          : { models: { role_player: model, judge: model } }),
        caseSetup: [
          { uses: 'forge/credentials', with: { env: [variant.name] } },
          { uses: 'forge/command', with: { argv: ['probe-setup'] } },
        ],
      });
      const execution = createCredentialExecution();
      let output = '';
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--credential-env',
          variant.name,
        ],
        {
          environment: {
            ...variant.environment,
            [variant.name]: 'shared-consumer-secret',
          },
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
          execute: async (input) => {
            const unusedReference =
              provider === 'openai'
                ? 'anthropic.completion-api-key'
                : variant.name === 'ANTHROPIC_API_KEY'
                  ? 'anthropic.completion-auth-token'
                  : 'anthropic.completion-api-key';
            await assert.rejects(
              input.composition.credentialResolver.resolve(
                credentialReference(unusedReference),
                {
                  runId: input.runId,
                  purpose: 'judge',
                  signal: input.signal ?? new AbortController().signal,
                },
              ),
              /No environment binding exists/,
            );
            return execution.execute(input);
          },
        },
      );
      assert.equal(exitCode, 0, output);
      assert.deepEqual(
        execution.completionCalls.map(({ request, context }) => ({
          purpose: request.purpose,
          provider: request.model.provider,
          credentials: context.credentials,
        })),
        ['role_player', 'role_player', 'judge'].map((purpose) => ({
          purpose,
          provider,
          credentials: {
            [variant.name === 'ANTHROPIC_AUTH_TOKEN' ? 'authToken' : 'apiKey']:
              'shared-consumer-secret',
          },
        })),
      );
      assert.deepEqual(
        execution.runtime.runs[0]!.input.environment.credentials,
        {
          [variant.name]: {
            value: 'shared-consumer-secret',
            scopes: ['agent'],
          },
        },
      );
      assert.deepEqual(
        execution.runtime.runs[0]!.commands.map(
          ({ credentialEnvironmentNames }) => credentialEnvironmentNames,
        ),
        [[], [variant.name]],
      );
      assert.ok(!output.includes('shared-consumer-secret'));
    });

    it(`keeps a ${variant.label} host-completion grant from authorizing the runtime`, async () => {
      const fixture = await createBenchmarkFixture({ agent: variant.agent });
      const execution = createCredentialExecution();
      let output = '';
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--credential-env',
          `${variant.completionReference}=${variant.name}`,
        ],
        {
          environment: {
            ...variant.environment,
            [variant.name]: 'host-completion-secret',
          },
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
          execute: async (input) => {
            const provider = (
              input.composition.completionProviders as ReadonlyMap<
                string,
                CompletionProvider
              >
            ).get(input.plan.selection.agent.provider)!;
            const requirements = provider.requirements({
              model: {
                provider: provider.id,
                model:
                  provider.id === 'openai'
                    ? 'gpt-6.1-sol'
                    : 'claude-sonnet-4-6',
              },
              purpose: 'judge',
            });
            assert.deepEqual(
              Object.values(requirements.credentials ?? {}).map(
                ({ reference }) => reference,
              ),
              [variant.completionReference],
            );
            assert.equal(
              await input.composition.credentialResolver.resolve(
                credentialReference(variant.completionReference),
                {
                  runId: input.runId,
                  purpose: 'judge',
                  signal: input.signal ?? new AbortController().signal,
                },
              ),
              'host-completion-secret',
            );
            return execution.execute(input);
          },
        },
      );
      assert.equal(exitCode, 1, output);
      assert.equal(execution.runtime.runs.length, 0);
      assert.ok(output.includes(`--credential-env ${variant.name}`));
      assert.ok(!output.includes('host-completion-secret'));
    });
  }

  it('keeps independently selected host providers scoped with shorthand and explicit host grants', async () => {
    const fixture = await createBenchmarkFixture({
      withHostCompletions: true,
      models: {
        role_player: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      },
    });
    for (const hostGrant of [
      'OPENAI_API_KEY',
      'openai.completion-api-key=JUDGE_KEY',
    ]) {
      const execution = createCredentialExecution();
      let output = '';
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--credential-env',
          'ANTHROPIC_API_KEY',
          '--credential-env',
          hostGrant,
        ],
        {
          environment: {
            ANTHROPIC_API_KEY: 'agent-and-ava-key',
            OPENAI_API_KEY: 'host-only-key',
            JUDGE_KEY: 'host-only-key',
          },
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
          execute: async (input) => {
            await assert.rejects(
              input.composition.credentialResolver.resolve(
                credentialReference('openai.api-key'),
                {
                  runId: input.runId,
                  purpose: 'agent',
                  signal: input.signal ?? new AbortController().signal,
                },
              ),
              /No environment binding exists/,
            );
            return execution.execute(input);
          },
        },
      );
      assert.equal(exitCode, 0, output);
      assert.deepEqual(
        execution.completionCalls.map(({ request, context }) => ({
          purpose: request.purpose,
          provider: request.model.provider,
          credentials: context.credentials,
        })),
        [
          {
            purpose: 'role_player',
            provider: 'anthropic',
            credentials: { apiKey: 'agent-and-ava-key' },
          },
          {
            purpose: 'role_player',
            provider: 'anthropic',
            credentials: { apiKey: 'agent-and-ava-key' },
          },
          {
            purpose: 'judge',
            provider: 'openai',
            credentials: { apiKey: 'host-only-key' },
          },
        ],
      );
      assert.deepEqual(
        execution.runtime.runs[0]!.input.environment.credentials,
        {
          ANTHROPIC_API_KEY: { value: 'agent-and-ava-key', scopes: ['agent'] },
        },
      );
      assert.ok(!output.includes('host-only-key'));
      assert.ok(!output.includes('agent-and-ava-key'));
    }
  });

  it('requires a host completion grant even when an agent grant reads the same exported variable', async () => {
    const fixture = await createBenchmarkFixture({
      agent: 'codex',
      withHostCompletions: true,
    });
    const execution = createCredentialExecution();
    let output = '';
    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        'openai.api-key=OPENAI_API_KEY',
      ],
      {
        environment: { OPENAI_API_KEY: 'agent-only-secret' },
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          output += text;
        },
        execute: execution.execute,
      },
    );
    assert.equal(exitCode, 1, output);
    assert.equal(execution.runtime.runs.length, 0);
    assert.equal(execution.completionCalls.length, 0);
    assert.ok(output.includes('openai.completion-api-key'));
    assert.ok(output.includes('--credential-env OPENAI_API_KEY'));
    assert.ok(!output.includes('agent-only-secret'));
  });

  it('expands host grants only for filtered selections and restores that scope on resume', async () => {
    const fixture = await createBenchmarkFixture({
      withHostCompletions: true,
      includeUnselectedCase: true,
    });
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    assert.ok(config.matrix.groups === undefined);
    config.matrix.cases.push('cases/unselected.case.yaml');
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    const execution = createCredentialExecution();
    let attempts = 0;
    let output = '';
    const options: RunCliOptions = {
      environment: {
        ANTHROPIC_API_KEY: 'agent-secret',
        OPENAI_API_KEY: 'unused-host-secret',
      },
      experimentRunIdFactory: () => 'filtered-grants',
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        output += text;
      },
      execute: async (input) => {
        attempts += 1;
        assert.equal(input.plan.selection.case_id, 'case/unselected');
        await assert.rejects(
          input.composition.credentialResolver.resolve(
            credentialReference('openai.completion-api-key'),
            {
              runId: input.runId,
              purpose: 'judge',
              signal: input.signal ?? new AbortController().signal,
            },
          ),
          /No environment binding exists/,
        );
        if (attempts === 1) throw new Error('Retry this selected case.');
        return execution.execute(input);
      },
    };
    const args = [
      'run',
      '--experiment',
      fixture.experimentPath,
      '--credential-env',
      'ANTHROPIC_API_KEY',
      '--credential-env',
      'OPENAI_API_KEY',
    ];
    assert.equal(
      await runCli([...args, '--case', 'case/unselected'], options),
      1,
      output,
    );
    output = '';
    assert.equal(
      await runCli([...args, '--resume', 'filtered-grants'], options),
      0,
      output,
    );
    assert.equal(attempts, 2);
    assert.equal(execution.runtime.runs.length, 1);
    assert.equal(execution.completionCalls.length, 0);
    assert.deepEqual(execution.runtime.runs[0]!.input.environment.credentials, {
      ANTHROPIC_API_KEY: { value: 'agent-secret', scopes: ['agent'] },
    });
    assert.ok(!output.includes('unused-host-secret'));
  });

  it('rejects incomplete or different-source duplicate grants before reading secret values', async () => {
    const fixture = await createBenchmarkFixture({
      agent: 'codex',
      caseSetup: [
        { uses: 'forge/credentials', with: { env: ['OPENAI_API_KEY'] } },
      ],
    });
    for (const grants of [
      ['openai.api-key=AGENT_KEY'],
      ['env:OPENAI_API_KEY=APPLICATION_KEY'],
      ['openai.api-key=AGENT_KEY', 'env:OPENAI_API_KEY=APPLICATION_KEY'],
    ]) {
      const execution = createCredentialExecution();
      let reads = 0;
      let output = '';
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          ...grants.flatMap((grant) => ['--credential-env', grant]),
        ],
        {
          environment: {
            get AGENT_KEY() {
              reads += 1;
              return 'same-secret-value';
            },
            get APPLICATION_KEY() {
              reads += 1;
              return 'same-secret-value';
            },
          },
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
          execute: execution.execute,
        },
      );
      assert.equal(exitCode, 1, output);
      assert.equal(reads, 0);
      assert.equal(execution.runtime.runs.length, 0);
      assert.match(
        output,
        /OPENAI_API_KEY has conflicting credential references/,
      );
      assert.ok(output.includes('--credential-env OPENAI_API_KEY'));
      assert.ok(!output.includes('same-secret-value'));
    }
  });

  it('does not use an unselected agent alias to authorize an application credential', async () => {
    const fixture = await createBenchmarkFixture({
      agent: 'codex',
      caseSetup: [
        { uses: 'forge/credentials', with: { env: ['ANTHROPIC_API_KEY'] } },
      ],
    });
    const execution = createCredentialExecution();
    let stderr = '';
    assert.equal(
      await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--credential-env',
          'OPENAI_API_KEY',
          '--credential-env',
          'anthropic.api-key=ANTHROPIC_API_KEY',
        ],
        {
          environment: {
            OPENAI_API_KEY: 'codex-secret',
            ANTHROPIC_API_KEY: 'application-secret',
          },
          stdout: () => undefined,
          stderr: (text) => {
            stderr += text;
          },
          execute: execution.execute,
        },
      ),
      1,
      stderr,
    );
    assert.equal(execution.runtime.runs.length, 0);
    assert.ok(stderr.includes('--credential-env ANTHROPIC_API_KEY'));
    assert.ok(!stderr.includes('application-secret'));
    stderr = '';
    assert.equal(
      await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          '--credential-env',
          'OPENAI_API_KEY',
          '--credential-env',
          'ANTHROPIC_API_KEY',
        ],
        {
          environment: {
            OPENAI_API_KEY: 'codex-secret',
            ANTHROPIC_API_KEY: 'application-secret',
          },
          stdout: () => undefined,
          stderr: (text) => {
            stderr += text;
          },
          execute: async (input) => {
            await assert.rejects(
              input.composition.credentialResolver.resolve(
                credentialReference('anthropic.api-key'),
                {
                  runId: input.runId,
                  purpose: 'agent',
                  signal: input.signal ?? new AbortController().signal,
                },
              ),
              /No environment binding exists/,
            );
            return execution.execute(input);
          },
        },
      ),
      0,
      stderr,
    );
    assert.deepEqual(execution.runtime.runs[0]!.input.environment.credentials, {
      OPENAI_API_KEY: { value: 'codex-secret', scopes: ['agent'] },
      ANTHROPIC_API_KEY: { value: 'application-secret', scopes: ['agent'] },
    });
  });

  it('preserves a custom resolver and the library Codex credential environment', async () => {
    const fixture = await createBenchmarkFixture({ agent: 'codex' });
    const execution = createCredentialExecution();
    const resolved: string[] = [];
    let stderr = '';
    assert.equal(
      await runCli(['run', '--experiment', fixture.experimentPath], {
        environment: {},
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
        compositionFactory: async (options) => ({
          ...(await createDefaultCliComposition(options)),
          agents: new Map([['codex', createCodexAdapter()]]),
          credentialResolver: createStaticCredentialResolver(
            { 'openai.api-key': 'embedding-owned-key' },
            { onResolve: (reference) => resolved.push(reference) },
          ),
        }),
        execute: execution.execute,
      }),
      0,
      stderr,
    );
    assert.deepEqual(resolved, ['openai.api-key']);
    assert.deepEqual(execution.runtime.runs[0]!.input.environment.credentials, {
      CODEX_API_KEY: { value: 'embedding-owned-key', scopes: ['agent'] },
    });
  });

  it('binds explicit credential references to host environment variables for run', async () => {
    const fixture = await createBenchmarkFixture();
    let resolved: string | undefined;

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        'stripe.mcp-token=STRIPE_MCP_TOKEN',
      ],
      {
        stdout: () => undefined,
        environment: {
          ANTHROPIC_API_KEY: 'anthropic-key',
          STRIPE_MCP_TOKEN: 'mcp-secret',
          UNDECLARED_TOKEN: 'must-not-be-selected',
        },
        execute: async (input) => {
          const { runId, composition } = input;
          resolved = await composition.credentialResolver.resolve(
            credentialReference('stripe.mcp-token'),
            {
              runId,
              purpose: 'test',
              signal: new AbortController().signal,
            },
          );
          return executeOffline(input);
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(resolved, 'mcp-secret');
  });

  it('binds an agent credential to an alternate host variable', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: { 'anthropic.api-key': 'ALTERNATE_ANTHROPIC_KEY' },
      environment: {
        ANTHROPIC_API_KEY: 'default-key',
        ALTERNATE_ANTHROPIC_KEY: 'alternate-key',
      },
    });

    assert.equal(
      await composition.credentialResolver.resolve(
        credentialReference('anthropic.api-key'),
        {
          runId: 'run-override',
          purpose: 'test',
          signal: new AbortController().signal,
        },
      ),
      'alternate-key',
    );
  });

  it('remaps a plugin host credential while preserving its runtime name and agent scope', async () => {
    const fixture = await createBenchmarkFixture();
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    config.treatments['with-plugin'] = {
      setup: [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }],
    };
    assert.ok(config.matrix.groups === undefined);
    config.matrix.treatments = ['with-plugin'];
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    const runtime = createFakeRuntimeAdapter();
    const scripted = createScriptedAgentAdapter({ id: 'claude-code' });
    const agent: AgentAdapter = {
      ...scripted.adapter,
      pluginInstaller: {
        supportsMcpBearerAuth: true,
        preflight(distribution, context) {
          return {
            requirements: { executables: [], stateDirectories: [] },
            async install({ commands }) {
              await commands.run(['probe-plugin-setup']);
              return {
                adapter: context.selection.adapter,
                plugin: distribution.plugin,
                marketplace: distribution.marketplace,
                marketplace_commit: 'a'.repeat(40),
                native_plugin_id: distribution.plugin,
                version: '1.0.0',
                source: { kind: 'marketplace-path' },
                installed_tree: {
                  format: 'forge-plugin-tree-v1',
                  sha256: `sha256:${'b'.repeat(64)}`,
                  entry_count: 1,
                  file_count: 1,
                  size_bytes: 1,
                },
              };
            },
          };
        },
      },
      async openSession(context) {
        await context.runtime.commands.agent.run(['probe-agent']);
        return scripted.adapter.openSession(context);
      },
    };
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        'env:STRIPE_API_KEY=STRIPE_TEST_KEY',
      ],
      {
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
        environment: {
          STRIPE_API_KEY: 'default-must-not-be-selected',
          STRIPE_TEST_KEY: 'explicit-plugin-key',
        },
        execute: (input) =>
          defaultForgeEngine.executeEval({
            ...input,
            composition: {
              ...input.composition,
              runtime: runtime.adapter,
              agents: new Map([[agent.id, agent]]),
            },
          }),
      },
    );

    assert.equal(exitCode, 0, stderr);
    assert.equal(runtime.runs.length, 1);
    assert.deepEqual(runtime.runs[0]!.input.environment.credentials, {
      STRIPE_API_KEY: { value: 'explicit-plugin-key', scopes: ['agent'] },
    });
    assert.deepEqual(
      runtime.runs[0]!.commands.map(({ argv, credentialEnvironmentNames }) => ({
        argv,
        credentialEnvironmentNames,
      })),
      [
        { argv: ['probe-plugin-setup'], credentialEnvironmentNames: [] },
        {
          argv: ['probe-agent'],
          credentialEnvironmentNames: ['STRIPE_API_KEY'],
        },
      ],
    );
  });

  it('requires an explicit grant even when the selected Stripe plugin secret is exported', async () => {
    const fixture = await createBenchmarkFixture({
      caseSetup: [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }],
    });
    const execution = createCredentialExecution();
    let output = '';
    let stripeReads = 0;
    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        'ANTHROPIC_API_KEY',
      ],
      {
        environment: {
          ANTHROPIC_API_KEY: 'selected-agent-secret',
          get STRIPE_API_KEY() {
            stripeReads += 1;
            return 'ungranted-plugin-secret';
          },
        },
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          output += text;
        },
        execute: execution.execute,
      },
    );
    assert.equal(exitCode, 1, output);
    assert.equal(stripeReads, 0);
    assert.equal(execution.runtime.runs.length, 0);
    assert.ok(output.includes('--credential-env STRIPE_API_KEY'));
    assert.ok(!output.includes('ungranted-plugin-secret'));
    assert.ok(!output.includes('selected-agent-secret'));
  });

  it('validates and plans case and treatment credentials without host bindings', async () => {
    const caseSetup: SetupStepV1[] = [
      { uses: 'forge/credentials', with: { env: ['API_TOKEN'] } },
    ];
    const treatmentSetup: SetupStepV1[] = [
      { uses: 'forge/credentials', with: { env: ['SECOND_API_TOKEN'] } },
    ];
    const fixture = await createBenchmarkFixture({ caseSetup });
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    config.treatments.authenticated = { setup: treatmentSetup };
    assert.ok(config.matrix.groups === undefined);
    config.matrix.treatments = ['baseline', 'authenticated'];
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    let stdout = '';
    let stderr = '';
    const options: RunCliOptions = {
      environment: {},
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    };

    assert.equal(
      await runCli(
        ['validate', '--experiment', fixture.experimentPath],
        options,
      ),
      0,
      stderr,
    );
    assert.equal(JSON.parse(stdout).run_count, 2);
    for (const treatment of ['baseline', 'authenticated']) {
      stdout = '';
      assert.equal(
        await runCli(
          [
            'plan',
            '--experiment',
            fixture.experimentPath,
            '--treatment',
            treatment,
          ],
          options,
        ),
        0,
        stderr,
      );
      const plan = JSON.parse(stdout);
      const selectedSetup = treatment === 'baseline' ? [] : treatmentSetup;
      assert.deepEqual(plan.case.setup, caseSetup);
      assert.deepEqual(plan.treatment.setup, selectedSetup);
      assert.deepEqual(plan.setup, [...caseSetup, ...selectedSetup]);
    }
  });

  it('forwards explicitly bound case and treatment credentials only to the agent and redacts them', async () => {
    const fixture = await createBenchmarkFixture({
      caseSetup: [
        { uses: 'forge/credentials', with: { env: ['API_TOKEN'] } },
        { uses: 'forge/command', with: { argv: ['probe-setup'] } },
      ],
    });
    const config = parseExperimentConfigYaml(
      await fs.readFile(fixture.experimentPath, 'utf8'),
    );
    config.treatments.authenticated = {
      setup: [
        { uses: 'forge/credentials', with: { env: ['SECOND_API_TOKEN'] } },
      ],
    };
    assert.ok(config.matrix.groups === undefined);
    config.matrix.treatments = ['authenticated'];
    await fs.writeFile(fixture.experimentPath, JSON.stringify(config));
    const runtime = createFakeRuntimeAdapter();
    const caseSecret = 'case-api-secret';
    const treatmentSecret = 'treatment-api-secret';
    const scripted = createScriptedAgentAdapter({
      id: 'claude-code',
      turns: [
        {
          text: `Used ${caseSecret} and ${treatmentSecret}.`,
          sessionId: 'credential-session',
          toolCalls: [],
        },
      ],
    });
    const agent: AgentAdapter = {
      ...scripted.adapter,
      async openSession(context) {
        await context.runtime.commands.agent.run(['probe-agent']);
        return scripted.adapter.openSession(context);
      },
    };
    let completed: CompletedRunV1 | undefined;
    let output = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        'env:API_TOKEN=EVAL_API_TOKEN',
        '--credential-env',
        'env:SECOND_API_TOKEN=SECOND_API_TOKEN',
      ],
      {
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          output += text;
        },
        environment: {
          API_TOKEN: 'default-must-not-be-selected',
          EVAL_API_TOKEN: caseSecret,
          SECOND_API_TOKEN: treatmentSecret,
          UNDECLARED_TOKEN: 'must-not-be-forwarded',
        },
        execute: async (input) => {
          completed = await defaultForgeEngine.executeEval({
            ...input,
            composition: {
              ...input.composition,
              runtime: runtime.adapter,
              agents: new Map([[agent.id, agent]]),
            },
          });
          return completed;
        },
      },
    );

    assert.equal(exitCode, 0, output);
    assert.equal(runtime.runs.length, 1);
    assert.deepEqual(runtime.runs[0]!.input.environment, {
      variables: {},
      credentials: {
        API_TOKEN: { value: caseSecret, scopes: ['agent'] },
        SECOND_API_TOKEN: { value: treatmentSecret, scopes: ['agent'] },
      },
    });
    assert.deepEqual(
      runtime.runs[0]!.commands.map(({ argv, credentialEnvironmentNames }) => ({
        argv,
        credentialEnvironmentNames,
      })),
      [
        { argv: ['probe-setup'], credentialEnvironmentNames: [] },
        {
          argv: ['probe-agent'],
          credentialEnvironmentNames: ['API_TOKEN', 'SECOND_API_TOKEN'],
        },
      ],
    );
    assert.ok(completed);
    assert.equal(completed.result.evidence.redaction_count, 2);
    const location = completed.location;
    const artifacts = await Promise.all(
      completed.result.artifacts.map((artifact) =>
        fs.readFile(path.join(location, artifact.path), 'utf8'),
      ),
    );
    assert.ok(artifacts.some((body) => body.includes('[REDACTED]')));
    for (const body of [
      ...artifacts,
      output,
      JSON.stringify(completed.result),
    ]) {
      assert.ok(!body.includes(caseSecret));
      assert.ok(!body.includes(treatmentSecret));
      assert.ok(!body.includes('EVAL_API_TOKEN'));
    }
  });

  for (const explicitBinding of [false, true]) {
    it(`rejects a ${explicitBinding ? 'missing mapped value' : 'missing explicit binding'} before allocating a runtime`, async () => {
      const fixture = await createBenchmarkFixture({
        caseSetup: [
          { uses: 'forge/credentials', with: { env: ['API_TOKEN'] } },
        ],
      });
      const runtime = createFakeRuntimeAdapter();
      const agent = createScriptedAgentAdapter({ id: 'claude-code' });
      let failure: unknown;
      let stderr = '';

      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          ...(explicitBinding
            ? ['--credential-env', 'env:API_TOKEN=EVAL_API_TOKEN']
            : []),
        ],
        {
          stdout: () => undefined,
          stderr: (text) => {
            stderr += text;
          },
          environment: { API_TOKEN: 'same-name-does-not-grant-access' },
          execute: async (input) => {
            try {
              return await defaultForgeEngine.executeEval({
                ...input,
                composition: {
                  ...input.composition,
                  runtime: runtime.adapter,
                  agents: new Map([[agent.adapter.id, agent.adapter]]),
                },
              });
            } catch (error) {
              failure = error;
              throw error;
            }
          },
        },
      );

      assert.equal(exitCode, 1);
      assert.ok(failure instanceof ForgeExecutionError);
      assert.equal(failure.code, 'credential_failed');
      assert.ok(failure.cause instanceof Error);
      assert.match(
        failure.cause.message,
        explicitBinding
          ? /Set EVAL_API_TOKEN: no value is available/
          : /No environment binding exists.*env:API_TOKEN/,
      );
      assert.equal(runtime.runs.length, 0);
      assert.ok(
        stderr.includes(
          explicitBinding ? 'Set EVAL_API_TOKEN' : '--credential-env API_TOKEN',
        ),
      );
      assert.ok(!stderr.includes('same-name-does-not-grant-access'));
    });
  }

  it('rejects malformed credential mappings without echoing their value', async () => {
    const fixture = await createBenchmarkFixture();
    const accidentalSecret = 'sk-live-accidental-secret';
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        `stripe.token=${accidentalSecret}`,
      ],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.ok(stderr.includes('--credential-env must be'));
    assert.ok(!stderr.includes(accidentalSecret));
  });

  it('rejects conflicting credential mappings without reading values or echoing host variable names', async () => {
    const fixture = await createBenchmarkFixture({ withHostCompletions: true });
    for (const { reference, grants } of [
      {
        reference: 'stripe.token',
        grants: [
          'stripe.token=FIRST_SECRET_NAME',
          'stripe.token=SECOND_SECRET_NAME',
        ],
      },
      {
        reference: 'anthropic.api-key',
        grants: ['ANTHROPIC_API_KEY', 'anthropic.api-key=SECOND_SECRET_NAME'],
      },
      {
        reference: 'openai.completion-api-key',
        grants: [
          'OPENAI_API_KEY',
          'openai.completion-api-key=SECOND_SECRET_NAME',
        ],
      },
    ]) {
      let stderr = '';
      let secretReads = 0;
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          fixture.experimentPath,
          ...grants.flatMap((grant) => ['--credential-env', grant]),
        ],
        {
          environment: {
            get OPENAI_API_KEY() {
              secretReads += 1;
              return 'unread-secret';
            },
            get SECOND_SECRET_NAME() {
              secretReads += 1;
              return 'unread-secret';
            },
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );

      assert.equal(exitCode, 2);
      assert.equal(secretReads, 0);
      assert.ok(stderr.includes(reference));
      assert.ok(!stderr.includes('FIRST_SECRET_NAME'));
      assert.ok(!stderr.includes('SECOND_SECRET_NAME'));
    }
  });

  it('returns a usage exit code when a selection is ambiguous', async () => {
    const fixture = await createBenchmarkFixture({ repetitions: 2 });
    let stderr = '';
    const exitCode = await runCli(
      ['plan', '--experiment', fixture.experimentPath],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.ok(stderr.includes('Selection matches 2 matrix entries'));
  });

  it('keeps ambiguity checks after resolving a case file', async () => {
    const fixture = await createBenchmarkFixture({ repetitions: 2 });
    let stderr = '';
    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.caseFilePath,
      ],
      {
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.ok(stderr.includes('Selection matches 2 matrix entries'));
  });
});

async function createGroupedBenchmarkFixture() {
  const fixture = await createBenchmarkFixture({ includeUnselectedCase: true });
  const config = parseExperimentConfigYaml(
    await fs.readFile(fixture.experimentPath, 'utf8'),
  );
  await fs.writeFile(
    fixture.experimentPath,
    JSON.stringify({
      ...config,
      treatments: { ...config.treatments, enhanced: { setup: [] } },
      matrix: {
        groups: [
          {
            cases: ['cases/example.case.yaml'],
            treatments: ['baseline'],
            agents: [
              {
                adapter: 'claude-code',
                provider: 'anthropic',
                model: 'claude-sonnet',
              },
            ],
          },
          {
            cases: ['cases/unselected.case.yaml'],
            treatments: ['baseline', 'enhanced'],
            agents: [
              {
                adapter: 'claude-code',
                provider: 'anthropic',
                model: 'claude-opus-4-6',
              },
            ],
          },
        ],
        repetitions: 1,
        retries: 0,
      },
    }),
  );
  return fixture;
}

async function createBenchmarkFixture(
  options: {
    agent?: 'claude-code' | 'codex';
    repetitions?: number;
    includeUnselectedCase?: boolean;
    caseSetup?: readonly SetupStepV1[];
    withHostCompletions?: boolean;
    models?: ExperimentConfigV1['models'];
  } = {},
): Promise<{
  root: string;
  datasetRoot: string;
  experimentPath: string;
  caseFilePath: string;
  unselectedCaseFilePath?: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cli-test-'));
  temporaryDirectories.push(root);
  const datasetRoot = path.join(root, 'dataset');
  const casesRoot = path.join(datasetRoot, 'cases');
  const experimentsRoot = path.join(root, 'experiments');
  await Promise.all([
    fs.mkdir(casesRoot, { recursive: true }),
    fs.mkdir(experimentsRoot, { recursive: true }),
  ]);

  const caseBody = `id: case/example
version: 0.1.0
task: Do the thing
execution_mode: ${options.withHostCompletions ? 'multi_turn' : 'one_shot'}
setup: ${JSON.stringify(options.caseSetup ?? [])}
judging_criteria: ${JSON.stringify(options.withHostCompletions ? ['Completes the requested task.'] : [])}
`;
  const casePath = 'cases/example.case.yaml';
  const caseFilePath = path.join(datasetRoot, casePath);
  await fs.writeFile(caseFilePath, caseBody);
  const unselectedCasePath = 'cases/unselected.case.yaml';
  const unselectedCaseFilePath = path.join(datasetRoot, unselectedCasePath);
  const unselectedCaseBody = `id: case/unselected
version: 0.1.0
task: Do another thing
execution_mode: one_shot
setup: []
judging_criteria: []
`;
  if (options.includeUnselectedCase) {
    await fs.writeFile(unselectedCaseFilePath, unselectedCaseBody);
  }
  const cases = [
    {
      id: 'case/example',
      version: '0.1.0',
      path: casePath,
    },
    ...(options.includeUnselectedCase
      ? [
          {
            id: 'case/unselected',
            version: '0.1.0',
            path: unselectedCasePath,
          },
        ]
      : []),
  ];
  const manifestRaw = `${JSON.stringify(
    {
      dataset: { id: 'example-dataset', version: '2026.09.0' },
      cases,
    },
    null,
    2,
  )}\n`;
  await fs.writeFile(path.join(datasetRoot, 'manifest.json'), manifestRaw);

  const experimentPath = path.join(experimentsRoot, 'default.yaml');
  await fs.writeFile(
    experimentPath,
    `id: experiment/default
version: 2026.09.0
dataset:
  path: ../dataset
  id: example-dataset
  version: 2026.09.0
runtime:
  adapter: docker
  image: {kind: forge}
  platform: linux/amd64
  resources:
    memory_bytes: 4294967296
    cpu_count: 2
    process_count: 512
models: ${JSON.stringify(options.models ?? {})}
treatments:
  baseline:
    setup: []
matrix:
  cases: [cases/example.case.yaml]
  treatments: [baseline]
  agents:
    - adapter: ${options.agent ?? 'claude-code'}
      provider: ${options.agent === 'codex' ? 'openai' : 'anthropic'}
      model: ${options.agent === 'codex' ? 'gpt-5.4' : 'claude-sonnet'}
  repetitions: ${options.repetitions ?? 1}
  retries: 0
limits:
  run_timeout_ms: 1800000
`,
  );
  return {
    root,
    datasetRoot,
    experimentPath,
    caseFilePath,
    ...(options.includeUnselectedCase ? { unselectedCaseFilePath } : {}),
  };
}
