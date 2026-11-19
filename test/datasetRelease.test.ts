import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { createDefaultCliComposition, runCli } from '../src/cli.ts';
import {
  defaultForgeEngine,
  expandExperiment,
  loadDataset,
  loadExperimentConfig,
  parseExperimentConfig,
  resolveRunPlan,
} from '../src/index.ts';

const releaseRoot = path.resolve('release');
const datasetPath = 'datasets/stripe-integration-public-evals';
const experimentFile = 'experiment.yaml';
const datasetRoot = path.join(releaseRoot, datasetPath);
const experimentPath = path.join(releaseRoot, experimentFile);

describe('sample dataset release', () => {
  it('validates the released dataset and plans its pinned public baseline without credentials', async () => {
    const [dataset, experiment] = await Promise.all([
      loadDataset(datasetRoot),
      loadExperimentConfig(experimentPath),
    ]);
    assert.deepEqual(dataset.manifest.dataset, {
      id: 'stripe-integration-public-evals',
      version: '1.0.0',
    });
    assert.equal(dataset.manifest.cases.length, 69);
    assert.equal(dataset.cases.size, 69);
    for (const entry of dataset.manifest.cases)
      assert.equal(entry.version, '1.0.0');
    assert.deepEqual(
      dataset.manifest.cases.find(
        ({ id }) => id === 'stripe-integration-public-evals/payments-onetime',
      ),
      {
        id: 'stripe-integration-public-evals/payments-onetime',
        version: '1.0.0',
        path: 'cases/payments-onetime.case.yaml',
      },
    );
    assert.deepEqual(
      {
        id: experiment.config.dataset.id,
        version: experiment.config.dataset.version,
      },
      dataset.manifest.dataset,
    );
    assert.equal(
      experiment.config.dataset.path,
      './datasets/stripe-integration-public-evals',
    );

    const selections = expandExperiment(experiment, dataset);
    assert.equal(selections.length, 1);
    const plan = resolveRunPlan({
      dataset,
      experiment,
      selection: selections[0]!,
    });
    assert.deepEqual(plan.provenance.case, {
      id: 'stripe-integration-public-evals/payments-onetime',
      path: 'cases/payments-onetime.case.yaml',
    });
    assert.equal(plan.selection.treatment, 'baseline');
    assert.deepEqual(plan.agent, {
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(plan.interaction.mode, 'multi_turn');
    assert.equal(plan.interaction.max_turns, 10);
    assert.equal(plan.evaluation.judging_criteria.length, 8);
    assert.deepEqual(plan.role_player, {
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    assert.deepEqual(plan.evaluation.judge, {
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });

    for (const command of ['validate', 'plan']) {
      let stdout = '';
      let stderr = '';
      const code = await runCli([command, '--experiment', experimentPath], {
        environment: {},
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      });
      assert.equal(code, 0, stderr);
      assert.equal(stderr, '');
      if (command === 'plan') assert.deepEqual(JSON.parse(stdout), plan);
      else
        assert.deepEqual(JSON.parse(stdout), {
          dataset: dataset.manifest.dataset,
          experiment: {
            id: experiment.config.id,
            version: experiment.config.version,
          },
          run_count: 1,
          valid: true,
        });
    }
  });

  it('plans and preflights every released case on the public baseline without credentials', async () => {
    const [dataset, baseline] = await Promise.all([
      loadDataset(datasetRoot),
      loadExperimentConfig(experimentPath),
    ]);
    const experiment = {
      ...baseline,
      config: parseExperimentConfig({
        ...baseline.config,
        matrix: {
          ...baseline.config.matrix,
          cases: dataset.manifest.cases.map(({ path }) => path),
        },
      }),
    };
    const selections = expandExperiment(experiment, dataset);
    assert.equal(selections.length, 69);
    const composition = await createDefaultCliComposition({
      datasetRoot,
      resultsRoot: path.resolve('results'),
      environment: {},
    });
    for (const selection of selections) {
      const plan = resolveRunPlan({ dataset, experiment, selection });
      defaultForgeEngine.preflightEval({ plan, composition });
    }
  });

  it('relocates the dataset and experiment together without rewriting the experiment or changing its plan', async (context) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-dataset-release-'),
    );
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const [dataset, experiment] = await Promise.all([
      loadDataset(datasetRoot),
      loadExperimentConfig(experimentPath),
    ]);
    const originalPlan = resolveRunPlan({
      dataset,
      experiment,
      selection: expandExperiment(experiment, dataset)[0]!,
    });

    const relocatedRoot = path.join(root, 'release');
    await fs.cp(releaseRoot, relocatedRoot, { recursive: true });
    const relocatedExperimentPath = path.join(relocatedRoot, experimentFile);
    const [relocated, consumer] = await Promise.all([
      loadDataset(path.join(relocatedRoot, datasetPath)),
      loadExperimentConfig(relocatedExperimentPath),
    ]);
    assert.equal(relocated.manifestRaw, dataset.manifestRaw);
    assert.equal(consumer.raw, experiment.raw);
    assert.deepEqual(
      resolveRunPlan({
        dataset: relocated,
        experiment: consumer,
        selection: expandExperiment(consumer, relocated)[0]!,
      }),
      originalPlan,
    );

    let stdout = '';
    let stderr = '';
    const code = await runCli(
      ['plan', '--experiment', relocatedExperimentPath],
      {
        environment: {},
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), originalPlan);
  });
});
