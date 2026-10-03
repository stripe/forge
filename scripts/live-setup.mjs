import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {stringify} from 'yaml';

import {
  createArtifactStore,
  createDirectoryRunInputProvider,
  defaultForgeEngine as engine,
  expandExperiment,
  parseSetupArtifact,
} from '../dist/index.js';
import {
  CLAUDE_PLUGIN_STATE_PATH,
  createClaudeCodeAdapter,
} from '../dist/agents/claude-code/index.js';
import {
  createDockerRuntimeAdapter,
  detectDockerRuntimePlatform,
} from '../dist/runtime/docker/index.js';

const runHostCommand = promisify(execFile);
const PLUGIN = 'stripe@claude-plugins-official';
const MARKETPLACE = 'anthropics/claude-plugins-official';
const literalArguments = ['a value with spaces', '$HOME', '$(touch expanded.txt)', '*', 'line\nbreak'];
const write = (target, source) => ({uses: 'forge/write', with: {target, source}});
const command = (argv, options = {}) => ({uses: 'forge/command', with: {argv, ...options}});

const cases = [
  {id: 'write-inline', setup: [write('nested/inline.txt', {content: 'hello, Forge — 世界\n'})],
    files: {'nested/inline.txt': 'hello, Forge — 世界\n'}},
  {id: 'write-file', setup: [write('copied.txt', {dataset_path: 'fixtures/seed.txt'})],
    files: {'copied.txt': 'dataset seed\n'}},
  {id: 'command', setup: [
    command(['node', '-e', 'require("node:fs").mkdirSync("nested")']),
    command(['node', '-e', 'require("node:fs").writeFileSync("argv.json", JSON.stringify(process.argv.slice(1)))',
      ...literalArguments], {cwd: 'nested', timeout_ms: 30_000}),
  ], files: {'nested/argv.json': JSON.stringify(literalArguments)}},
  {id: 'command-exit', setup: [
    command(['node', '-e', 'process.exit(7)']),
    command(['node', '-e', 'require("node:fs").writeFileSync("unexpected.txt", "must not run")']),
  ], failure: 'exit'},
  {id: 'command-timeout', setup: [
    command(['node', '-e', 'setInterval(() => {}, 1000)'], {timeout_ms: 500}),
    command(['node', '-e', 'require("node:fs").writeFileSync("unexpected.txt", "must not run")']),
  ], failure: 'timeout'},
  {id: 'plugin', setup: [{uses: 'forge/plugin', with: {agents: {
    'claude-code': {plugin: PLUGIN, marketplace: MARKETPLACE},
  }}}], files: {'plugin-verified.txt': 'native plugin verified\n'}},
];

