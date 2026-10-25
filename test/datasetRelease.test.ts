import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import {
  expandExperiment,
  loadDataset,
  loadExperimentConfig,
  resolveRunPlan,
} from '../src/index.ts';

const datasetRelativeRoot = 'datasets/stripe-integration-public-evals';
const experimentRelativeRoot = 'experiments/stripe-integration-public-evals';
const datasetRoot = path.resolve(datasetRelativeRoot);
const experimentPath = path.resolve(experimentRelativeRoot, 'experiment.yaml');

describe('sample dataset release', () => {
  it('validates the portable plugin example for both native adapters without credentials', async () => {
    let output = '';
    let errors = '';
    const code = await runCli(
      [
        'validate',
        '--experiment',
        path.resolve(experimentRelativeRoot, 'plugin-experiment.yaml'),
      ],
      {
        environment: {},
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          errors += text;
        },
      },
    );
    assert.equal(code, 0, errors);
    assert.equal(JSON.parse(output).run_count, 2);
  });

  it('validates the bundled dataset and plans its pinned public baseline without credentials', async () => {
    const [dataset, experiment] = await Promise.all([
      loadDataset(datasetRoot),
      loadExperimentConfig(experimentPath),
    ]);
    assert.deepEqual(dataset.manifest.dataset, {
      id: 'stripe-integration-public-evals',
      version: '0.3.0',
    });
    assert.equal(dataset.manifest.cases.length, 73);
    assert.deepEqual(
      dataset.manifest.cases.find(
        ({ id }) => id === 'stripe-integration-public-evals/payments-onetime',
      ),
      {
        id: 'stripe-integration-public-evals/payments-onetime',
        version: '0.2.0',
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
    for (const relativeRoot of [datasetRelativeRoot, experimentRelativeRoot]) {
      await fs.cp(
        path.resolve(relativeRoot),
        path.join(relocatedRoot, relativeRoot),
        { recursive: true },
      );
    }
    const relocatedExperimentPath = path.join(
      relocatedRoot,
      experimentRelativeRoot,
      'experiment.yaml',
    );
    const [relocated, consumer] = await Promise.all([
      loadDataset(path.join(relocatedRoot, datasetRelativeRoot)),
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
