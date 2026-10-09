import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {it} from 'node:test';
import {promisify} from 'node:util';

import {
  collectWorkspaceEvidence,
  expandExperiment,
  loadDataset,
  loadExperimentConfig,
  resolveRunPlan,
  runWorkspaceChecks,
} from '../src/index.js';
import {createMemoryWorkspace} from '../src/testing/index.js';

const run = promisify(execFile);
const generator = path.resolve('docs/create-quickstart.mjs');

it('generates a movable, hash-verified quickstart with an exact newline check', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-quickstart-generator-'));
  context.after(() => rm(root, {recursive: true, force: true}));
  const generated = path.join(root, 'quickstart');
  await run(process.execPath, [generator, generated], {cwd: root});
  const destination = path.join(root, 'moved quickstart');
  await rename(generated, destination);

  const experiment = await loadExperimentConfig(path.join(destination, 'experiment.yaml'));
  assert.ok(experiment.config.dataset.path !== undefined);
  assert.equal(experiment.config.dataset.path, './dataset');
  assert.equal(experiment.config.runtime.platform, 'native');
  const dataset = await loadDataset(path.resolve(experiment.root, experiment.config.dataset.path));
  const selections = expandExperiment(experiment, dataset);
  assert.equal(selections.length, 1);
  const selection = selections[0]!;
  const plan = resolveRunPlan({dataset, experiment, selection, runtimePlatform: 'linux/arm64'});
  assert.equal(plan.runtime.platform, 'linux/arm64');
  assert.equal(plan.selection.treatment, 'baseline');
  assert.equal(plan.agent.adapter, 'claude-code');
  assert.equal(plan.agent.model, 'claude-sonnet-4-6');
  assert.equal(plan.role_player, undefined);
  assert.equal(plan.evaluation.judge, undefined);

  for (const [content, passes] of [
    ['hello, forge!\n', true],
    ['hello, forge!', false],
    ['hello, forge!\n\n', false],
    ['hello, forge!\r\n', false],
    ['hello, forge!\nextra', false],
  ] as const) {
    const workspace = createMemoryWorkspace({'hello.txt': content});
    workspace.seal();
    const evidence = await collectWorkspaceEvidence(workspace.readonly, plan.evaluation.checks);
    assert.equal(runWorkspaceChecks(plan.evaluation.checks, evidence).every(({passed}) => passed),
      passes, JSON.stringify(content));
  }
});

it('refuses to overwrite existing directories or files without changing them', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-quickstart-existing-'));
  context.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'existing');
  await mkdir(directory);
  const marker = path.join(directory, 'keep.txt');
  await writeFile(marker, 'keep these bytes\n');
  const file = path.join(root, 'existing-file');
  await writeFile(file, 'also keep these bytes\n');

  for (const destination of [directory, file]) {
    await assert.rejects(run(process.execPath, [generator, destination]),
      /Refusing to overwrite existing path/);
  }
  assert.deepEqual(await readdir(directory), ['keep.txt']);
  assert.equal(await readFile(marker, 'utf8'), 'keep these bytes\n');
  assert.equal(await readFile(file, 'utf8'), 'also keep these bytes\n');
});
