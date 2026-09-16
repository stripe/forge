#!/usr/bin/env node

import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

import {runCli} from '../dist/cli.js';
import {verifyCompletedRun} from '../dist/index.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

if (process.env.FORGE_LIVE_CLAUDE !== '1') {
  throw new Error(
    'Live Claude execution may be billable. Set FORGE_LIVE_CLAUDE=1 to acknowledge the model call.',
  );
}
const gatewaySelected = process.env.ANTHROPIC_BASE_URL !== undefined;
const requiredCredential = gatewaySelected
  ? 'ANTHROPIC_AUTH_TOKEN'
  : 'ANTHROPIC_API_KEY';
if (!process.env[requiredCredential]) {
  throw new Error(
    `${requiredCredential} is required for the live Claude quickstart${
      gatewaySelected ? ' when ANTHROPIC_BASE_URL is set' : ''
    }.`,
  );
}

const runId = optionalEnvironment('FORGE_LIVE_RUN_ID') ??
  `live-quickstart-${randomUUID()}`;
const resultsRoot = path.resolve(
  repositoryRoot,
  optionalEnvironment('FORGE_LIVE_RESULTS_ROOT') ?? 'results/live',
);
const controller = new AbortController();
const abort = (signal) => {
  if (!controller.signal.aborted) {
    controller.abort(new Error(`Live Claude quickstart received ${signal}.`));
  }
};
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

let stdout = '';
let stderr = '';
let exitCode;
try {
  exitCode = await runCli(
    [
      'run',
      '--profile',
      path.join(repositoryRoot, 'examples', 'quickstart', 'profile.yaml'),
      '--case-file',
      path.join(
        repositoryRoot,
        'examples',
        'quickstart',
        'dataset',
        'cases',
        'examples',
        'hello-file.yaml',
      ),
      '--agent',
      'claude-code',
      '--model',
      'claude-sonnet-4-6',
      '--output',
      resultsRoot,
      '--run-id',
      runId,
    ],
    {
      cwd: repositoryRoot,
      signal: controller.signal,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
        process.stderr.write(text);
      },
    },
  );
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}

if (exitCode !== 0) {
  throw new Error(
    `Live Claude quickstart failed with exit code ${exitCode}.${
      stderr ? ' See the preceding Forge diagnostic.' : ''
    }`,
  );
}

let summary;
try {
  summary = JSON.parse(stdout);
} catch (error) {
  throw new Error('Live Claude quickstart returned invalid JSON.', {cause: error});
}
if (
  summary === null ||
  typeof summary !== 'object' ||
  typeof summary.location !== 'string' ||
  summary.run_id !== runId
) {
  throw new Error('Live Claude quickstart returned an invalid run summary.');
}

const completed = await verifyCompletedRun(summary.location);
if (completed.result.evaluation.status !== 'passed') {
  throw new Error(
    `Live Claude quickstart completed with evaluation status ${completed.result.evaluation.status}. Result: ${completed.location}`,
  );
}
if (completed.result.evidence.completeness === 'fallback') {
  throw new Error(
    `Live Claude quickstart used fallback rather than native session evidence. Result: ${completed.location}`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      authentication_mode: gatewaySelected ? 'gateway' : 'direct_anthropic',
      evidence_completeness: completed.result.evidence.completeness,
      evidence_warnings: completed.result.evidence.warnings,
      location: completed.location,
      model: completed.result.agent.model,
      provider: completed.result.agent.provider,
      run_id: completed.runId,
      score: completed.result.evaluation.score,
      status: completed.result.evaluation.status,
      verified: true,
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
