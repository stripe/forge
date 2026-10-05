import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const {packageManager, version: packageVersion} = packageMetadata;
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
    await fs.readFile(path.join(projectRoot, 'dist', 'build-info.json'), 'utf8'),
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
  run(
    'pnpm',
    ['add', '--offline', '--ignore-scripts', archive],
    consumerRoot,
  );

  await fs.writeFile(
    path.join(consumerRoot, 'esm.mjs'),
    `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import * as path from 'node:path';
      import * as forge from '@stripe/forge';
      import * as atif from '@stripe/forge/atif/v1.8';
      import * as cli from '@stripe/forge/cli';
      import * as campaign from '@stripe/forge/campaign';
      import * as campaignCli from '@stripe/forge/campaign/cli';
      import * as claude from '@stripe/forge/agents/claude-code';
      import * as codex from '@stripe/forge/agents/codex';
      import * as anthropic from '@stripe/forge/providers/anthropic';
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
      assert.equal(typeof campaign.runCampaign, 'function');
      assert.equal(typeof campaign.readCampaignSelections, 'function');
      assert.equal(typeof campaign.inspectCampaign, 'function');
      assert.equal(typeof campaign.parseCampaignReport, 'function');
      assert.equal(typeof campaign.CampaignReportError, 'function');
      assert.equal(typeof campaignCli.runCampaignCommand, 'function');
      assert.equal(typeof campaignCli.parseCampaignArgs, 'function');
      assert.equal(typeof campaignCli.createCampaignCliOptions, 'function');
      assert.equal('runCampaign' in forge, false);
      assert.equal('parseCampaignReport' in forge, false);
      assert.equal(typeof claude.createClaudeCodeAdapter, 'function');
      assert.equal(typeof codex.createCodexAdapter, 'function');
      assert.equal(typeof codex.parseCodexStream, 'function');
      assert.equal(typeof codex.loadCodexEvidence, 'function');
      assert.equal(codex.createCodexAdapter().version, forge.FORGE_VERSION);
      assert.equal(docker.FORGE_CODEX_VERSION, '0.149.0');
      assert.equal(claude.createClaudeCodeAdapter({baseUrl: 'https://gateway.example.com'}).version, forge.FORGE_VERSION);
      assert.equal(typeof anthropic.createAnthropicCompletionProvider, 'function');
      assert.equal(anthropic.createAnthropicCompletionProvider().version, forge.FORGE_VERSION);
      assert.deepEqual(codex.createCodexAdapter().metadata, {endpoint_mode: 'default', layout_mode: 'default'});
      assert.deepEqual(anthropic.createAnthropicCompletionProvider({baseUrl: 'https://gateway.example.com'}).metadata, {endpoint_mode: 'custom'});
      for (const [surface, names] of [
        [forge, ['BENCHMARK_SCHEMA_VERSION', 'RESOLVED_RUN_PLAN_SCHEMA_VERSION', 'RUN_RESULT_SCHEMA_VERSION', 'SETUP_ARTIFACT_SCHEMA_VERSION', 'WORKSPACE_EVIDENCE_SCHEMA_VERSION', 'INTERACTION_SCHEMA_VERSION', 'JUDGE_EVIDENCE_SCHEMA_VERSION', 'EVALUATION_SCHEMA_VERSION', 'GUIDELINE_JUDGE_PROMPT_VERSION', 'JUDGE_TRANSCRIPT_PROJECTION_VERSION', 'JUDGE_WORKSPACE_EVIDENCE_SCHEMA_VERSION']],
        [campaign, ['CAMPAIGN_REPORT_SCHEMA_VERSION']],
        [atif, ['ATIF_NORMALIZATION_VERSION']],
        [claude, ['CLAUDE_CODE_ADAPTER_VERSION', 'CLAUDE_CODE_GATEWAY_ADAPTER_VERSION']],
        [codex, ['CODEX_ADAPTER_VERSION', 'CODEX_RESPONSES_ADAPTER_VERSION']],
        [anthropic, ['ANTHROPIC_COMPLETION_PROVIDER_VERSION', 'ANTHROPIC_MESSAGES_COMPATIBLE_PROVIDER_VERSION']],
      ]) {
        for (const name of names) assert.equal(name in surface, false);
      }
      assert.equal(typeof docker.createDockerRuntimeAdapter, 'function');
      assert.equal(typeof setup.createSetupExecutor, 'function');
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

      const campaignRoot = path.resolve('results', 'package-campaign');
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
        artifactStore: forge.createArtifactStore({root: campaignRoot}),
      };
      let nextId = 0;
      const campaignOptions = {
        root: campaignRoot, plans: [plans[0]], engine, composition, jobs: 1, resume: false,
        signal: new AbortController().signal,
        runIdFactory: () => 'package-run-' + (++nextId),
        progress: () => {},
        execute: (input) => {
          const runAgent = testing.createScriptedAgentAdapter().adapter;
          return engine.executeEval({...input, composition: {
            ...composition, agents: new Map([[runAgent.id, runAgent]]),
          }});
        },
      };
      const summary = await campaign.runCampaign(campaignOptions);
      assert.equal(summary.completed, 1);
      assert.deepEqual(await campaign.readCampaignSelections(campaignRoot), [plans[0].selection]);

      const commandOptions = {
        hostOptions: {tag: {type: 'string'}, upload: {type: 'boolean'}},
        engine, experimentRunIdFactory: () => 'package-command',
        runIdFactory: () => 'command-run-' + (++nextId),
        loadCampaign: async (context) => {
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
      const command = await campaignCli.runCampaignCommand(['--tag', 'smoke', '--upload', '-j2'], commandOptions);
      assert.equal(command.completed, 2);
      assert.equal(command.report, path.join(command.location, 'report.json'));
      assert.equal(campaign.parseCampaignReport(JSON.parse(await fs.readFile(command.report, 'utf8'))).summary.passed, 2);
      assert.equal(command.arguments.values.upload, true);
      assert.ok(command.outcomes.every((outcome) => outcome.artifact.evaluation.status === 'passed'));
      const inspected = await campaign.inspectCampaign({root: command.location + '/.', engine});
      assert.deepEqual(inspected.outcomes, command.outcomes);
      const commandResume = await campaignCli.runCampaignCommand(['--tag', 'smoke', '--resume', command.experiment_run_id], commandOptions);
      assert.equal(commandResume.executed, 0);
      assert.equal(commandResume.skipped, 2);
      assert.deepEqual(commandResume.outcomes, command.outcomes);
    `,
  );
  run(process.execPath, ['esm.mjs'], consumerRoot);
  assert.equal(
    execFileSync(
      path.join(consumerRoot, 'node_modules', '.bin', 'forge'),
      ['--version'],
      {cwd: consumerRoot, encoding: 'utf8', env: {...process.env, CI: '1'}},
    ),
    `${packageVersion}\n`,
  );

  // @stripe/forge is ESM-only. Existing CommonJS hosts interoperate through
  // the standard dynamic import boundary rather than a second package build.
  await fs.writeFile(
    path.join(consumerRoot, 'commonjs.cjs'),
    `
      const assert = require('node:assert/strict');
      void Promise.all([import('@stripe/forge'), import('@stripe/forge/campaign'), import('@stripe/forge/campaign/cli')]).then(([forge, campaign, campaignCli]) => {
        assert.equal(typeof forge.executeEval, 'function');
        assert.equal(typeof campaign.runCampaign, 'function');
        assert.equal(typeof campaign.parseCampaignReport, 'function');
        assert.equal(typeof campaignCli.runCampaignCommand, 'function');
      }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `,
  );
  run(process.execPath, ['commonjs.cjs'], consumerRoot);
} finally {
  await fs.rm(temporaryRoot, {recursive: true, force: true});
}

function run(command, arguments_, cwd) {
  execFileSync(command, arguments_, {
    cwd,
    stdio: 'inherit',
    env: {...process.env, CI: '1'},
  });
}