/** Real setup/execution/artifacts; interaction is a deterministic local probe. */
export async function runSetupIntegrationSuite({dockerExecutable, resultsRoot, suiteId, signal, progress}) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-live-setup-'));
  try {
    const platform = await detectDockerRuntimePlatform({dockerExecutable, signal});
    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    await fs.mkdir(runtimeRoot);
    const dockerRuntime = createDockerRuntimeAdapter({dockerExecutable, temporaryRoot: runtimeRoot});
    const issuedCommands = new Map();
    const runtime = {
      ...dockerRuntime,
      async prepare(input) {
        const prepared = await dockerRuntime.prepare(input);
        const calls = [];
        issuedCommands.set(input.plan.selection.case_id, calls);
        const record = (runner) => ({
          run(argv, options) {
            calls.push([...argv]);
            return runner.run(argv, options);
          },
        });
        return {...prepared, commands: {
          uncredentialed: record(prepared.commands.uncredentialed),
          setup: (names) => record(prepared.commands.setup(names)),
          agent: record(prepared.commands.agent),
        }};
      },
    };
    const {dataset, experiment} = await createFixture(fixtureRoot, platform);
    const inputProvider = await createDirectoryRunInputProvider(dataset.root, {manifest: dataset.manifest});
    const nativeAgent = createClaudeCodeAdapter();
    const observations = new Map();
    const openedSessions = new Set();
    const agent = {
      id: 'claude-code',
      version: 'setup-integration-1',
      pluginInstaller: nativeAgent.pluginInstaller,
      requirements() {
        return {executables: ['node', 'claude'], environment: {}, stateDirectories: []};
      },
      evidenceIdentity() { return {name: 'forge-setup-probe', version: '1'}; },
      prepare: (context) => nativeAgent.prepare(context),
      async openSession(context) {
        openedSessions.add(context.plan.selection.case_id);
        let sessionId;
        return {
          sessionId: () => sessionId,
          async send(_message, {signal}) {
            const spec = cases.find(({id}) => `setup/${id}` === context.plan.selection.case_id);
            assert.ok(spec && !spec.failure, 'Failed setup must never open an agent session');
            if (spec.id === 'plugin') {
              observations.set(spec.id, await verifyNativePlugin(context.runtime, signal));
            }
            // Read via a real container command, proving host-written and
            // command-produced bytes are visible after setup finalization.
            const result = await context.runtime.commands.agent.run(['node', '-e', `
              const fs = require('node:fs');
              const entries = process.argv.slice(1).map((file) =>
                [file, fs.readFileSync(file).toString('base64')]);
              if (fs.existsSync('expanded.txt') || fs.existsSync('nested/expanded.txt')) {
                throw new Error('An argv argument was interpreted by a shell.');
              }
              process.stdout.write(JSON.stringify(entries));
            `, ...Object.keys(spec.files)], {signal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024});
            assert.equal(result.exitCode, 0, `Container read failed for ${spec.id}`);
            assert.deepEqual(JSON.parse(result.stdout), Object.entries(spec.files)
              .map(([file, body]) => [file, Buffer.from(body).toString('base64')]));
            sessionId = `setup-${context.runId}`;
            return {text: `Verified ${spec.id} setup.`, sessionId, toolCalls: []};
          },
        };
      },
      async collectEvidence({signal}) {
        signal.throwIfAborted();
        return {kind: 'unavailable', reason: {
          code: 'source_unavailable', message: 'The setup probe makes no model calls or native agent session.',
        }};
      },
    };
    const composition = {
      runtime, agents: new Map([[agent.id, agent]]), inputProvider,
      artifactStore: createArtifactStore({root: resultsRoot}),
      credentialResolver: {async resolve() {throw new Error('Setup integration must never resolve credentials');}},
    };
    const plans = expandExperiment(experiment).map((selection) =>
      engine.resolveRunPlan({dataset, experiment, selection}));
    for (const plan of plans) engine.preflightEval({plan, composition});

    const reports = [];
    for (const [index, plan] of plans.entries()) {
      const spec = cases[index];
      const runId = `${suiteId}-setup-${spec.id}`;
      progress(`checking ${spec.setup[0].uses}: ${spec.id}`);
      try {
        if (spec.failure) {
          let error;
          try { await engine.executeEval({runId, plan, composition, signal}); }
          catch (caught) { error = caught; }
          assert.equal(error?.code, 'setup_failed');
          assert.equal(error.phase, 'setup');
          assert.equal(error.cause?.code, 'setup_action_failed');
          if (spec.failure === 'timeout') assert.equal(error.cause.cause?.code, 'command_timeout');
          else assert.match(error.cause.cause?.message ?? '', /exited with status 7/);
          assert.equal(openedSessions.has(plan.selection.case_id), false);
          assert.equal(issuedCommands.get(plan.selection.case_id)
            .some((argv) => argv.some((value) => value.includes('unexpected.txt'))), false,
          'Setup continued after a failed command');
          await assert.rejects(fs.stat(path.join(resultsRoot, 'runs', runId)), {code: 'ENOENT'});
          reports.push({case_id: plan.selection.case_id, verified: true, expected_error: error.code});
        } else {
          const completed = await engine.executeEval({runId, plan, composition, signal});
          const verified = await engine.verifyCompletedRun(completed.location);
          assert.equal(verified.result.evaluation.status, 'passed');
          assert.ok(verified.result.evaluation.checks.length > 0);
          assert.ok(verified.result.evaluation.checks.every(({passed}) => passed));
          assert.equal(verified.result.completion_calls.length, 0);
          assert.equal(verified.result.evidence.completeness, 'fallback');
          assert.equal(verified.result.warnings.some(({code}) => code === 'runtime_cleanup_failed'), false);
          const setup = parseSetupArtifact(JSON.parse(await fs.readFile(path.join(completed.location, 'setup.json'), 'utf8')));
          assert.deepEqual(setup.steps.map(({index, uses}) => ({index, uses})),
            spec.setup.map(({uses}, index) => ({index, uses})));
          if (spec.id === 'plugin') {
            const receipt = setup.steps[0].resolution;
            const installed = observations.get(spec.id);
            assert.equal(receipt.plugin, PLUGIN);
            assert.equal(receipt.marketplace, MARKETPLACE);
            assert.equal(receipt.native_plugin_id, installed.id);
            assert.equal(receipt.version, installed.version);
            assert.match(receipt.marketplace_commit, /^[a-f0-9]{40}$/);
            assert.match(receipt.installed_tree.sha256, /^sha256:[a-f0-9]{64}$/);
            assert.ok(receipt.installed_tree.file_count > 0);
          } else assert.ok(setup.steps.every((step) => step.resolution === undefined));
          reports.push({case_id: plan.selection.case_id, verified: true,
            run_id: runId, location: completed.location, uses: spec.setup[0].uses});
        }
      } finally {
        // Check actual resources, including stopped containers, after both
        // success and expected failure. Cleanup is independent of the signal.
        const {stdout} = await runHostCommand(dockerExecutable, [
          'ps', '--all', '--filter', `name=stripe-forge-${runId}-`, '--format', '{{.ID}}',
        ], {timeout: 30_000, maxBuffer: 64 * 1024});
        assert.equal(stdout.trim(), '', `Container leaked for ${spec.id}`);
        assert.deepEqual(await fs.readdir(runtimeRoot), [], `Runtime files leaked for ${spec.id}`);
      }
    }
    return {verified: true, model_calls: 0, platform, cases: reports};
  } finally {
    await fs.rm(fixtureRoot, {recursive: true, force: true});
  }
}

