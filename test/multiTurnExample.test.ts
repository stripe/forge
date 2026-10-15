import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { runCli } from '../src/cli.js';
import { loadDataset, loadExperimentConfig } from '../src/model/index.js';
import { expandExperiment, resolveRunPlan } from '../src/planning/index.js';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'multi-turn');
const datasetRoot = path.join(fixtureRoot, 'dataset');
const experimentPath = path.join(fixtureRoot, 'experiment.yaml');
const casePath = path.join(
  datasetRoot,
  'cases',
  'examples',
  'release-summary.case.yaml',
);

describe('multi-turn fixture', () => {
  it('loads its pinned dataset and resolves the same plan through the CLI', async () => {
    const [dataset, experiment] = await Promise.all([
      loadDataset(datasetRoot),
      loadExperimentConfig(experimentPath),
    ]);

    assert.equal(
      dataset.manifestSha256,
      experiment.config.dataset.manifest_sha256,
    );
    assert.deepEqual(
      dataset.manifest.files.map(({ path }) => path),
      ['cases/examples/release-summary.case.yaml'],
    );

    const selections = expandExperiment(experiment, dataset);
    assert.deepEqual(selections, [
      {
        case_id: 'examples/release-summary',
        treatment: 'baseline',
        agent: {
          adapter: 'claude-code',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        repetition: 0,
      },
    ]);

    const plan = resolveRunPlan({
      dataset,
      experiment,
      selection: selections[0]!,
    });
    assert.deepEqual(plan.provenance.case, {
      id: 'examples/release-summary',
      path: 'cases/examples/release-summary.case.yaml',
    });
    assert.deepEqual(plan.role_player, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    assert.deepEqual(plan.evaluation.judge, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(plan.interaction.mode, 'multi_turn');
    assert.equal(plan.interaction.max_turns, 4);
    assert.equal(
      plan.interaction.initial_prompt,
      'I need a release-summary.txt for this handoff. Before changing any files, ask me for the exact status sentence it should contain.',
    );
    assert.equal(plan.evaluation.judging_criteria.length, 1);
    assert.equal(plan.evaluation.checks?.file_checks?.length, 1);

    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(
      [
        'plan',
        '--experiment',
        experimentPath,
        '--case-file',
        casePath,
        '--agent',
        'claude-code',
        '--model',
        'claude-sonnet-4-6',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), plan);
  });
});
