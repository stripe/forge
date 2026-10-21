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
 * Compare two parsed manifests of one dataset. A case whose definition or
 * fixtures changed needs a new case version; any case version or membership
 * change needs a new dataset version.
 */
export function datasetVersionViolations(baseline, candidate) {
  const violations = [];
  if (baseline.dataset.id !== candidate.dataset.id) {
    violations.push(
      `dataset ID changed from ${baseline.dataset.id} to ${candidate.dataset.id}; add it as a new dataset instead.`,
    );
  }
  const baselineCases = new Map(
    baseline.cases.map((entry) => [entry.id, entry]),
  );
  const candidateCases = new Map(
    candidate.cases.map((entry) => [entry.id, entry]),
  );
  let casesChanged = baselineCases.size !== candidateCases.size;
  for (const [id, entry] of candidateCases) {
    const previous = baselineCases.get(id);
    if (previous === undefined || previous.version !== entry.version) {
      casesChanged = true;
    } else if (caseContentKey(previous) !== caseContentKey(entry)) {
      violations.push(
        `case ${id} changed without a version bump (still ${entry.version}).`,
      );
    }
  }
  if (casesChanged && baseline.dataset.version === candidate.dataset.version) {
    violations.push(
      `case versions or membership changed, so dataset version ${candidate.dataset.version} must change.`,
    );
  }
  return violations;
}

function caseContentKey({ path: casePath, size, sha256, files }) {
  const fixtures = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    .map((file) => [file.path, file.size, file.sha256]);
  return JSON.stringify([casePath, size, sha256, fixtures]);
}

/** Read each dataset's manifest at the merge-base with `baseRef`, if it exists. */
export function gitBaselineReader({ root, baseRef, parseDatasetManifestJson }) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
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
    const { loadDataset, parseDatasetManifestJson } = await import(
      '../dist/index.js'
    );
    const result = await checkRepositoryCases({
      root: repositoryRoot,
      loadDataset,
      readBaselineManifest: gitBaselineReader({
        root: repositoryRoot,
        baseRef: values.base,
        parseDatasetManifestJson,
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
