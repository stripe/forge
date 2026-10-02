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
      import * as forge from '@stripe/forge';
      import * as atif from '@stripe/forge/atif/v1.8';
      import * as cli from '@stripe/forge/cli';
      import * as claude from '@stripe/forge/agents/claude-code';
      import * as codex from '@stripe/forge/agents/codex';
      import * as anthropic from '@stripe/forge/providers/anthropic';
      import * as docker from '@stripe/forge/runtime/docker';
      import * as setup from '@stripe/forge/setup';
      import * as testing from '@stripe/forge/testing';
      import packageMetadata from '@stripe/forge/package.json' with {type: 'json'};

      assert.equal(typeof forge.executeEval, 'function');
      assert.equal(forge.FORGE_VERSION, packageMetadata.version);
      assert.equal(typeof forge.createForgeEngine, 'function');
      assert.equal(typeof forge.preflightEval, 'function');
      assert.equal(typeof forge.parseInteractionArtifact, 'function');
      assert.equal(typeof forge.parseJudgeEvidence, 'function');
      assert.equal(forge.JUDGE_EVIDENCE_SCHEMA_VERSION, 1);
      assert.equal(typeof forge.parseResolvedRunPlan, 'function');
      assert.equal(typeof docker.detectDockerRuntimePlatform, 'function');
      assert.equal(typeof docker.validateDockerRuntimeHost, 'function');
      assert.equal(typeof forge.createJudgeTranscriptProjection, 'function');
      assert.equal(forge.JUDGE_TRANSCRIPT_SOURCE, 'trajectory.json');
      assert.equal(forge.JUDGE_TRANSCRIPT_PROJECTION_ID, 'forge-visible-atif-steps');
      assert.equal(forge.JUDGE_TRANSCRIPT_PROJECTION_VERSION, 1);
      assert.equal(forge.JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE, 'root');
      assert.deepEqual(forge.JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES, [
        'user',
        'agent',
      ]);
      assert.equal(forge.JUDGE_TRANSCRIPT_COPIED_CONTEXT, 'excluded');
      assert.equal(forge.MAX_JUDGE_TRANSCRIPT_BYTES, 768 * 1024);
      assert.equal(forge.MAX_GUIDELINE_JUDGE_PROMPT_BYTES, 1024 * 1024);
      assert.deepEqual(forge.JUDGE_TRANSCRIPT_INCLUDED_FIELDS, [
        'step_id',
        'source',
        'message',
        'tool_calls[].tool_call_id',
        'tool_calls[].function_name',
        'tool_calls[].arguments',
        'observation.results[].source_call_id',
        'observation.results[].content',
        'observation.results[].is_error',
      ]);
      assert.equal(typeof forge.parseJudgeTranscriptProjection, 'function');
      assert.equal(forge.RUN_RESULT_SCHEMA_VERSION, 1);
      assert.equal(atif.ATIF_SCHEMA_VERSION, 'ATIF-v1.8');
      assert.equal(atif.isAtifTimestamp('2024-02-29T00:00:00Z'), true);
      assert.equal(typeof atif.parseNormalizedTrajectory, 'function');
      assert.equal(typeof cli.runCli, 'function');
      assert.equal(typeof cli.createDefaultCliComposition, 'function');
      assert.equal(typeof claude.createClaudeCodeAdapter, 'function');
      assert.equal(typeof codex.createCodexAdapter, 'function');
      assert.equal(typeof codex.parseCodexStream, 'function');
      assert.equal(typeof codex.loadCodexEvidence, 'function');
      assert.equal(codex.CODEX_ADAPTER_VERSION, '1');
      assert.equal(docker.FORGE_CODEX_VERSION, '0.149.0');
      assert.equal(claude.CLAUDE_CODE_GATEWAY_ADAPTER_VERSION, '2+gateway');
      assert.equal(typeof anthropic.createAnthropicCompletionProvider, 'function');
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
      void import('@stripe/forge').then((forge) => {
        assert.equal(typeof forge.executeEval, 'function');
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
