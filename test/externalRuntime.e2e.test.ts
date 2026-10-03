import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {
  createArtifactStore,
  createDirectoryRunInputProvider,
  credentialReference,
  executeEval,
  expandExperiment,
  loadDataset,
  loadExperimentConfig,
  preflightEval,
  resolveRunPlan,
  verifyCompletedRun,
  type AgentAdapter,
  type ForgeComposition,
  type RuntimeAdapter,
} from '../src/index.js';
import {
  createFakeRuntimeAdapter,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from '../src/testing/index.js';

const exampleRoot = path.join(process.cwd(), 'examples', 'quickstart');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.rm(directory, {recursive: true, force: true}),
  ));
});

describe('external runtime composition', () => {
  it('plans, runs, and verifies external runtime artifacts without an adapter parser', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-external-e2e-'));
    temporaryDirectories.push(temporaryRoot);
    const [dataset, example] = await Promise.all([
      loadDataset(path.join(exampleRoot, 'dataset')),
      loadExperimentConfig(path.join(exampleRoot, 'experiment.yaml')),
    ]);
    const descriptor = {
      adapter: 'acme/process',
      platform: 'linux/amd64',
      config: {profile: 'test-sandbox', network_policy: 'offline'},
    };
    const experimentPath = path.join(temporaryRoot, 'experiment.json');
    await fs.writeFile(experimentPath, JSON.stringify({
      ...example.config,
      runtime: descriptor,
      matrix: {...example.config.matrix, treatments: ['seeded']},
      treatments: {
        seeded: {
          setup: [{
            uses: 'forge/write',
            with: {target: 'seed.txt', source: {content: 'prepared by setup'}},
          }],
        },
      },
    }));
    const experiment = await loadExperimentConfig(experimentPath);
    const plan = resolveRunPlan({
      dataset,
      experiment,
      selection: expandExperiment(experiment)[0]!,
    });
    assert.deepEqual(plan.runtime, descriptor);

    const runtime = createFakeRuntimeAdapter({
      id: descriptor.adapter,
      metadata: {mode: 'in-memory-test'},
    });
    let preflightCalls = 0;
    let resolvedCredentials = 0;
    let adapterAvailable = true;
    const external: RuntimeAdapter = {
      ...runtime.adapter,
      preflight({plan: selectedPlan, requirements}) {
        assert.ok(adapterAvailable, 'Offline verification must not invoke the adapter.');
        preflightCalls += 1;
        // This is the host's private configuration validation. The public
        // parser and offline verifier only know the bounded JSON envelope.
        assert.deepEqual(selectedPlan.runtime, descriptor);
        assert.deepEqual(requirements.executables, ['acme-agent']);
        assert.deepEqual(requirements.stateDirectories, [{
          id: 'agent-state', containerPath: '/srv/acme/agent',
        }]);
      },
      prepare(input) {
        assert.ok(adapterAvailable);
        return runtime.adapter.prepare(input);
      },
    };
    const scripted = createScriptedAgentAdapter({
      id: 'claude-code',
      requirements: {
        executables: ['acme-agent'],
        stateDirectories: [{id: 'agent-state', containerPath: '/srv/acme/agent'}],
        environment: {
          credentials: {
            ACME_TOKEN: {reference: credentialReference('acme.agent-token')},
          },
        },
      },
      turns: [{
        text: 'Created hello.txt with the requested contents.',
        sessionId: 'external-runtime-session',
        toolCalls: [{id: 'write-1', name: 'Write', input: {path: 'hello.txt'}}],
      }],
    });
    const agent: AgentAdapter = {
      ...scripted.adapter,
      async openSession(context) {
        const session = await scripted.adapter.openSession(context);
        return {
          sessionId: () => session.sessionId(),
          async send(message, options) {
            assert.equal(Buffer.from(
              await context.runtime.workspace.readFile('seed.txt'),
            ).toString(), 'prepared by setup');
            await context.runtime.commands.agent.run(['acme-agent', 'respond'], {
              signal: options.signal,
            });
            await context.runtime.workspace.writeFile('hello.txt', Buffer.from('hello, forge!\n'));
            return session.send(message, options);
          },
        };
      },
    };
    const composition: ForgeComposition = {
      runtime: external,
      agents: new Map([[agent.id, agent]]),
      credentialResolver: createStaticCredentialResolver({
        'acme.agent-token': 'synthetic-agent-secret',
      }, {onResolve: () => { resolvedCredentials += 1; }}),
      inputProvider: await createDirectoryRunInputProvider(dataset.root),
      artifactStore: createArtifactStore({root: path.join(temporaryRoot, 'results')}),
    };

    preflightEval({plan, composition});
    assert.equal(preflightCalls, 1);
    assert.equal(resolvedCredentials, 0);
    assert.equal(runtime.runs.length, 0);
    const completed = await executeEval({
      runId: 'external-runtime-e2e', plan, composition,
    });
    assert.equal(preflightCalls, 2);
    assert.equal(resolvedCredentials, 1);
    assert.equal(completed.result.evaluation.status, 'passed');
    assert.equal(completed.result.evidence.completeness, 'fallback');
    assert.deepEqual(runtime.runs[0]?.events, [
      'prepare', 'finalizeSetup', 'command:agent', 'quiesce', 'dispose',
    ]);
    assert.deepEqual(runtime.runs[0]?.commands[0]?.credentialEnvironmentNames, ['ACME_TOKEN']);

    adapterAvailable = false;
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(preflightCalls, 2);
    assert.deepEqual(verified.result.runtime, {
      adapter: 'acme/process',
      runtime_id: 'external-runtime-e2e',
      platform: 'linux/amd64',
      metadata: {adapter: 'acme/process', mode: 'in-memory-test'},
    });
    const storedPlan = JSON.parse(await fs.readFile(
      path.join(completed.location, 'plan.json'), 'utf8',
    )) as {runtime: unknown};
    assert.deepEqual(storedPlan.runtime, descriptor);
    assert.deepEqual(verified.result.artifacts.map(({path: artifactPath}) => artifactPath), [
      'plan.json', 'setup.json', 'trajectory.json', 'interaction.json', 'workspace-evidence.json',
    ]);

    const resultPath = path.join(completed.location, 'result.json');
    const originalResult = await fs.readFile(resultPath, 'utf8');
    try {
      for (const [field, value] of [
        ['adapter', 'acme/other'],
        ['platform', 'linux/arm64'],
      ] as const) {
        const altered = JSON.parse(originalResult) as {runtime: Record<string, unknown>};
        altered.runtime[field] = value;
        await fs.writeFile(resultPath, JSON.stringify(altered));
        await assert.rejects(verifyCompletedRun(completed.location), /runtime does not match/);
      }
    } finally {
      await fs.writeFile(resultPath, originalResult);
    }
    await verifyCompletedRun(completed.location);
    assert.equal(preflightCalls, 2);
  });
});
