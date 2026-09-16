#!/usr/bin/env node

import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  expandExperiment,
  loadBenchmarkProfile,
  loadDataset,
  resolveRunPlan,
} from '../dist/index.js';
import {createDockerRuntimeAdapter} from '../dist/runtime/docker/index.js';
import {assertRuntimeAdapterConforms} from '../dist/testing/index.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const timeoutMs = positiveIntegerEnvironment(
  'FORGE_LIVE_TIMEOUT_MS',
  20 * 60 * 1000,
);
const dockerExecutable = optionalEnvironment('FORGE_DOCKER_EXECUTABLE');
const controller = new AbortController();
const signal = AbortSignal.any([
  controller.signal,
  AbortSignal.timeout(timeoutMs),
]);
const abort = (receivedSignal) => {
  if (!controller.signal.aborted) {
    controller.abort(
      new Error(`Live Docker conformance received ${receivedSignal}.`),
    );
  }
};
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

process.stderr.write(
  'Forge live Docker conformance: this builds and starts the real image, but makes no model-provider call.\n',
);

const [dataset, profile] = await Promise.all([
  loadDataset(path.join(repositoryRoot, 'examples', 'quickstart', 'dataset')),
  loadBenchmarkProfile(
    path.join(repositoryRoot, 'examples', 'quickstart', 'profile.yaml'),
  ),
]);
const selection = expandExperiment(profile)[0];
if (selection === undefined) {
  throw new Error('The quickstart profile contains no run selection.');
}
const plan = resolveRunPlan({dataset, profile, selection});
const adapter = createDockerRuntimeAdapter({
  ...(dockerExecutable === undefined ? {} : {dockerExecutable}),
});
const runId = `docker-conformance-${randomUUID()}`;

let report;
try {
  report = await assertRuntimeAdapterConforms(
    adapter,
    {
      runId,
      plan,
      environment: {variables: {}, credentials: {}},
      requirements: {executables: [], stateDirectories: []},
      signal,
    },
    {
      probePath: '.forge-conformance/live-docker.bin',
      probeBody: Buffer.from('forge-live-docker\n', 'utf8'),
    },
  );
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}

process.stdout.write(
  `${JSON.stringify(
    {
      adapter: {id: adapter.id, version: adapter.version},
      model_provider_called: false,
      platform: plan.runtime.platform,
      run_id: report.runtimeId,
      state_directory_ids: report.stateDirectoryIds,
      valid: true,
    },
    null,
    2,
  )}\n`,
);

function optionalEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain a NUL byte.`);
  }
  return value;
}

function positiveIntegerEnvironment(name, fallback) {
  const value = optionalEnvironment(name);
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a safe integer.`);
  }
  return parsed;
}
