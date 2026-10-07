import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {it} from 'node:test';

import {expandExperiment, parseExperimentConfigYaml} from '../src/index.js';

it('expands the README grouped matrix into its documented selections', async () => {
  const readme = await readFile('README.md', 'utf8');
  const match = /<!-- grouped-matrix:start -->\n```yaml\n([\s\S]*?)```\n<!-- grouped-matrix:end -->/.exec(readme);
  assert.ok(match?.[1], 'README grouped matrix example is present');

  const experiment = parseExperimentConfigYaml(`
id: examples/grouped-matrix
version: 0.1.0
dataset:
  id: grouped-matrix-docs
  version: 0.1.0
  manifest_sha256: sha256:${'0'.repeat(64)}
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

  const selections = expandExperiment(experiment);
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
