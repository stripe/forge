import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';

import {createDefaultCliComposition, runCli} from './cli.js';
import {credentialReference} from './contracts/credentials.js';
import {createForgeEngine} from './engine.js';
import {parseExperimentConfigYaml, sha256Digest, sha256Hex} from './model/index.js';
import {defineSetupActionBundle} from './setup/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from './testing/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {recursive: true, force: true}),
    ),
  );
});

describe('Forge CLI', () => {
  it('supplies the selected external runtime to the host factory for validation and execution', async () => {
    const fixture = await createBenchmarkFixture();
    const config = parseExperimentConfigYaml(await fs.readFile(fixture.experimentPath, 'utf8'));
    const descriptor = {
      adapter: 'acme/process', adapter_version: '1', config_version: 1,
      platform: 'linux/amd64' as const, config: {profile: 'test-worker'},
    };
    await fs.writeFile(fixture.experimentPath, JSON.stringify({...config, runtime: descriptor}));
    const runtime = createFakeRuntimeAdapter({id: descriptor.adapter});
    const agent = createScriptedAgentAdapter({id: 'claude-code'});
    let factoryCalls = 0;
    for (const command of ['validate', 'run']) {
      let stderr = '';
      const exitCode = await runCli([
        command, '--experiment', fixture.experimentPath, '--dataset', fixture.datasetRoot,
      ], {
        compositionFactory: async (options) => {
          factoryCalls += 1;
          expect(options.runtime).toEqual(descriptor);
          return {
            runtime: runtime.adapter,
            agents: new Map([[agent.adapter.id, agent.adapter]]),
            credentialResolver: createStaticCredentialResolver(),
            inputProvider: createMemoryRunInputProvider(),
            artifactStore: createMemoryArtifactStore().store,
          };
        },
        stdout: () => undefined,
        stderr: (text) => {stderr += text;},
      });
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
    }
    expect(factoryCalls).toBe(2);
    expect(runtime.runs.length).toBe(1);
    let stderr = '';
    const exitCode = await runCli([
      'validate', '--experiment', fixture.experimentPath, '--dataset', fixture.datasetRoot,
    ], {stdout: () => undefined, stderr: (text) => {stderr += text;}});
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('host-supplied compositionFactory');
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
        '--dataset',
        'dataset',
      ],
      {
        cwd: fixture.root,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      dataset: {id: 'example-dataset', version: '2026.09.0'},
      experiment: {id: 'experiment/default', version: '2026.09.0'},
      run_count: 1,
      valid: true,
    });
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
      - uses: forge/plugin@1
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
        '--dataset',
        fixture.datasetRoot,
      ],
      {
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({valid: true, run_count: 1});
  });

  it('prints the canonical resolved plan for one matrix selection', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
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

    expect(exitCode).toBe(0);
    expect(stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      schema_version: 1,
      selection: {
        case_id: 'case/example',
        treatment: 'baseline',
        agent: {
          adapter: 'claude-code',
          provider: 'anthropic',
          model: 'claude-sonnet',
        },
        repetition: 0,
      },
      interaction: {mode: 'one_shot', effective_prompt: 'Do the thing'},
    });
  });

  it('uses an explicitly supplied engine for host action bundles', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment
        .replace(
          'forge:\n  version: 0.1.0',
          `forge:\n  version: 0.1.0\n  action_bundles:\n    - namespace: acme-evals\n      version: 1.0.0\n      sha256: sha256:${'a'.repeat(64)}`,
        )
        .replace(
          'treatments:\n  baseline:\n    setup: []',
          'treatments:\n  baseline:\n    setup: []\n  with-tool:\n    setup:\n      - uses: acme-evals/tool@1\n        with: {name: formatter}',
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
              uses: 'acme-evals/tool@1',
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
        '--dataset',
        fixture.datasetRoot,
      ],
      {
        engine,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      setup: [{uses: 'acme-evals/tool@1', with: {name: 'formatter'}}],
      provenance: {
        forge: {
          action_bundles: [
            {namespace: 'acme-evals', version: '1.0.0'},
          ],
        },
      },
    });
  });

  it('runs a host action bundle through an explicitly supplied engine', async () => {
    const fixture = await createBenchmarkFixture();
    const experiment = await fs.readFile(fixture.experimentPath, 'utf8');
    await fs.writeFile(
      fixture.experimentPath,
      experiment
        .replace(
          'forge:\n  version: 0.1.0',
          `forge:\n  version: 0.1.0\n  action_bundles:\n    - namespace: acme-evals\n      version: 1.0.0\n      sha256: sha256:${'a'.repeat(64)}`,
        )
        .replace(
          'treatments:\n  baseline:\n    setup: []',
          'treatments:\n  baseline:\n    setup: []\n  with-tool:\n    setup:\n      - uses: acme-evals/tool@1\n        with: {name: formatter}',
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
              uses: 'acme-evals/tool@1',
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
    const artifacts = createMemoryArtifactStore();
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
        '--run-id',
        'host-action-run',
      ],
      {
        engine,
        compositionFactory: async () => ({
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: artifacts.store,
        }),
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(applied).toBe(true);
    expect(artifacts.runs.has('host-action-run')).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      run_id: 'host-action-run',
      result: {
        forge: {
          action_bundles: [
            {namespace: 'acme-evals', version: '1.0.0'},
          ],
        },
      },
    });
  });

  it('selects a manifest case by file with an explicit dataset root', async () => {
    const fixture = await createBenchmarkFixture();
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
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

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout).selection).toMatchObject({
      case_id: 'case/example',
      agent: {adapter: 'claude-code', model: 'claude-sonnet'},
    });
  });

  it('discovers the nearest dataset manifest above a case file', async () => {
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

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).selection.case_id).toBe('case/example');
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
        execute: async ({runId, plan}) => {
          selectedCaseId = plan.selection.case_id;
          return {
            runId,
            location: '/results/case-file-run',
            result: {status: 'passed'} as never,
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(selectedCaseId).toBe('case/example');
    expect(JSON.parse(stdout)).toMatchObject({
      location: '/results/case-file-run',
      run_id: 'case-file-run',
    });
  });

  it('rejects combining case ID and case file selectors', async () => {
    const fixture = await createBenchmarkFixture();
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
        '--case',
        'case/example',
        '--case-file',
        fixture.caseFilePath,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain('--case and --case-file cannot be combined');
  });

  it('rejects a case-file traversal that resolves outside the dataset', async () => {
    const fixture = await createBenchmarkFixture();
    const outside = path.join(fixture.root, 'outside.yaml');
    await fs.writeFile(outside, 'schema_version: 1\n');
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
        '--case-file',
        path.join(fixture.datasetRoot, 'cases', '..', '..', 'outside.yaml'),
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/outside.*dataset/i);
  });

  it('rejects a file that is not a case entry in the manifest', async () => {
    const fixture = await createBenchmarkFixture();
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
        '--case-file',
        path.join(fixture.datasetRoot, 'manifest.json'),
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/manifest.*case|case.*manifest/i);
  });

  it('rejects a manifest case that is not an experiment matrix member', async () => {
    const fixture = await createBenchmarkFixture({includeUnselectedCase: true});
    let stderr = '';

    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
        '--case-file',
        fixture.unselectedCaseFilePath!,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Selection does not match the benchmark matrix');
  });

  it('assembles the public Docker/Claude defaults with explicit credentials', async () => {
    const fixture = await createBenchmarkFixture();
    const composition = await createDefaultCliComposition({
      datasetRoot: fixture.datasetRoot,
      resultsRoot: path.join(fixture.root, 'results'),
      environment: {ANTHROPIC_API_KEY: 'test-api-key'},
    });

    expect(composition.runtime.id).toBe('forge/docker');
    expect([...composition.agents.keys()]).toEqual(['claude-code']);
    expect(composition.agents.get('claude-code')?.version).toBe('2');
    expect([...(composition.completionProviders as ReadonlyMap<string, unknown>).keys()])
      .toEqual(['anthropic']);
    expect(
      (composition.completionProviders as ReadonlyMap<string, {version: string}>).get(
        'anthropic',
      )?.version,
    ).toBe('1');
    await expect(
      composition.credentialResolver.resolve(
        credentialReference('anthropic.api-key'),
        {
          runId: 'run-1',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe('test-api-key');
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
    expect(claude).toBeDefined();
    expect(claude!.version).toBe('2+gateway');
    expect(
      (composition.completionProviders as ReadonlyMap<string, {version: string}>).get(
        'anthropic',
      )?.version,
    ).toBe('1+messages-compatible');
    const requirements = claude!.requirements({
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet',
    });

    expect(requirements.environment.variables).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic/',
    });
    expect(requirements.environment.credentials).toEqual({
      ANTHROPIC_AUTH_TOKEN: {
        reference: 'anthropic.auth-token',
      },
    });
    expect(requirements.environment.credentials).not.toHaveProperty(
      'ANTHROPIC_API_KEY',
    );
    await expect(
      composition.credentialResolver.resolve(
        credentialReference('anthropic.auth-token'),
        {
          runId: 'run-1',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe('gateway-token');
    await expect(
      composition.credentialResolver.resolve(
        credentialReference('anthropic.api-key'),
        {
          runId: 'run-1',
          purpose: 'agent',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('No environment binding exists');
  });

  it('binds explicit credential references to host environment variables for run', async () => {
    const fixture = await createBenchmarkFixture();
    let resolved: string | undefined;

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
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
        execute: async ({runId, composition}) => {
          resolved = await composition.credentialResolver.resolve(
            credentialReference('stripe.mcp-token'),
            {
              runId,
              purpose: 'test',
              signal: new AbortController().signal,
            },
          );
          return {
            runId,
            location: '/results/credential-run',
            result: {status: 'passed'} as never,
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(resolved).toBe('mcp-secret');
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

    await expect(
      composition.credentialResolver.resolve(
        credentialReference('anthropic.api-key'),
        {
          runId: 'run-override',
          purpose: 'test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe('alternate-key');
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
        '--dataset',
        fixture.datasetRoot,
        '--credential-env',
        `stripe.token=${accidentalSecret}`,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain('--credential-env must be');
    expect(stderr).not.toContain(accidentalSecret);
  });

  it('rejects conflicting credential mappings without echoing host variable names', async () => {
    const fixture = await createBenchmarkFixture();
    let stderr = '';

    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
        '--credential-env',
        'stripe.token=FIRST_SECRET_NAME',
        '--credential-env',
        'stripe.token=SECOND_SECRET_NAME',
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain('stripe.token');
    expect(stderr).not.toContain('FIRST_SECRET_NAME');
    expect(stderr).not.toContain('SECOND_SECRET_NAME');
  });

  it('returns a usage exit code when a selection is ambiguous', async () => {
    const fixture = await createBenchmarkFixture({repetitions: 2});
    let stderr = '';
    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        fixture.experimentPath,
        '--dataset',
        fixture.datasetRoot,
      ],
      {stderr: (text) => { stderr += text; }},
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Selection matches 2 matrix entries');
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

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Selection matches 2 matrix entries');
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

  const caseBody = `schema_version: 1
id: case/example
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
  const unselectedCaseBody = `schema_version: 1
id: case/unselected
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
    schema_version: 1,
    dataset: {id: 'example-dataset', version: '2026.09.0'},
    cases,
    files,
  }, null, 2)}\n`;
  await fs.writeFile(path.join(datasetRoot, 'manifest.json'), manifestRaw);

  const experimentPath = path.join(experimentsRoot, 'default.yaml');
  await fs.writeFile(
    experimentPath,
    `schema_version: 1
id: experiment/default
version: 2026.09.0
dataset:
  id: example-dataset
  version: 2026.09.0
  manifest_sha256: ${sha256Digest(manifestRaw)}
forge:
  version: 0.1.0
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