async function verifyNativePlugin(runtime, signal) {
  const listed = await runtime.commands.agent.run(['claude', 'plugin', 'list', '--json'],
    {signal, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024});
  assert.equal(listed.exitCode, 0);
  const plugins = JSON.parse(listed.stdout);
  assert.equal(plugins.length, 1);
  const installed = plugins[0];
  assert.equal(installed.id, PLUGIN);
  assert.equal(installed.enabled, true);
  assert.equal(typeof installed.version, 'string');
  assert.ok(installed.version.length > 0);
  assert.equal(installed.installPath, `${CLAUDE_PLUGIN_STATE_PATH}/cache/claude-plugins-official/stripe/${installed.version}`);
  const probe = await runtime.commands.agent.run(['node', '-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const [root, home, id] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'stripe');
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.enabledPlugins[id], true);
    fs.writeFileSync('plugin-verified.txt', 'native plugin verified\\n');
  `, installed.installPath, runtime.paths.home, installed.id],
  {signal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024});
  assert.equal(probe.exitCode, 0, 'Native plugin files/settings are not available after setup');
  return installed;
}

async function createFixture(root, platform) {
  const datasetRoot = path.join(root, 'dataset');
  const files = {
    'fixtures/seed.txt': 'dataset seed\n',
  };
  for (const spec of cases) {
    files[`cases/setup/${spec.id}.yaml`] = stringify({
      schema_version: 1, id: `setup/${spec.id}`, initial_prompt: `Verify ${spec.id} setup.`,
      execution_mode: 'one_shot', setup: spec.setup, success_guidelines: [],
      checks: {file_checks: Object.entries(spec.files ?? {}).map(([file, body]) => ({
        file, exists: true, contains: `^${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\n/g, '\\n').replace(/\r/g, '\\r')}$`,
      }))},
    });
  }
  const manifest = {
    schema_version: 1, dataset: {id: 'forge-live-setup', version: '1.0.0'},
    cases: cases.map(({id}) => ({id: `setup/${id}`, path: `cases/setup/${id}.yaml`})),
    files: Object.entries(files).map(([file, body]) => ({
      path: file, size: Buffer.byteLength(body), sha256: sha256(body),
    })),
  };
  for (const [file, body] of Object.entries(files)) {
    const destination = path.join(datasetRoot, file);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, body);
  }
  const manifestBody = `${JSON.stringify(manifest)}\n`;
  await fs.writeFile(path.join(datasetRoot, 'manifest.json'), manifestBody);
  const experimentPath = path.join(root, 'experiment.yaml');
  await fs.writeFile(experimentPath, stringify({
    schema_version: 1, id: 'testing/setup-integration', version: '1.0.0',
    dataset: {...manifest.dataset, path: './dataset', manifest_sha256: `sha256:${sha256(manifestBody)}`},
    runtime: {adapter: 'docker', image: {kind: 'forge'}, platform,
      resources: {memory_bytes: 4 * 1024 ** 3, cpu_count: 2, process_count: 512}},
    models: {}, treatments: {baseline: {setup: []}},
    matrix: {cases: cases.map(({id}) => `setup/${id}`), treatments: ['baseline'],
      agents: [{adapter: 'claude-code', provider: 'anthropic', model: 'setup-probe'}],
      repetitions: 1, retries: 0},
    limits: {run_timeout_ms: 5 * 60_000},
  }));
  return {
    dataset: await engine.loadDataset(datasetRoot),
    experiment: await engine.loadExperimentConfig(experimentPath),
  };
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}
