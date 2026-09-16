import assert from 'node:assert/strict';
import * as path from 'node:path';
import {describe, it} from 'node:test';

import {runCli} from '../src/cli.js';
import {loadBenchmarkProfile, loadDataset} from '../src/model/index.js';
import {expandExperiment, resolveRunPlan} from '../src/planning/index.js';

const MANIFEST_SHA256 =
  'sha256:acd68e0d7c13dd6d3a46382e802ad2345d0f82de8813ecd239a84ed21d032447';
const CASE_SHA256 =
  'sha256:fa82c800831105fe9521ed03847d381523d774c706288a53a8082e34241991f3';
const exampleRoot = path.join(process.cwd(), 'examples', 'multi-turn');
const datasetRoot = path.join(exampleRoot, 'dataset');
const profilePath = path.join(exampleRoot, 'profile.yaml');
const casePath = path.join(
  datasetRoot,
  'cases',
  'examples',
  'release-summary.yaml',
);

describe('checked-in multi-turn example', () => {
  it('loads its pinned dataset and resolves the same plan through the CLI', async () => {
    const [dataset, profile] = await Promise.all([
      loadDataset(datasetRoot),
      loadBenchmarkProfile(profilePath),
    ]);

    assert.equal(dataset.manifestSha256, MANIFEST_SHA256);
    assert.deepEqual(dataset.manifest.files, [
      {
        path: 'cases/examples/release-summary.yaml',
        size: 1137,
        sha256: CASE_SHA256.slice('sha256:'.length),
      },
    ]);
    assert.equal(profile.profile.dataset.manifest_sha256, MANIFEST_SHA256);

    const selections = expandExperiment(profile);
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

    const plan = resolveRunPlan({dataset, profile, selection: selections[0]!});
    assert.equal(plan.provenance.case.sha256, CASE_SHA256);
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
    assert.equal(plan.evaluation.success_guidelines.length, 1);
    assert.equal(plan.evaluation.checks?.file_checks?.length, 1);

    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(
      [
        'plan',
        '--profile',
        profilePath,
        '--case-file',
        casePath,
        '--agent',
        'claude-code',
        '--model',
        'claude-sonnet-4-6',
      ],
      {
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      },
    );

    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), plan);
  });
});
