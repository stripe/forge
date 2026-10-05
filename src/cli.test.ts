import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {createDefaultCliComposition, runCli as invokeCli, type RunCliOptions} from './cli.js';
import {credentialReference} from './contracts/credentials.js';
import {createForgeEngine, defaultForgeEngine} from './engine.js';
import type {ExecuteEvalInput} from './execution/execute.js';
import {createArtifactStore} from './results/index.js';
import {FORGE_VERSION} from './execution/index.js';
import {parseExperimentConfigYaml, sha256Digest, sha256Hex} from './model/index.js';
import {defineSetupActionBundle} from './setup/index.js';
import {serializeResolvedRunPlan} from './planning/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from './testing/index.js';

const temporaryDirectories: string[] = [];

function runCli(argv: readonly string[], options: RunCliOptions = {}) {
  const experiment = argv[argv.indexOf('--experiment') + 1];
  const cwd = argv[0] === 'run' && experiment && path.isAbsolute(experiment)
    ? path.dirname(experiment)
    : process.cwd();
  return invokeCli(argv, {cwd, stderr: () => undefined, ...options});
}

async function executeOffline(input: ExecuteEvalInput) {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter({id: input.plan.selection.agent.adapter});
  return defaultForgeEngine.executeEval({
    ...input,
    composition: {...input.composition, runtime: runtime.adapter, agents: new Map([[agent.adapter.id, agent.adapter]])},
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {recursive: true, force: true}),
    ),
  );
});

