#!/usr/bin/env node

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// These checked-in examples are the repository's authored dataset roots.
export const EXAMPLE_DATASET_ROOTS = Object.freeze([
  'examples/quickstart/dataset',
  'examples/multi-turn/dataset',
]);

export async function checkRepositoryCases({root, loadDataset}) {
  const errors = [];
  let cases = 0;
  for (const relativeRoot of EXAMPLE_DATASET_ROOTS) {
    try {
      const dataset = await loadDataset(path.join(root, relativeRoot));
      cases += dataset.cases.size;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Dataset validation failed.';
      errors.push(`${relativeRoot}: ${message}`);
    }
  }
  return {datasets: EXAMPLE_DATASET_ROOTS.length, cases, errors};
}

if (process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {loadDataset} = await import('../dist/index.js');
    const result = await checkRepositoryCases({root: repositoryRoot, loadDataset});
    if (result.errors.length > 0) {
      for (const error of result.errors) process.stderr.write(`cases: ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`cases: checked ${result.datasets} datasets and ${result.cases} cases\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Dataset validation failed.';
    process.stderr.write(`cases: ${message}\n`);
    process.exitCode = 1;
  }
}
