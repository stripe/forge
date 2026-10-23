#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Validate checked-in dataset snapshots and harness test inputs.
export const REPOSITORY_DATASET_ROOTS = Object.freeze([
  'test/fixtures/one-shot/dataset',
  'test/fixtures/multi-turn/dataset',
  'datasets/stripe-integration-public-evals',
]);

export async function checkRepositoryCases({
  root,
  loadDataset,
  readBaselineManifest,
}) {
  const errors = [];
  let cases = 0;
  for (const relativeRoot of REPOSITORY_DATASET_ROOTS) {
    try {
      const dataset = await loadDataset(path.join(root, relativeRoot));
      cases += dataset.cases.size;
      const baseline = readBaselineManifest(relativeRoot);
      if (baseline !== undefined) {
        for (const violation of datasetVersionViolations(
          baseline,
          dataset.manifest,
        ))
          errors.push(`${relativeRoot}: ${violation}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Dataset validation failed.';
      errors.push(`${relativeRoot}: ${message}`);
    }
  }
  return { datasets: REPOSITORY_DATASET_ROOTS.length, cases, errors };
}

/**
 * Compare two parsed manifests of one dataset. Any case version or membership
 * change needs a new dataset version; case content is versioned by its owner.
 */
export function datasetVersionViolations(baseline, candidate) {
  const violations = [];
  if (baseline.dataset.id !== candidate.dataset.id) {
    violations.push(
      `dataset ID changed from ${baseline.dataset.id} to ${candidate.dataset.id}; add it as a new dataset instead.`,
    );
  }
  const baselineVersions = new Map(
    baseline.cases.map(({ id, version }) => [id, version]),
  );
  const casesChanged =
    baselineVersions.size !== candidate.cases.length ||
    candidate.cases.some(
      ({ id, version }) => baselineVersions.get(id) !== version,
    );
  if (casesChanged && baseline.dataset.version === candidate.dataset.version) {
    violations.push(
      `case versions or membership changed, so dataset version ${candidate.dataset.version} must change.`,
    );
  }
  return violations;
}

/** Read each dataset's manifest at the merge-base with `baseRef`, if it exists. */
export function gitBaselineReader({
  root,
  baseRef,
  parseDatasetManifestJson,
  maxManifestBytes,
}) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: maxManifestBytes,
    });
  const mergeBase = git('merge-base', baseRef, 'HEAD').trim();
  return (relativeRoot) => {
    const manifestPath = `${relativeRoot}/manifest.json`;
    try {
      git('cat-file', '-e', `${mergeBase}:${manifestPath}`);
    } catch {
      return undefined; // New dataset: nothing to compare against.
    }
    const source = git('show', `${mergeBase}:${manifestPath}`);
    try {
      return parseDatasetManifestJson(source);
    } catch {
      process.stdout.write(
        `cases: ${manifestPath} at ${baseRef} uses an older manifest format; skipping version comparison.\n`,
      );
      return undefined;
    }
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      // `pnpm check:cases -- --base <ref>` forwards the separator literally.
      args: process.argv.slice(2).filter((arg) => arg !== '--'),
      options: { base: { type: 'string', default: 'origin/main' } },
    });
    const {
      loadDataset,
      parseDatasetManifestJson,
      MAX_DATASET_MANIFEST_BYTES,
    } = await import('../dist/index.js');
    const result = await checkRepositoryCases({
      root: repositoryRoot,
      loadDataset,
      readBaselineManifest: gitBaselineReader({
        root: repositoryRoot,
        baseRef: values.base,
        parseDatasetManifestJson,
        maxManifestBytes: MAX_DATASET_MANIFEST_BYTES,
      }),
    });
    if (result.errors.length > 0) {
      for (const error of result.errors)
        process.stderr.write(`cases: ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `cases: checked ${result.datasets} datasets and ${result.cases} cases against ${values.base}\n`,
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Dataset validation failed.';
    process.stderr.write(`cases: ${message}\n`);
    process.exitCode = 1;
  }
}
