import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {BenchmarkModelError} from './errors.js';
import {
  parseExperimentConfigYaml,
  parseDatasetManifestJson,
  parseEvalCase,
  parseEvalCaseYaml,
  parseSetupStep,
} from './parse.js';

const HASH = 'a'.repeat(64);

describe('public benchmark parsing', () => {
  it('preserves multi-turn prompt semantics and materializes defaults', () => {
    const definition = parseEvalCaseYaml(`
schema_version: 1
id: payments/checkout
task: "  Help the user integrate Checkout.  "
initial_prompt: "  I need help with Checkout.  "
context: Existing integration
`);

    expect(definition).toMatchObject({
      id: 'payments/checkout',
      task: 'Help the user integrate Checkout.',
      initial_prompt: 'I need help with Checkout.',
      execution_mode: 'multi_turn',
      setup: [],
      success_guidelines: [],
    });
  });

  it('accepts exactly one effective prompt in one-shot mode', () => {
    const oneShot = parseEvalCaseYaml(`
schema_version: 1
id: smoke/write-file
execution_mode: one_shot
initial_prompt: Create greeting.txt
checks:
  files_created: [greeting.txt]
`);
    expect(oneShot).toMatchObject({
      initial_prompt: 'Create greeting.txt',
      execution_mode: 'one_shot',
    });
    expect(oneShot.task).toBeUndefined();

    expect(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: smoke/invalid
execution_mode: one_shot
task: One
initial_prompt: Two
`),
    ).toThrow(BenchmarkModelError);
  });

  it('bounds success guidelines to the persisted result contract', () => {
    expect(() =>
      parseEvalCase({
        schema_version: 1,
        id: 'safe/oversized-guideline',
        task: 'Evaluate a bounded guideline.',
        execution_mode: 'multi_turn',
        setup: [],
        success_guidelines: ['x'.repeat(64 * 1024 + 1)],
      }),
    ).toThrow(BenchmarkModelError);
  });

  it('strictly validates built-in setup payloads and extension identifiers', () => {
    expect(
      parseSetupStep({
        uses: 'forge/write@1',
        with: {target: 'src/config.json', source: {dataset_path: 'fixtures/a.json'}},
      }),
    ).toMatchObject({uses: 'forge/write@1'});
    expect(
      parseSetupStep({
        uses: 'acme/link-cli@1',
        with: {channel: 'stable'},
      }),
    ).toEqual({
      uses: 'acme/link-cli@1',
      with: {channel: 'stable'},
    });
    expect(() =>
      parseSetupStep({
        uses: 'forge/command@1',
        with: {command: 'echo unsafe implicit shell'},
      }),
    ).toThrow(BenchmarkModelError);
    expect(() =>
      parseSetupStep({uses: 'forge/future@2', with: {}}),
    ).toThrow(/reserved forge namespace/);
    expect(() =>
      parseSetupStep({uses: 'not-versioned', with: {}}),
    ).toThrow(/namespaced/);
  });

  it('rejects unsafe paths, unknown keys, malformed regex, and duplicate YAML keys', () => {
    expect(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: ../escape
task: unsafe
`),
    ).toThrow(/case ID/);
    expect(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: safe/case
task: safe
typo: true
`),
    ).toThrow(BenchmarkModelError);
    expect(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: safe/case
task: safe
checks:
  file_checks:
    - file: output.txt
      contains: "["
`),
    ).toThrow(/regular expression/);
    expect(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: safe/case
id: safe/other
task: safe
`),
    ).toThrow(/Invalid eval case YAML/);
  });

  it('parses a checks-only experiment config without harness completion models', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    expect(config.models).toEqual({});
    expect(config.treatments).toEqual({baseline: {setup: []}});
    expect(config.matrix).toMatchObject({repetitions: 1, retries: 0});
    expect(config.runtime.resources).toMatchObject({
      memory_bytes: 4 * 1024 * 1024 * 1024,
      cpu_count: 2,
      process_count: 512,
    });
  });

  it('rejects mutable baseline setup and undefined matrix treatments', () => {
    expect(() =>
      parseExperimentConfigYaml(
        experimentConfigYaml(`
treatments:
  baseline:
    setup:
      - uses: forge/command@1
        with: {argv: [echo, changed]}
`),
      ),
    ).toThrow(/baseline setup must be empty/);
    expect(() =>
      parseExperimentConfigYaml(
        experimentConfigYaml().replace(
          'treatments: [baseline]',
          'treatments: [missing]',
        ),
      ),
    ).toThrow(/undefined treatment/);
  });

  it('validates manifest hashes, path inventory, and uniqueness', () => {
    expect(
      parseDatasetManifestJson(
        JSON.stringify({
          schema_version: 1,
          dataset: {id: 'forge-smoke', version: '2026.09.0'},
          cases: [{id: 'smoke/write', path: 'cases/smoke/write/eval.yaml'}],
          files: [
            {path: 'cases/smoke/write/eval.yaml', size: 100, sha256: HASH},
          ],
        }),
      ),
    ).toMatchObject({dataset: {id: 'forge-smoke'}});
    expect(() =>
      parseDatasetManifestJson(
        JSON.stringify({
          schema_version: 1,
          dataset: {id: 'forge-smoke', version: '1'},
          cases: [{id: 'smoke/write', path: 'cases/smoke/write/eval.yaml'}],
          files: [],
        }),
      ),
    ).toThrow(BenchmarkModelError);
  });
});

function experimentConfigYaml(extra = ''): string {
  return `
schema_version: 1
id: forge-smoke
version: 2026.09.0
dataset:
  id: forge-smoke
  version: 2026.09.0
  manifest_sha256: sha256:${HASH}
forge:
  version: 0.1.0
runtime:
  adapter: docker
  image: {kind: forge}
  platform: linux/amd64
matrix:
  cases: [smoke/write]
  treatments: [baseline]
  agents:
    - adapter: claude-code
      provider: anthropic
      model: claude-sonnet-4-6
${extra}`;
}
