import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {it} from 'node:test';

import {expandExperiment, loadDataset, parseExperimentConfigYaml} from '../src/index.js';

it('expands the authoring guide grouped matrix into its documented selections', async (context) => {
  const authoringGuide = await readFile('docs/authoring.md', 'utf8');
  const match = /<!-- grouped-matrix:start -->\n```yaml\n([\s\S]*?)```\n<!-- grouped-matrix:end -->/.exec(authoringGuide);
  assert.ok(match?.[1], 'authoring guide grouped matrix example is present');

  const root = await mkdtemp(path.join(tmpdir(), 'forge-grouped-matrix-docs-'));
  context.after(() => rm(root, {recursive: true, force: true}));
  const cases = [
    {id: 'examples/payment', path: 'cases/examples/payment.case.yaml'},
    {id: 'examples/marketplace', path: 'cases/examples/marketplace/case.yaml'},
  ];
  const files = [];
  for (const entry of cases) {
    const body = JSON.stringify({id: entry.id, initial_prompt: 'Complete the task.',
      execution_mode: 'one_shot', setup: [], judging_criteria: []});
    await mkdir(path.dirname(path.join(root, entry.path)), {recursive: true});
    await writeFile(path.join(root, entry.path), body);
    files.push({path: entry.path, size: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex')});
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    dataset: {id: 'grouped-matrix-docs', version: '0.1.0'},
    cases: cases.map(({path}) => path), files,
  }));
  const dataset = await loadDataset(root);

  const experiment = parseExperimentConfigYaml(`
id: examples/grouped-matrix
version: 0.1.0
dataset:
  id: grouped-matrix-docs
  version: 0.1.0
  manifest_sha256: ${dataset.manifestSha256}
runtime:
  adapter: docker
  image:
    kind: forge
  platform: linux/amd64
models: {}
treatments:
  baseline:
    setup: []
  payment-plugin:
    setup: []
  marketplace-plugin:
    setup: []
${match[1]}`);

  const selections = expandExperiment(experiment, dataset);
  assert.equal(selections.length, 12);
  assert.deepEqual(
    new Set(selections.map(({agent}) => `${agent.adapter}/${agent.provider}`)),
    new Set(['claude-code/anthropic']),
  );
  assert.deepEqual(
    selections.map(({case_id, treatment, agent, repetition}) =>
      `${case_id}|${treatment}|${agent.model}|${repetition}`,
    ),
    [
      'examples/payment|baseline|claude-sonnet-4-6|0',
      'examples/payment|baseline|claude-sonnet-4-6|1',
      'examples/payment|baseline|claude-opus-4-6|0',
      'examples/payment|baseline|claude-opus-4-6|1',
      'examples/payment|payment-plugin|claude-sonnet-4-6|0',
      'examples/payment|payment-plugin|claude-sonnet-4-6|1',
      'examples/payment|payment-plugin|claude-opus-4-6|0',
      'examples/payment|payment-plugin|claude-opus-4-6|1',
      'examples/marketplace|baseline|claude-opus-4-6|0',
      'examples/marketplace|baseline|claude-opus-4-6|1',
      'examples/marketplace|marketplace-plugin|claude-opus-4-6|0',
      'examples/marketplace|marketplace-plugin|claude-opus-4-6|1',
    ],
  );
});
