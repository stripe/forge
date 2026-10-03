import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

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
  it('accepts Codex hook trust, rejects it for Claude, and treats omitted/native policies as duplicate coordinates', () => {
    const yaml = experimentConfigYaml();
    const codex = yaml.replace('adapter: claude-code', 'adapter: codex');
    for (const hook_trust of ['native', 'automation']) {
      const config = parseExperimentConfigYaml(codex.replace('adapter: codex', `adapter: codex\n      hook_trust: ${hook_trust}`));
      assert.equal(config.matrix.agents[0]!.hook_trust, hook_trust);
    }
    assert.throws(() => parseExperimentConfigYaml(yaml.replace('adapter: claude-code', 'adapter: claude-code\n      hook_trust: native')), /hook_trust/);
    assert.throws(() => parseExperimentConfigYaml(codex.replace('adapter: codex', 'adapter: codex\n      hook_trust: unknown')), /Invalid enum/);
    const config = parseExperimentConfigYaml(codex);
    const duplicate = {...config, matrix: {...config.matrix, agents: [config.matrix.agents[0]!,
      {...config.matrix.agents[0]!, hook_trust: 'native'}]}};
    // Exercise the strict JSON boundary through YAML, retaining authored defaults.
    assert.throws(() => parseExperimentConfigYaml(JSON.stringify(duplicate)), /unique/);
  });
  it('preserves multi-turn prompt semantics and materializes defaults', () => {
    const definition = parseEvalCaseYaml(`
schema_version: 1
id: payments/checkout
task: "  Help the user integrate Checkout.  "
initial_prompt: "  I need help with Checkout.  "
context: Existing integration
`);

    {
      const actual = definition;
      assert.ok(actual);
      assert.equal(actual.id, 'payments/checkout');
      assert.equal(actual.task, 'Help the user integrate Checkout.');
      assert.equal(actual.initial_prompt, 'I need help with Checkout.');
      assert.equal(actual.execution_mode, 'multi_turn');
      assert.deepEqual(actual.setup, []);
      assert.deepEqual(actual.success_guidelines, []);
    }
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
    {
      const actual = oneShot;
      assert.ok(actual);
      assert.equal(actual.initial_prompt, 'Create greeting.txt');
      assert.equal(actual.execution_mode, 'one_shot');
    }
    assert.equal(oneShot.task, undefined);

    assert.throws(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: smoke/invalid
execution_mode: one_shot
task: One
initial_prompt: Two
`), BenchmarkModelError);
  });

  it('bounds success guidelines to the persisted result contract', () => {
    assert.throws(() =>
      parseEvalCase({
        schema_version: 1,
        id: 'safe/oversized-guideline',
        task: 'Evaluate a bounded guideline.',
        execution_mode: 'multi_turn',
        setup: [],
        success_guidelines: ['x'.repeat(64 * 1024 + 1)],
      }), BenchmarkModelError);
  });

  it('strictly validates built-in setup payloads and rejects unknown actions', () => {
    {
      const actual = parseSetupStep({
        uses: 'forge/write',
        with: {target: 'src/config.json', source: {dataset_path: 'fixtures/a.json'}},
      });
      assert.ok(actual);
      assert.equal(actual.uses, 'forge/write');
    }
    assert.throws(() =>
      parseSetupStep({
        uses: 'acme/link-cli',
        with: {channel: 'stable'},
      }), /unknown setup action/);
    assert.throws(() =>
      parseSetupStep({
        uses: 'forge/command',
        with: {command: 'echo unsafe implicit shell'},
      }), BenchmarkModelError);
    assert.throws(() =>
      parseSetupStep({uses: 'forge/future', with: {}}), /unknown setup action/);
    assert.throws(() =>
      parseSetupStep({uses: 'not-namespaced', with: {}}), /namespaced/);
    assert.throws(() =>
      parseSetupStep({uses: 'forge/write@1', with: {}}), /without a version suffix/);
  });

  it('parses only latest-marketplace forge/plugin selections', () => {
    {
      const actual = parseSetupStep({
        uses: 'forge/plugin',
        with: {
          agents: {
            'claude-code': {
              plugin: 'stripe@claude-plugins-official',
              marketplace: 'anthropics/claude-plugins-official',
            },
          },
        },
      });
      assert.ok(actual);
      assert.equal(actual.uses, 'forge/plugin');
      const agents = actual.with.agents;
      assert.ok(agents && typeof agents === 'object' && !Array.isArray(agents));
      const claude = agents['claude-code'];
      assert.ok(claude && typeof claude === 'object' && !Array.isArray(claude));
      assert.equal(claude.plugin, 'stripe@claude-plugins-official');
      assert.equal(claude.marketplace, 'anthropics/claude-plugins-official');
    }

    for (const withValue of [
      {agents: {}},
      {
        agents: {
          'claude-code': {
            plugin: 'stripe',
            marketplace: 'example/catalog',
          },
        },
      },
      {
        agents: {
          'claude-code': {
            plugin: 'stripe@example',
            marketplace: 'https://github.com/example/catalog.git',
          },
        },
      },
      {
        agents: {
          'claude-code': {
            plugin: 'stripe@example',
            version: '0.9.2',
            marketplace: 'example/catalog',
          },
        },
      },
    ]) {
      assert.throws(() =>
        parseSetupStep({uses: 'forge/plugin', with: withValue}), BenchmarkModelError);
    }
  });

  it('rejects unsafe paths, unknown keys, malformed regex, and duplicate YAML keys', () => {
    assert.throws(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: ../escape
task: unsafe
`), /case ID/);
    assert.throws(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: safe/case
task: safe
typo: true
`), BenchmarkModelError);
    assert.throws(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: safe/case
task: safe
checks:
  file_checks:
    - file: output.txt
      contains: "["
`), /regular expression/);
    assert.throws(() =>
      parseEvalCaseYaml(`
schema_version: 1
id: safe/case
id: safe/other
task: safe
`), /Invalid eval case YAML/);
  });

  it('parses a checks-only experiment config without harness completion models', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    assert.equal(config.forge, undefined);
    assert.deepEqual(config.models, {});
    assert.deepEqual(config.treatments, {baseline: {setup: []}});
    {
      const actual = config.matrix;
      assert.ok(actual);
      assert.equal(actual.repetitions, 1);
      assert.equal(actual.retries, 0);
    }
    {
      const actual = 'resources' in config.runtime && config.runtime.resources;
      assert.ok(actual);
      assert.deepEqual(actual.memory_bytes, 4 * 1024 * 1024 * 1024);
      assert.equal(actual.cpu_count, 2);
      assert.equal(actual.process_count, 512);
    }
  });

  it('rejects an authored Forge package version', () => {
    assert.throws(() => parseExperimentConfigYaml(
      experimentConfigYaml().replace(
        'runtime:',
        'forge:\n  version: 0.1.0\nruntime:',
      ),
    ), BenchmarkModelError);
  });

  it('accepts a dataset location and rejects empty or unsafe locations', () => {
    const source = experimentConfigYaml();
    const config = parseExperimentConfigYaml(source.replace('dataset:', 'dataset:\n  path: ../dataset'));
    assert.equal(config.dataset.path, '../dataset');
    for (const location of ['""', '" "', '"bad\\0path"']) {
      assert.throws(() => parseExperimentConfigYaml(source.replace('dataset:', `dataset:\n  path: ${location}`)), BenchmarkModelError);
    }
  });

  it('accepts native Docker platform authoring', () => {
    const config = parseExperimentConfigYaml(
      experimentConfigYaml().replace('platform: linux/amd64', 'platform: native'),
    );
    assert.equal(config.runtime.platform, 'native');
  });

  it('rejects mutable baseline setup and undefined matrix treatments', () => {
    assert.throws(() =>
      parseExperimentConfigYaml(
        experimentConfigYaml(`
treatments:
  baseline:
    setup:
      - uses: forge/command
        with: {argv: [echo, changed]}
`),
      ), /baseline setup must be empty/);
    assert.throws(() =>
      parseExperimentConfigYaml(
        experimentConfigYaml().replace(
          'treatments: [baseline]',
          'treatments: [missing]',
        ),
      ), /undefined treatment/);
  });

  it('validates manifest hashes, path inventory, and uniqueness', () => {
    const manifest = {
      schema_version: 1,
      dataset: {id: 'forge-smoke', version: '2026.09.0'},
      cases: [{id: 'smoke/write', path: 'cases/smoke/write/eval.yaml'}],
      files: [{path: 'cases/smoke/write/eval.yaml', size: 100, sha256: HASH}],
    };
    {
      const actual = parseDatasetManifestJson(JSON.stringify(manifest));
      assert.ok(actual);
      assert.equal(actual.dataset.id, 'forge-smoke');
    }

    const invalidManifests = [
      {value: {...manifest, files: []}, reason: 'at least 1'},
      {
        value: {...manifest, files: [{...manifest.files[0], sha256: HASH.toUpperCase()}]},
        reason: 'lowercase SHA-256 hex',
      },
      {
        value: {...manifest, files: [{...manifest.files[0], path: 'fixtures/other.txt'}]},
        reason: 'case path must be present',
      },
      {
        value: {...manifest, files: [...manifest.files, {...manifest.files[0]}]},
        reason: 'path values must be unique',
      },
      {
        value: {
          ...manifest,
          cases: [...manifest.cases, {id: 'smoke/write', path: 'cases/other.yaml'}],
          files: [...manifest.files, {path: 'cases/other.yaml', size: 100, sha256: HASH}],
        },
        reason: 'id values must be unique',
      },
      {
        value: {
          ...manifest,
          cases: [...manifest.cases, {id: 'smoke/other', path: manifest.cases[0]!.path}],
        },
        reason: 'path values must be unique',
      },
    ];
    for (const {value, reason} of invalidManifests) {
      assert.throws(() => parseDatasetManifestJson(JSON.stringify(value)), (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error);
        assert.equal(error.code, 'invalid_manifest');
        assert.ok(error.message.includes(reason));
        return true;
      });
    }
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
