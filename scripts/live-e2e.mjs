#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readLiveConfiguration} from './live/configuration.mjs';
import {createFullSuite} from './live/suite.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuration = readLiveConfiguration(process.env, repositoryRoot);
const {mode, timeoutMs, dockerExecutable, resultsRoot, suiteId} = configuration;
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
const abort = (receivedSignal) => controller.abort(new Error(`Forge live suite received ${receivedSignal}.`));
const progress = (message) => process.stderr.write(`[forge live] ${message}...\n`);
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

let runtimeRoot;
try {
  let report;
  if (mode === 'setup') {
    const {runSetupIntegrationSuite} = await import('./live/setup.mjs');
    const setup = await runSetupIntegrationSuite({dockerExecutable, resultsRoot, suiteId, signal, progress});
    report = {verified: true, suite_id: suiteId, mode, setup};
  } else {
    runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-live-runtime-'));
    const modules = await Promise.all([
      import('../dist/index.js'), import('../dist/cli.js'), import('../dist/atif/index.js'),
      import('../dist/agents/claude-code/index.js'), import('../dist/agents/codex/index.js'),
      import('../dist/providers/anthropic/index.js'), import('../dist/runtime/docker/index.js'),
      import('../dist/testing/index.js'),
    ]);
    report = await createFullSuite(Object.assign({}, ...modules),
      {...configuration, runtimeRoot, signal, progress}).run();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
  if (runtimeRoot !== undefined) await fs.rm(runtimeRoot, {recursive: true, force: true});
}
