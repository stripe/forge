#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import * as path from 'node:path';

const usage = 'Usage: node docs/create-quickstart.mjs <new-directory>';
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`${usage}\n`);
} else if (args.length !== 1 || args[0].length === 0) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
} else {
  const destination = path.resolve(args[0]);
  let created = false;
  try {
    // Claim a new directory before writing anything; existing paths are untouched.
    await mkdir(destination);
    created = true;
    const casePath = 'cases/examples/hello-file.case.yaml';
    const caseBytes = Buffer.from(String.raw`id: examples/hello-file
display_name: Hello file
initial_prompt: Create hello.txt containing exactly "hello, forge!" followed by a newline.
execution_mode: one_shot
setup: []
judging_criteria: []
checks:
  files_created:
    - hello.txt
  file_checks:
    - file: hello.txt
      exists: true
      contains: '^hello, forge!\n(?![\s\S])'
`, 'utf8');
    const manifestBytes = Buffer.from(`${JSON.stringify({
      dataset: {id: 'forge-quickstart', version: '0.1.0'},
      cases: [casePath],
      files: [{path: casePath, size: caseBytes.byteLength, sha256: sha256(caseBytes)}],
    }, null, 2)}\n`, 'utf8');
    const experiment = `id: examples/quickstart
version: 0.1.0
dataset:
  path: ./dataset
  id: forge-quickstart
  version: 0.1.0
  manifest_sha256: sha256:${sha256(manifestBytes)}
runtime:
  adapter: docker
  image:
    kind: forge
  platform: native
  resources:
    memory_bytes: 4294967296
    cpu_count: 2
    process_count: 512
models: {}
treatments:
  baseline:
    setup: []
matrix:
  cases:
    - ${casePath}
  treatments:
    - baseline
  agents:
    - adapter: claude-code
      provider: anthropic
      model: claude-sonnet-4-6
  repetitions: 1
  retries: 0
limits:
  run_timeout_ms: 900000
`;
    const datasetRoot = path.join(destination, 'dataset');
    const caseFile = path.join(datasetRoot, ...casePath.split('/'));
    await mkdir(path.dirname(caseFile), {recursive: true});
    await writeFile(caseFile, caseBytes, {flag: 'wx'});
    await writeFile(path.join(datasetRoot, 'manifest.json'), manifestBytes, {flag: 'wx'});
    await writeFile(path.join(destination, 'experiment.yaml'), experiment, {flag: 'wx'});
    process.stdout.write(`Created ${destination}\n`);
  } catch (error) {
    if (created) await rm(destination, {recursive: true, force: true});
    const message = !created && error.code === 'EEXIST'
      ? `Refusing to overwrite existing path: ${destination}`
      : error.message;
    process.stderr.write(`quickstart: ${message}\n`);
    process.exitCode = 1;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
