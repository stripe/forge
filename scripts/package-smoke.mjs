import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const { packageManager, version: packageVersion } = packageMetadata;
if (typeof packageManager !== 'string' || packageManager.length === 0) {
  throw new Error('package.json must declare a packageManager.');
}
if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
  throw new Error('package.json must declare a version.');
}
const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'stripe-forge-package-smoke-'),
);

try {
  const packRoot = path.join(temporaryRoot, 'pack');
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  await fs.mkdir(packRoot);
  await fs.mkdir(consumerRoot);

  run('pnpm', ['pack', '--pack-destination', packRoot], projectRoot);
  const packagedBuildIdentity = JSON.parse(
    await fs.readFile(
      path.join(projectRoot, 'dist', 'build-info.json'),
      'utf8',
    ),
  );
  const archives = (await fs.readdir(packRoot)).filter((entry) =>
    entry.endsWith('.tgz'),
  );
  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive, found ${archives.length}.`);
  }
  const archive = path.join(packRoot, archives[0]);

  await fs.writeFile(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'forge-package-smoke',
        private: true,
        type: 'module',
        packageManager,
      },
      null,
      2,
    )}\n`,
  );
  run('pnpm', ['add', '--offline', '--ignore-scripts', archive], consumerRoot);

  await fs.writeFile(
    path.join(consumerRoot, 'esm.mjs'),
    `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import * as path from 'node:path';
      import * as forge from '@stripe/forge';
      import * as atif from '@stripe/forge/atif/v1.8';
      import * as cli from '@stripe/forge/cli';
      import * as experiment from '@stripe/forge/experiment';
      import * as experimentCli from '@stripe/forge/experiment/cli';
      import * as regrade from '@stripe/forge/regrade';
      import * as claude from '@stripe/forge/agents/claude-code';
      import * as codex from '@stripe/forge/agents/codex';
      import * as opencode from '@stripe/forge/agents/opencode';
      import * as anthropic from '@stripe/forge/providers/anthropic';
      import * as openai from '@stripe/forge/providers/openai';
      import * as docker from '@stripe/forge/runtime/docker';
      import * as setup from '@stripe/forge/setup';
      import * as testing from '@stripe/forge/testing';
      import packageMetadata from '@stripe/forge/package.json' with {type: 'json'};

      assert.equal(typeof forge.executeEval, 'function');
      assert.equal(forge.FORGE_VERSION, packageMetadata.version);
      assert.deepEqual(forge.FORGE_BUILD_IDENTITY, ${JSON.stringify(packagedBuildIdentity)});
      assert.equal(Object.isFrozen(forge.FORGE_BUILD_IDENTITY), true);
      assert.equal(typeof forge.createForgeEngine, 'function');
      assert.equal(typeof forge.preflightEval, 'function');
      assert.equal(typeof forge.parseInteractionArtifact, 'function');
      assert.equal(typeof forge.parseJudgeEvidence, 'function');
      assert.equal(typeof forge.parseResolvedRunPlan, 'function');
      assert.equal(typeof forge.judgeCriteria, 'function');
      assert.equal(typeof forge.criterionResultMatchesDefinition, 'function');
      assert.equal(typeof forge.buildCriterionJudgePrompt, 'function');
      assert.equal(typeof forge.parseCriterionJudgment, 'function');
      for (const removed of ['judgeGuidelines', 'buildGuidelineJudgePrompt', 'parseGuidelineJudgment']) {
        assert.equal(removed in forge, false);
      }
      const criterion = forge.parseCriterionJudgment(
        JSON.stringify({results: [{index: 0, passed: true, explanation: 'Done.'}]}),
        {value: 'The task is complete.'},
      );
      assert.equal(criterion.requirement_level, 'SHOULD');
      const evaluation = forge.parseEvaluationResult(forge.scoreEvaluation([criterion], []));
      assert.equal(evaluation.judging_criteria_passed, 1);
      assert.equal(evaluation.judging_criteria_total, 1);
      assert.deepEqual(evaluation.judging_criteria, [criterion]);
      const judgeError = forge.parseCriterionJudgment('{}', 'Unavailable criterion.');
      assert.equal(typeof judgeError.error.message, 'string');
      const incomplete = forge.parseEvaluationResult(forge.scoreEvaluation([judgeError], []));
      assert.equal(incomplete.status, 'judge_error');
      assert.equal(incomplete.score, null);
      assert.equal(incomplete.judging_criteria_errored, 1);
      assert.equal(typeof docker.detectDockerRuntimePlatform, 'function');
      assert.equal(typeof docker.validateDockerRuntimeHost, 'function');
      assert.equal(typeof forge.createJudgeTranscriptProjection, 'function');
      assert.equal(typeof forge.parseJudgeTranscriptProjection, 'function');
      assert.equal(atif.ATIF_SCHEMA_VERSION, 'ATIF-v1.8');
      assert.equal(atif.isAtifTimestamp('2024-02-29T00:00:00Z'), true);
      assert.equal(typeof atif.parseNormalizedTrajectory, 'function');
      const normalized = atif.createNormalizedTrajectory({
        trajectory: {
          schema_version: 'ATIF-v1.8',
          agent: {name: 'package-smoke', version: '1.0.0'},
          steps: [{step_id: 1, source: 'user', message: 'hello'}],
        },
        provenance: {
          source: {kind: 'atif', format: 'atif', schemaVersion: 'ATIF-v1.8'},
          adapter: {id: 'package-smoke', version: forge.FORGE_VERSION},
        },
        completeness: 'complete',
      });
      assert.equal(Object.hasOwn(normalized, 'schemaVersion'), false);
      assert.equal(normalized.trajectory.schema_version, 'ATIF-v1.8');
      assert.equal(normalized.provenance.source.schemaVersion, 'ATIF-v1.8');
      assert.deepEqual(atif.parseNormalizedTrajectory(normalized), normalized);
      assert.throws(
        () => atif.parseNormalizedTrajectory({...normalized, schemaVersion: atif.ATIF_SCHEMA_VERSION}),
        atif.NormalizedTrajectoryValidationError,
      );
      assert.equal(typeof cli.runCli, 'function');
      assert.equal(typeof cli.createDefaultCliComposition, 'function');
      assert.equal(typeof experiment.runExperiment, 'function');
      assert.equal(typeof experiment.readExperimentRunSelections, 'function');
      assert.equal(typeof experiment.inspectExperimentRun, 'function');
      assert.equal(typeof experiment.parseExperimentRunReport, 'function');
      assert.equal(typeof experiment.ExperimentRunReportError, 'function');
      assert.equal(typeof experimentCli.runExperimentCommand, 'function');
      assert.equal(typeof experimentCli.parseExperimentArgs, 'function');
      assert.equal(typeof experimentCli.createExperimentCliOptions, 'function');
      assert.equal(typeof experimentCli.ExperimentCommandError, 'function');
      assert.equal(typeof experimentCli.ExperimentUsageError, 'function');
      assert.equal(Object.isFrozen(experimentCli.EXPERIMENT_CLI_OPTIONS), true);
      assert.equal('runExperiment' in forge, false);
      assert.equal('parseExperimentRunReport' in forge, false);
      for (const removed of ['@stripe/forge/campaign', '@stripe/forge/campaign/cli']) {
        await assert.rejects(import(removed), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
      }
      assert.equal(typeof regrade.regradeCompletedRun, 'function');
      assert.equal(typeof regrade.regradeExperimentRun, 'function');
      assert.equal(typeof regrade.judgeInputFromSavedRun, 'function');
      assert.equal('regradeCompletedRun' in forge, false);
      assert.equal(typeof claude.createClaudeCodeAdapter, 'function');
      assert.equal(typeof opencode.createOpenCodeAdapter, 'function');
      assert.equal(typeof opencode.parseOpenCodeStream, 'function');
      assert.equal(typeof opencode.loadOpenCodeEvidence, 'function');
      assert.equal(opencode.createOpenCodeAdapter().version, forge.FORGE_VERSION);
      assert.equal('createOpenCodeAdapter' in forge, false);
      assert.equal(docker.FORGE_OPENCODE_VERSION, '1.19.0');
      const openCodeRequirements = opencode.createOpenCodeAdapter({baseUrl: 'https://gateway.example/v1'}).requirements({adapter: 'opencode', provider: 'openai-compatible', model: 'gateway/model', model_profile: {limit: {context: 32000, output: 4000}, reasoning: false, temperature: true, attachment: false}});
      assert.equal(openCodeRequirements.environment.credentials.OPENCODE_API_KEY.reference, 'opencode.api-key');
      assert.equal(JSON.parse(openCodeRequirements.environment.variables.OPENCODE_CONFIG_CONTENT).model, 'forge/gateway/model');
      assert.equal(typeof codex.createCodexAdapter, 'function');
      assert.equal(typeof codex.parseCodexStream, 'function');
      assert.equal(typeof codex.loadCodexEvidence, 'function');
      assert.equal(codex.createCodexAdapter().version, forge.FORGE_VERSION);
      assert.equal(docker.FORGE_CODEX_VERSION, '0.149.0');
      assert.equal(claude.createClaudeCodeAdapter({baseUrl: 'https://gateway.example.com'}).version, forge.FORGE_VERSION);
      assert.equal(typeof openai.createOpenAICompletionProvider, 'function');
      assert.equal(openai.createOpenAICompletionProvider().version, forge.FORGE_VERSION);
      assert.deepEqual(openai.createOpenAICompletionProvider().metadata, {endpoint_mode: 'default'});
      assert.equal(typeof anthropic.createAnthropicCompletionProvider, 'function');
      assert.equal(anthropic.createAnthropicCompletionProvider().version, forge.FORGE_VERSION);
      assert.deepEqual(codex.createCodexAdapter().metadata, {endpoint_mode: 'default', layout_mode: 'default'});
      assert.deepEqual(anthropic.createAnthropicCompletionProvider({baseUrl: 'https://gateway.example.com'}).metadata, {endpoint_mode: 'custom'});
      for (const [surface, names] of [
        [forge, ['BENCHMARK_SCHEMA_VERSION', 'RESOLVED_RUN_PLAN_SCHEMA_VERSION', 'RUN_RESULT_SCHEMA_VERSION', 'SETUP_ARTIFACT_SCHEMA_VERSION', 'WORKSPACE_EVIDENCE_SCHEMA_VERSION', 'INTERACTION_SCHEMA_VERSION', 'JUDGE_EVIDENCE_SCHEMA_VERSION', 'EVALUATION_SCHEMA_VERSION', 'CRITERION_JUDGE_PROMPT_VERSION', 'JUDGE_TRANSCRIPT_PROJECTION_VERSION', 'JUDGE_WORKSPACE_EVIDENCE_SCHEMA_VERSION']],
        [experiment, ['EXPERIMENT_RUN_REPORT_SCHEMA_VERSION']],
        [atif, ['ATIF_NORMALIZATION_VERSION']],
        [claude, ['CLAUDE_CODE_ADAPTER_VERSION', 'CLAUDE_CODE_GATEWAY_ADAPTER_VERSION']],
        [codex, ['CODEX_ADAPTER_VERSION', 'CODEX_RESPONSES_ADAPTER_VERSION']],
        [anthropic, ['ANTHROPIC_COMPLETION_PROVIDER_VERSION', 'ANTHROPIC_MESSAGES_COMPATIBLE_PROVIDER_VERSION']],
      ]) {
        for (const name of names) assert.equal(name in surface, false);
      }
      assert.equal(typeof docker.createDockerRuntimeAdapter, 'function');
      assert.equal(typeof setup.createSetupExecutor, 'function');
      assert.equal(setup.credentialsSetupHandler, forge.credentialsSetupHandler);
      assert.deepEqual(forge.parseSetupStep({
        uses: 'forge/credentials', with: {env: ['API_TOKEN']},
      }), {uses: 'forge/credentials', with: {env: ['API_TOKEN']}});
      assert.equal(typeof setup.defineSetupActionBundle, 'function');
      assert.equal(typeof testing.createScriptedCompletionProvider, 'function');

      const externalPlan = testing.createTestResolvedRunPlan({runtime: {
        adapter: 'package-smoke/process',
        platform: 'linux/amd64', config: {profile: 'offline'},
      }});
      assert.equal(forge.parseResolvedRunPlan(externalPlan).runtime.adapter, 'package-smoke/process');
      const customClaude = claude.createClaudeCodeAdapter({layout: {
        workspace: '/tmp/example/workspace', home: '/tmp/example/home',
        configDirectory: '/tmp/example/session',
      }});
      const customRequirements = customClaude.requirements({
        adapter: 'claude-code', provider: 'anthropic', model: 'test',
      });
      assert.equal(customRequirements.environment.variables.CLAUDE_CONFIG_DIR, '/tmp/example/session');
      assert.equal(customRequirements.stateDirectories[0].containerPath,
        '/tmp/example/session/projects/-tmp-example-workspace');

      const customCodex = codex.createCodexAdapter({layout: {
        workspace: '/tmp/example/workspace', home: '/tmp/example/home',
        configDirectory: '/tmp/example/codex',
      }});
      const codexRequirements = customCodex.requirements({
        adapter: 'codex', provider: 'openai', model: 'test-model',
      });
      assert.equal(codexRequirements.environment.variables.CODEX_HOME, '/tmp/example/codex');
      assert.equal(codexRequirements.environment.credentials.CODEX_API_KEY.reference, 'openai.api-key');
      assert.equal(codexRequirements.stateDirectories[0].containerPath, '/tmp/example/codex');

      const bundle = setup.defineSetupActionBundle({
        manifest: {
          namespace: 'package-smoke',
          version: '1.0.0',
          sha256: 'sha256:${'a'.repeat(64)}',
        },
        actions: [{
          uses: 'package-smoke/tool',
          parseWith(input) {
            if (typeof input.name !== 'string') throw new TypeError('invalid');
            return {name: input.name};
          },
          preflight() {
            return {requirements: {}, async apply() {}};
          },
        }],
      });
      const engine = forge.createForgeEngine({setupActionBundles: [bundle]});
      assert.deepEqual(
        engine.parseSetupStep({
          uses: 'package-smoke/tool',
          with: {name: 'formatter'},
        }),
        {uses: 'package-smoke/tool', with: {name: 'formatter'}},
      );

      const experimentRoot = path.resolve('results', 'package-experiment');
      const plans = ['first', 'second'].map((id) => {
        const plan = structuredClone(testing.createTestResolvedRunPlan({caseId: 'testing/' + id}));
        plan.provenance.forge.action_bundles = [bundle.manifest];
        plan.treatment.setup = [{uses: 'package-smoke/tool', with: {name: 'formatter'}}];
        plan.setup = [...plan.treatment.setup];
        return engine.parseResolvedRunPlan(plan);
      });
      const agent = testing.createScriptedAgentAdapter().adapter;
      const composition = {
        runtime: testing.createFakeRuntimeAdapter().adapter,
        agents: new Map([[agent.id, agent]]),
        credentialResolver: testing.createStaticCredentialResolver(),
        inputProvider: testing.createMemoryRunInputProvider(),
        artifactStore: forge.createArtifactStore({root: experimentRoot}),
      };
      let nextId = 0;
      const experimentOptions = {
        root: experimentRoot, plans: [plans[0]], engine, composition, jobs: 1, resume: false,
        signal: new AbortController().signal,
        runIdFactory: () => 'package-run-' + (++nextId),
        progress: () => {},
        execute: (input) => {
          const runAgent = testing.createScriptedAgentAdapter().adapter;
          return engine.executeEval({...input, composition: {
            ...input.composition, agents: new Map([[runAgent.id, runAgent]]),
          }});
        },
      };
      const summary = await experiment.runExperiment(experimentOptions);
      assert.equal(summary.completed, 1);
      assert.equal(summary.checkpoint, path.join(experimentRoot, 'experiment.json'));
      assert.deepEqual(await experiment.readExperimentRunSelections(experimentRoot), [plans[0].selection]);
      const resumed = await experiment.runExperiment({...experimentOptions, resume: true});
      assert.equal(resumed.executed, 0);
      assert.equal(resumed.skipped, 1);
      assert.equal(resumed.checkpoint, summary.checkpoint);

      const commandOptions = {
        hostOptions: {tag: {type: 'string'}, upload: {type: 'boolean'}},
        engine, experimentRunIdFactory: () => 'package-command',
        runIdFactory: () => 'command-run-' + (++nextId),
        loadExperiment: async (context) => {
          assert.equal(context.engine, engine);
          assert.equal(context.values.tag, 'smoke');
          if (context.resume) assert.deepEqual(context.savedSelections, plans.map((plan) => plan.selection));
          return {plans, composition: {...composition, artifactStore: forge.createArtifactStore({root: context.root})},
            execute: (input) => {
              const agent = testing.createScriptedAgentAdapter().adapter;
              return engine.executeEval({...input, composition: {
                ...input.composition, agents: new Map([[agent.id, agent]]),
              }});
            }};
        },
      };
      const command = await experimentCli.runExperimentCommand(['--tag', 'smoke', '--upload', '-j2'], commandOptions);
      assert.equal(command.completed, 2);
      assert.equal(command.checkpoint, path.join(command.location, 'experiment.json'));
      assert.equal(command.report, path.join(command.location, 'report.json'));
      const report = JSON.parse(await fs.readFile(command.report, 'utf8'));
      assert.equal(experiment.parseExperimentRunReport(report).summary.passed, 2);
      assert.deepEqual(report.summary.criterion_scores, {
        required: {strict: null, avg: null, evaluations: 0},
        recommended: {strict: null, avg: null, evaluations: 0},
        blend: {score: null, evaluations: 0},
      });
      assert.deepEqual(report.runs[0].evaluation.criterion_scores, {
        required: {strict: null, avg: null},
        recommended: {strict: null, avg: null},
        blend: {score: null},
      });
      assert.equal(command.arguments.values.upload, true);
      assert.ok(command.outcomes.every((outcome) => outcome.artifact.evaluation.status === 'passed'));
      const inspected = await experiment.inspectExperimentRun({root: command.location + '/.', engine});
      assert.deepEqual(inspected.outcomes, command.outcomes);
      assert.equal(inspected.checkpoint, command.checkpoint);
      const commandResume = await experimentCli.runExperimentCommand(
        ['--tag', 'smoke', '--resume', command.experiment_run_id], commandOptions);
      assert.equal(commandResume.executed, 0);
      assert.equal(commandResume.skipped, 2);
      assert.deepEqual(commandResume.outcomes, command.outcomes);
      assert.equal(commandResume.checkpoint, command.checkpoint);
    `,
  );
  run(process.execPath, ['esm.mjs'], consumerRoot);
  // Compile the same public API contract through the packed package's declared
  // exports, so source-only type imports cannot hide missing consumer types.
  const publicApiTest = await fs.readFile(
    path.join(projectRoot, 'test', 'experimentPublicApi.test.ts'),
    'utf8',
  );
  const consumerImports = new Map([
    ['index', '@stripe/forge'],
    ['cli', '@stripe/forge/cli'],
    ['experiment', '@stripe/forge/experiment'],
    ['experimentCli', '@stripe/forge/experiment/cli'],
  ]);
  await fs.writeFile(
    path.join(consumerRoot, 'public-api-types.ts'),
    // The isolated consumer needs no Vitest dependency to typecheck this contract.
    publicApiTest
      .replace("from 'vitest'", "from 'node:test'")
      .replace(/'\.\.\/src\/([A-Za-z]+)\.ts'/g, (specifier, module) => {
        const target = consumerImports.get(module);
        if (target === undefined)
          throw new Error(`Unknown public API test import: ${specifier}`);
        return `'${target}'`;
      }),
  );
  run(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--verbatimModuleSyntax',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--lib',
      'ES2023',
      '--types',
      'node',
      '--typeRoots',
      path.join(projectRoot, 'node_modules', '@types'),
      'public-api-types.ts',
    ],
    consumerRoot,
  );
  assert.equal(
    execFileSync(
      path.join(consumerRoot, 'node_modules', '.bin', 'forge'),
      ['--version'],
      { cwd: consumerRoot, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    ),
    `${packageVersion}\n`,
  );

  // @stripe/forge is ESM-only. Existing CommonJS hosts interoperate through
  // the standard dynamic import boundary rather than a second package build.
  await fs.writeFile(
    path.join(consumerRoot, 'commonjs.cjs'),
    `
      const assert = require('node:assert/strict');
      void Promise.all([
        import('@stripe/forge'), import('@stripe/forge/experiment'), import('@stripe/forge/experiment/cli'),
      ]).then(([forge, experiment, experimentCli]) => {
        assert.equal(typeof forge.executeEval, 'function');
        assert.equal(typeof experiment.runExperiment, 'function');
        assert.equal(typeof experiment.parseExperimentRunReport, 'function');
        assert.equal(typeof experimentCli.runExperimentCommand, 'function');
      }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `,
  );
  run(process.execPath, ['commonjs.cjs'], consumerRoot);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, arguments_, cwd) {
  execFileSync(command, arguments_, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });
}