describe('Forge CLI', () => {
  it('reports the installed package version', async () => {
    let stdout = '';
    const exitCode = await runCli(['--version'], {
      stdout: (text) => { stdout += text; },
      stderr: () => undefined,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout, `${FORGE_VERSION}\n`);
  });

  it('checks default-composition input bytes against the manifest loaded for the run', async () => {
    const fixture = await createBenchmarkFixture();
    const exitCode = await runCli([
      'run', '--experiment', fixture.experimentPath,
    ], {
      environment: {},
      stdout: () => undefined,
      execute: async (input) => {
        const {composition} = input;
        const original = await fs.readFile(fixture.caseFilePath, 'utf8');
        await fs.writeFile(fixture.caseFilePath, original.replace('Do the thing', 'Do bad thing'));
        await assert.rejects(composition.inputProvider.read('cases/example.yaml'), /SHA-256/);
        await fs.writeFile(path.join(fixture.datasetRoot, 'cases/extra.yaml'), 'extra');
        await assert.rejects(composition.inputProvider.listFiles('cases'), /manifest inventory/);
        await fs.writeFile(fixture.caseFilePath, original);
        await fs.rm(path.join(fixture.datasetRoot, 'cases/extra.yaml'));
        return executeOffline(input);
      },
    });
    assert.equal(exitCode, 0);
  });

  it('supplies the selected external runtime to the host factory for validation and execution', async () => {
    const fixture = await createBenchmarkFixture();
    const config = parseExperimentConfigYaml(await fs.readFile(fixture.experimentPath, 'utf8'));
    const descriptor = {
      adapter: 'acme/process',
      platform: 'linux/amd64' as const, config: {profile: 'test-worker'},
    };
    await fs.writeFile(fixture.experimentPath, JSON.stringify({...config, runtime: descriptor}));
    const runtime = createFakeRuntimeAdapter({id: descriptor.adapter});
    const agent = createScriptedAgentAdapter({id: 'claude-code'});
    let factoryCalls = 0;
    for (const command of ['validate', 'run']) {
      let stderr = '';
      const exitCode = await runCli([
        command, '--experiment', fixture.experimentPath,
      ], {
        compositionFactory: async (options) => {
          factoryCalls += 1;
          assert.deepEqual(options.runtime, descriptor);
          assert.equal(options.datasetManifest?.dataset.id, 'example-dataset');
          return {
            runtime: runtime.adapter,
            agents: new Map([[agent.adapter.id, agent.adapter]]),
            credentialResolver: createStaticCredentialResolver(),
            inputProvider: createMemoryRunInputProvider(),
            artifactStore: createArtifactStore({root: options.resultsRoot}),
          };
        },
        stdout: () => undefined,
        stderr: (text) => {stderr += text;},
      });
      assert.ok(!(stderr).includes('forge:'));
      assert.equal(exitCode, 0);
    }
    assert.equal(factoryCalls, 2);
    assert.equal(runtime.runs.length, 1);
    let stderr = '';
    const exitCode = await runCli([
      'validate', '--experiment', fixture.experimentPath,
    ], {stdout: () => undefined, stderr: (text) => {stderr += text;}});
    assert.notEqual(exitCode, 0);
    assert.ok((stderr).includes('host-supplied compositionFactory'));
  });

  it('validates a dataset/experiment pair and emits its resolved run count', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'validate',
        '--experiment',
        'experiments/default.yaml',
      ],
      {
        cwd: fixture.root,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!(stderr).includes('forge:'));
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
      [
        'validate',
        '--experiment',
        fixture.experimentPath,
      ],
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
    assert.ok(!(stderr).includes('forge:'));
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
      [
        'validate',
        '--experiment',
        fixture.experimentPath,
        '--host',
      ],
      {
        detectDockerPlatform: async () => 'linux/arm64',
        validateDockerHost: async ({platform}) => {
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
    assert.ok(!(stderr).includes('forge:'));
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
      [
        'validate',
        '--experiment',
        fixture.experimentPath,
        '--host',
      ],
      {
        detectDockerPlatform: async () => 'linux/arm64',
        validateDockerHost: async ({platform}) => {
          hostValidationCalled = true;
          return {platform, imageId: `sha256:${'a'.repeat(64)}`};
        },
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.ok((stderr).includes('agent adapter'));
    assert.equal(hostValidationCalled, false);
  });

  it('purely validates a latest Claude plugin treatment without fetching it', async () => {
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
          agents:
            claude-code:
              plugin: stripe@claude-plugins-official
              marketplace: anthropics/claude-plugins-official`,
        )
        .replace('treatments: [baseline]', 'treatments: [stripe-plugin]'),
    );
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'validate',
        '--experiment',
        fixture.experimentPath,
      ],
      {
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!(stderr).includes('forge:'));
    {
      const actual = JSON.parse(stdout);
      assert.ok(actual);
      assert.equal(actual.valid, true);
      assert.equal(actual.run_count, 1);
    }
  });

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
      {stdout: (text) => { stdout += text; }},
    );

    assert.equal(exitCode, 0);
    assert.equal(stdout, serializeResolvedRunPlan(defaultForgeEngine.parseResolvedRunPlan(JSON.parse(stdout))));
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
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
      ],
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
    assert.ok(!(stderr).includes('forge:'));
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
                  typeof (input as {name?: unknown}).name !== 'string'
                ) {
                  throw new TypeError('invalid tool');
                }
                return {name: (input as {name: string}).name};
              },
              preflight() {
                return {requirements: {}, async apply() {}};
              },
            },
          ],
        }),
      ],
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
      ],
      {
        engine,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!(stderr).includes('forge:'));
    {
      const actual = JSON.parse(stdout);
      assert.ok(actual);
      assert.deepEqual(actual.setup.map((item: {uses: string; with: {name: string}}) => ({uses: item.uses, with: {name: item.with.name}})), [{uses: 'acme-evals/tool', with: {name: 'formatter'}}]);
      assert.deepEqual(actual.provenance.forge.action_bundles.map((item: {namespace: string; version: string}) => ({namespace: item.namespace, version: item.version})), [
        {namespace: 'acme-evals', version: '1.0.0'},
      ]);
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
                  typeof (input as {name?: unknown}).name !== 'string'
                ) {
                  throw new TypeError('invalid tool');
                }
                return {name: (input as {name: string}).name};
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
    const runtime = createFakeRuntimeAdapter({id: 'forge/docker'});
    const agent = createScriptedAgentAdapter({id: 'claude-code'});
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
        compositionFactory: async ({resultsRoot}) => ({
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({root: resultsRoot}),
        }),
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!(stderr).includes('forge:'));
    assert.equal(applied, true);
    const completed = await engine.verifyCompletedRun(path.join(JSON.parse(stdout).location, 'runs', 'host-action-run'));
    {
      const actual = completed;
      assert.ok(actual);
      assert.equal(actual.runId, 'host-action-run');
      assert.deepEqual(actual.result.forge.action_bundles!.map((item) => ({namespace: item.namespace, version: item.version})), [
        {namespace: 'acme-evals', version: '1.0.0'},
      ]);
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
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(!(stderr).includes('forge:'));
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
        'dataset/cases/example.yaml',
      ],
      {
        cwd: fixture.root,
        stdout: (text) => { stdout += text; },
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
        stdout: (text) => { stdout += text; },
        execute: async (input) => {
          const {plan} = input;
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
    assert.equal(await runCli(['plan', '--experiment', fixture.experimentPath, '--case', 'case/example'], {
      stdout: (text) => {expectedPlan += text;},
    }), 0);
    const campaign = JSON.parse(stdout) as {location: string};
    const storedPlan = await fs.readFile(path.join(campaign.location, 'runs', 'case-file-run', 'plan.json'), 'utf8');
    assert.equal(storedPlan, expectedPlan);
    assert.ok(!(storedPlan).includes(fixture.caseFilePath));
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
      {stderr: (text) => { stderr += text; }},
    );

    assert.equal(exitCode, 2);
    assert.ok((stderr).includes('--case and --case-file cannot be combined'));
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
      {stderr: (text) => { stderr += text; }},
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
      {stderr: (text) => { stderr += text; }},
    );

    assert.equal(exitCode, 2);
    assert.match(stderr, /manifest.*case|case.*manifest/i);
  });

  it('rejects a manifest case that is not an experiment matrix member', async () => {
    const fixture = await createBenchmarkFixture({includeUnselectedCase: true});
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.unselectedCaseFilePath!,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    assert.equal(exitCode, 2);
    assert.ok((stderr).includes('Selection does not match the benchmark matrix'));
  });

  it('assembles the public Docker/Claude/Codex defaults with explicit credentials', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      environment: {ANTHROPIC_API_KEY: 'test-api-key'},
    });

    assert.equal(composition.runtime.id, 'forge/docker');
    assert.deepEqual([...composition.agents.keys()], ['claude-code', 'codex']);
    assert.equal(composition.agents.get('claude-code')?.version, FORGE_VERSION);
    assert.equal(composition.agents.get('codex')?.version, FORGE_VERSION);
    assert.deepEqual([...(composition.completionProviders as ReadonlyMap<string, unknown>).keys()], ['anthropic']);
    assert.equal((composition.completionProviders as ReadonlyMap<string, {version: string}>).get(
      'anthropic',
    )?.version, FORGE_VERSION);
    assert.equal((await composition.credentialResolver.resolve(
      credentialReference('anthropic.api-key'),
      {
        runId: 'run-1',
        purpose: 'agent',
        signal: new AbortController().signal,
      },
    )), 'test-api-key');
  });

  it('validates and plans the checked-in Codex example without credentials or Docker', async () => {
    for (const command of ['validate', 'plan']) {
      let stdout = '';
      let stderr = '';
      const code = await runCli([
        command, '--experiment', 'examples/codex/experiment.yaml',
      ], {
        environment: {},
        stdout: (value) => {stdout += value;},
        stderr: (value) => {stderr += value;},
      });
      assert.ok(!(stderr).includes('forge:'));
      assert.equal(code, 0);
      if (command === 'validate') assert.equal(JSON.parse(stdout).valid, true);
      else assert.deepEqual(JSON.parse(stdout).selection.agent, {
        adapter: 'codex', provider: 'openai', model: 'gpt-5.4', hook_trust: 'native',
      });
    }
  });

  it('binds Codex credentials independently from harness completion credentials', async () => {
    const fixture = await createBenchmarkFixture();
    for (const compatible of [false, true]) {
      const composition = await createDefaultCliComposition({
        datasetRoot: fixture.datasetRoot,
        resultsRoot: path.join(fixture.root, 'results'),
        environment: {
          CODEX_API_KEY: 'codex-test-key',
          OPENAI_API_KEY: 'must-not-be-inferred',
          ...(compatible ? {OPENAI_BASE_URL: 'https://gateway.example.test/v1'} : {}),
        },
      });
      const codex = composition.agents.get('codex')!;
      assert.equal(codex.version, FORGE_VERSION);
      {
        const actual = codex.requirements({adapter: 'codex', provider: 'openai', model: 'gpt-5.4'});
        assert.ok(actual);
        assert.equal(actual.environment.variables!.CODEX_HOME, '/home/forge/.codex');
        assert.equal(actual.environment.credentials!.CODEX_API_KEY!.reference, 'openai.api-key');
      }
      assert.equal((await composition.credentialResolver.resolve(credentialReference('openai.api-key'), {
        runId: 'codex-cli', purpose: 'agent', signal: new AbortController().signal,
      })), 'codex-test-key');
    }
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: {'openai.api-key': 'MY_CODEX_KEY'},
      environment: {MY_CODEX_KEY: 'explicit-key'},
    });
    assert.equal((await composition.credentialResolver.resolve(credentialReference('openai.api-key'), {
      runId: 'codex-cli', purpose: 'agent', signal: new AbortController().signal,
    })), 'explicit-key');
  });

  it('selects standard gateway authentication when ANTHROPIC_BASE_URL is set', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      environment: {
        ANTHROPIC_API_KEY: 'direct-key-must-not-be-selected',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic/',
      },
    });
    const claude = composition.agents.get('claude-code');
    assert.notEqual(claude, undefined);
    assert.equal(claude!.version, FORGE_VERSION);
    assert.equal((composition.completionProviders as ReadonlyMap<string, {version: string}>).get(
      'anthropic',
    )?.version, FORGE_VERSION);
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
    assert.ok(!('ANTHROPIC_API_KEY' in (requirements.environment.credentials)));
    assert.equal((await composition.credentialResolver.resolve(
      credentialReference('anthropic.auth-token'),
      {
        runId: 'run-1',
        purpose: 'agent',
        signal: new AbortController().signal,
      },
    )), 'gateway-token');
    await assert.rejects(composition.credentialResolver.resolve(
      credentialReference('anthropic.api-key'),
      {
        runId: 'run-1',
        purpose: 'agent',
        signal: new AbortController().signal,
      },
    ), /No environment binding exists/);
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
          const {runId, composition} = input;
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

  it('allows an explicit credential binding to override the CLI default', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      credentialBindings: {'anthropic.api-key': 'ALTERNATE_ANTHROPIC_KEY'},
      environment: {
        ANTHROPIC_API_KEY: 'default-key',
        ALTERNATE_ANTHROPIC_KEY: 'alternate-key',
      },
    });

    assert.equal((await composition.credentialResolver.resolve(
      credentialReference('anthropic.api-key'),
      {
        runId: 'run-override',
        purpose: 'test',
        signal: new AbortController().signal,
      },
    )), 'alternate-key');
  });

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
      {stderr: (text) => {stderr += text;}},
    );

    assert.equal(exitCode, 2);
    assert.ok((stderr).includes('--credential-env must be'));
    assert.ok(!(stderr).includes(accidentalSecret));
  });

  it('rejects conflicting credential mappings without echoing host variable names', async () => {
    const fixture = await createBenchmarkFixture();
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--credential-env',
        'stripe.token=FIRST_SECRET_NAME',
        '--credential-env',
        'stripe.token=SECOND_SECRET_NAME',
      ],
      {stderr: (text) => { stderr += text; }},
    );

    assert.equal(exitCode, 2);
    assert.ok((stderr).includes('stripe.token'));
    assert.ok(!(stderr).includes('FIRST_SECRET_NAME'));
    assert.ok(!(stderr).includes('SECOND_SECRET_NAME'));
  });

  it('returns a usage exit code when a selection is ambiguous', async () => {
    const fixture = await createBenchmarkFixture({repetitions: 2});
    let stderr = '';
    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    assert.equal(exitCode, 2);
    assert.ok((stderr).includes('Selection matches 2 matrix entries'));
  });

  it('keeps ambiguity checks after resolving a case file', async () => {
    const fixture = await createBenchmarkFixture({repetitions: 2});
    let stderr = '';
    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--case-file',
        fixture.caseFilePath,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    assert.equal(exitCode, 2);
    assert.ok((stderr).includes('Selection matches 2 matrix entries'));
  });
});

async function createBenchmarkFixture(
  options: {repetitions?: number; includeUnselectedCase?: boolean} = {},
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
    fs.mkdir(casesRoot, {recursive: true}),
    fs.mkdir(experimentsRoot, {recursive: true}),
  ]);

  const caseBody = `id: case/example
task: Do the thing
execution_mode: one_shot
setup: []
success_guidelines: []
`;
  const casePath = 'cases/example.yaml';
  const caseFilePath = path.join(datasetRoot, casePath);
  await fs.writeFile(caseFilePath, caseBody);
  const unselectedCasePath = 'cases/unselected.yaml';
  const unselectedCaseFilePath = path.join(datasetRoot, unselectedCasePath);
  const unselectedCaseBody = `id: case/unselected
task: Do another thing
execution_mode: one_shot
setup: []
success_guidelines: []
`;
  if (options.includeUnselectedCase) {
    await fs.writeFile(unselectedCaseFilePath, unselectedCaseBody);
  }
  const cases = [
    {id: 'case/example', path: casePath},
    ...(options.includeUnselectedCase
      ? [{id: 'case/unselected', path: unselectedCasePath}]
      : []),
  ];
  const files = [
    {
      path: casePath,
      size: Buffer.byteLength(caseBody),
      sha256: sha256Hex(caseBody),
    },
    ...(options.includeUnselectedCase
      ? [
          {
            path: unselectedCasePath,
            size: Buffer.byteLength(unselectedCaseBody),
            sha256: sha256Hex(unselectedCaseBody),
          },
        ]
      : []),
  ];
  const manifestRaw = `${JSON.stringify({
    dataset: {id: 'example-dataset', version: '2026.09.0'},
    cases,
    files,
  }, null, 2)}\n`;
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
  manifest_sha256: ${sha256Digest(manifestRaw)}
runtime:
  adapter: docker
  image: {kind: forge}
  platform: linux/amd64
  resources:
    memory_bytes: 4294967296
    cpu_count: 2
    process_count: 512
models: {}
treatments:
  baseline:
    setup: []
matrix:
  cases: [case/example]
  treatments: [baseline]
  agents:
    - adapter: claude-code
      provider: anthropic
      model: claude-sonnet
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
    ...(options.includeUnselectedCase ? {unselectedCaseFilePath} : {}),
  };
}
