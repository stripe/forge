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

const releaseRoot = path.resolve(
  'datasets/stripe-integration-public-evals/0.1.0',
);
const datasetRoot = path.join(releaseRoot, 'dataset');
const experimentPath = path.join(releaseRoot, 'experiment.yaml');

describe('sample dataset release', () => {
  it('validates the bundled dataset and plans its pinned public baseline without credentials', async () => {
    const [dataset, experiment] = await Promise.all([
      loadDataset(datasetRoot),
      loadExperimentConfig(experimentPath),
    ]);
    assert.deepEqual(dataset.manifest.dataset, {
      id: 'stripe-integration-public-evals',
      version: '0.1.0',
    });
    assert.deepEqual(dataset.manifest.cases, [
      'cases/payments-onetime.case.yaml',
    ]);
    assert.equal(
      dataset.manifestSha256,
      experiment.config.dataset.manifest_sha256,
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
    assert.equal(plan.role_player?.provider, 'anthropic');
    assert.equal(plan.evaluation.judge?.provider, 'anthropic');

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

  it('relocates the complete release without rewriting the experiment or changing its plan', async (context) => {
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
    const relocatedExperimentPath = path.join(relocatedRoot, 'experiment.yaml');
    const [relocated, consumer] = await Promise.all([
      loadDataset(path.join(relocatedRoot, 'dataset')),
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
