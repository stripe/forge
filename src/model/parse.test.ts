import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { BenchmarkModelError } from './errors.ts';
import { getMatrixGroups } from './matrix.ts';
import {
  parseDatasetManifestJson,
  parseEvalCase,
  parseEvalCaseYaml,
  parseExperimentConfig,
  parseExperimentConfigYaml,
  parseSetupStep,
} from './parse.ts';

describe('public benchmark parsing', () => {
  it('requires an explicit lowercase kebab-case authored identity and version', () => {
    const version = '0.1.0';
    for (const id of ['task', 'suite/task', 'team-name/task-2']) {
      assert.equal(
        parseEvalCase({ id, version, task: 'Complete the task.' }).id,
        id,
      );
    }
    assert.throws(
      () => parseEvalCase({ version, task: 'Complete the task.' }),
      BenchmarkModelError,
    );
    assert.throws(
      () => parseEvalCase({ id: 'suite/task', task: 'Complete the task.' }),
      /Required/,
    );
    assert.throws(
      () =>
        parseEvalCase({
          id: 'suite/task',
          version,
          fixtures: ['fixtures/a.txt'],
          task: 'Complete the task.',
        }),
      /Unrecognized key/,
    );
    for (const id of [
      'Suite/task',
      'suite_name/task',
      'suite/task.v2',
      'suite/task--2',
    ]) {
      assert.throws(
        () => parseEvalCase({ id, version, task: 'Complete the task.' }),
        /case ID/,
      );
    }
  });
  it('uses the installed grammar and rejects removed authored schema fields', () => {
    const definition = {
      id: 'sample/task',
      version: '0.1.0',
      task: 'Complete the task.',
    };
    assert.equal(
      Object.hasOwn(parseEvalCase(definition), 'schema_version'),
      false,
    );
    assert.throws(
      () => parseEvalCase({ ...definition, schema_version: 1 }),
      BenchmarkModelError,
    );
    const manifest = {
      dataset: { id: 'sample', version: '1' },
      cases: [
        {
          id: 'sample/task',
          version: '0.1.0',
          path: 'cases/sample/task.case.yaml',
        },
      ],
    };
    assert.equal(
      Object.hasOwn(
        parseDatasetManifestJson(JSON.stringify(manifest)),
        'schema_version',
      ),
      false,
    );
    assert.throws(
      () =>
        parseDatasetManifestJson(
          JSON.stringify({ ...manifest, schema_version: 1 }),
        ),
      BenchmarkModelError,
    );
    assert.equal(
      Object.hasOwn(
        parseExperimentConfigYaml(experimentConfigYaml()),
        'schema_version',
      ),
      false,
    );
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          `schema_version: 1\n${experimentConfigYaml()}`,
        ),
      BenchmarkModelError,
    );
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          experimentConfigYaml().replace(
            '  version: 2026.09.0\nruntime:',
            `  version: 2026.09.0\n  manifest_sha256: sha256:${'a'.repeat(64)}\nruntime:`,
          ),
        ),
      /Unrecognized key.*manifest_sha256/,
    );
  });

  it('accepts Codex hook trust, rejects it for Claude, and treats omitted/native policies as duplicate coordinates', () => {
    const yaml = experimentConfigYaml();
    const codex = yaml.replace('adapter: claude-code', 'adapter: codex');
    for (const hook_trust of ['native', 'automation']) {
      const config = parseExperimentConfigYaml(
        codex.replace(
          'adapter: codex',
          `adapter: codex\n      hook_trust: ${hook_trust}`,
        ),
      );
      assert.equal(
        getMatrixGroups(config.matrix)[0]!.agents[0]!.hook_trust,
        hook_trust,
      );
    }
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          yaml.replace(
            'adapter: claude-code',
            'adapter: claude-code\n      hook_trust: native',
          ),
        ),
      /hook_trust/,
    );
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          codex.replace(
            'adapter: codex',
            'adapter: codex\n      hook_trust: unknown',
          ),
        ),
      /Invalid enum/,
    );
    const config = parseExperimentConfigYaml(codex);
    const agents = getMatrixGroups(config.matrix)[0]!.agents;
    const duplicate = {
      ...config,
      matrix: {
        ...config.matrix,
        agents: [agents[0]!, { ...agents[0]!, hook_trust: 'native' }],
      },
    };
    // Exercise the strict JSON boundary through YAML, retaining authored defaults.
    assert.throws(
      () => parseExperimentConfigYaml(JSON.stringify(duplicate)),
      /unique/,
    );
  });
  it('preserves multi-turn prompt semantics and materializes defaults', () => {
    const definition = parseEvalCaseYaml(`
id: payments/checkout
version: 0.1.0
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
      assert.deepEqual(actual.judging_criteria, []);
    }
  });

  it('accepts judging criteria and rejects the former case field', () => {
    const definition = {
      id: 'sample/criteria',
      version: '0.1.0',
      task: 'Complete the task.',
      judging_criteria: [
        {
          value: 'Returns HTTP 400 for invalid input.',
        },
      ],
      checks: { files_created: ['answer.txt'] },
    };
    const parsed = parseEvalCase(definition);
    assert.deepEqual(
      parsed.judging_criteria,
      definition.judging_criteria.map((criterion) => ({
        ...criterion,
        requirement_level: 'SHOULD',
      })),
    );
    assert.deepEqual(parsed.checks, definition.checks);
    assert.throws(
      () => parseEvalCase({ ...definition, success_guidelines: [] }),
      BenchmarkModelError,
    );
    const { judging_criteria, ...withoutCriteria } = definition;
    assert.throws(
      () =>
        parseEvalCase({
          ...withoutCriteria,
          success_guidelines: judging_criteria,
        }),
      BenchmarkModelError,
    );
  });

  it('accepts exactly one effective prompt in one-shot mode', () => {
    const oneShot = parseEvalCaseYaml(`
id: smoke/write-file
version: 0.1.0
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

    assert.throws(
      () =>
        parseEvalCaseYaml(`
id: smoke/invalid
version: 0.1.0
execution_mode: one_shot
task: One
initial_prompt: Two
`),
      BenchmarkModelError,
    );
  });

  it('accepts classified criteria and repeatable labels while rejecting invalid scoring definitions', () => {
    const criteria = [
      {
        value: 'Correct answer',
        label: 'correctness',
      },
      {
        value: 'Read page A',
        label: 'source',
        requirement_level: 'OPTIONAL' as const,
      },
      {
        value: 'Read page B',
        label: 'source',
        requirement_level: 'OPTIONAL' as const,
      },
      { value: 'Unlabeled criterion' },
    ];
    assert.deepEqual(
      parseEvalCase({
        id: 'sample/task',
        version: '0.1.0',
        task: 'Answer',
        judging_criteria: criteria,
      }).judging_criteria,
      criteria.map((criterion) => ({
        ...criterion,
        requirement_level: criterion.requirement_level ?? 'SHOULD',
      })),
    );
    for (const invalid of [
      { value: '' },
      { value: '   ' },
      { value: 'x'.repeat(64 * 1024 + 1) },
      { value: 'a', label: '' },
      { value: 'a', label: 'Uppercase' },
      { value: 'a', label: 'two-words' },
      { value: 'a', label: '1' },
      { value: 'a', requirement_level: 'INVALID' },
      { value: 'a', id: 'correctness' },
    ]) {
      assert.throws(
        () =>
          parseEvalCase({
            id: 'sample/task',
            version: '0.1.0',
            task: 'Answer',
            judging_criteria: [{ ...invalid }],
          }),
        BenchmarkModelError,
      );
    }
    assert.throws(
      () =>
        parseEvalCase({
          id: 'sample/task',
          version: '0.1.0',
          task: 'Answer',
          judging_criteria: [
            {
              value: 'Read docs',
              requirement_level: 'OPTIONAL' as const,
            },
          ],
        }),
      /at least one judging criterion must be included in scoring/,
    );
  });

  it('bounds success criteria to the persisted result contract', () => {
    assert.throws(
      () =>
        parseEvalCase({
          id: 'safe/oversized-criterion',
          version: '0.1.0',
          task: 'Evaluate a bounded criterion.',
          execution_mode: 'multi_turn',
          setup: [],
          judging_criteria: [{ value: 'x'.repeat(64 * 1024 + 1) }],
        }),
      BenchmarkModelError,
    );
  });

  it('strictly validates built-in setup payloads and rejects unknown actions', () => {
    {
      const actual = parseSetupStep({
        uses: 'forge/write',
        with: {
          target: 'src/config.json',
          source: { dataset_path: 'fixtures/a.json' },
        },
      });
      assert.ok(actual);
      assert.equal(actual.uses, 'forge/write');
    }
    assert.throws(
      () =>
        parseSetupStep({
          uses: 'acme/link-cli',
          with: { channel: 'stable' },
        }),
      /unknown setup action/,
    );
    assert.throws(
      () =>
        parseSetupStep({
          uses: 'forge/command',
          with: { command: 'echo unsafe implicit shell' },
        }),
      BenchmarkModelError,
    );
    assert.throws(
      () => parseSetupStep({ uses: 'forge/future', with: {} }),
      /unknown setup action/,
    );
    assert.throws(
      () => parseSetupStep({ uses: 'not-namespaced', with: {} }),
      /namespaced/,
    );
    assert.throws(
      () => parseSetupStep({ uses: 'forge/write@1', with: {} }),
      /without a version suffix/,
    );
  });

  it('accepts only a bounded list of unique credential environment names', () => {
    const step = {
      uses: 'forge/credentials',
      with: { env: ['API_TOKEN', '_mixedCase2'] },
    };
    assert.deepEqual(parseSetupStep(step), step);
    for (const withValue of [
      {},
      { env: [] },
      { env: 'API_TOKEN' },
      { env: ['API_TOKEN', 'API_TOKEN'] },
      { env: [''] },
      { env: ['API_TOKEN=secret'] },
      { env: ['1TOKEN'] },
      { env: ['API-TOKEN'] },
      { env: [{ API_TOKEN: 'secret' }] },
      { env: ['API_TOKEN'], scope: 'setup' },
      { env: ['API_TOKEN'], value: 'secret' },
      { env: ['A'.repeat(256)] },
      { env: Array.from({ length: 129 }, (_, i) => `TOKEN_${i}`) },
    ]) {
      assert.throws(
        () => parseSetupStep({ uses: 'forge/credentials', with: withValue }),
        BenchmarkModelError,
      );
    }
  });

  it('parses registered plugin names without exposing native distribution fields', () => {
    const step = { uses: 'forge/plugin', with: { plugin: 'stripe' } };
    assert.deepEqual(parseSetupStep(step), step);
    for (const withValue of [
      {},
      { plugin: 'unknown' },
      { plugin: 'stripe@stripe' },
      { plugin: 'stripe', marketplace: 'stripe/ai' },
      { plugin: 'stripe', version: '1.0.0' },
      {
        agents: {
          'claude-code': {
            plugin: 'stripe@claude-plugins-official',
            marketplace: 'anthropics/claude-plugins-official',
          },
        },
      },
    ]) {
      assert.throws(
        () => parseSetupStep({ uses: 'forge/plugin', with: withValue }),
        BenchmarkModelError,
      );
    }
  });

  it('rejects unsafe paths, unknown keys, malformed regex, and duplicate YAML keys', () => {
    assert.throws(
      () =>
        parseEvalCaseYaml(`
id: ../escape
version: 0.1.0
task: unsafe
`),
      /case ID/,
    );
    assert.throws(
      () =>
        parseEvalCaseYaml(`
id: safe/case
version: 0.1.0
task: safe
typo: true
`),
      BenchmarkModelError,
    );
    assert.throws(
      () =>
        parseEvalCaseYaml(`
id: safe/case
version: 0.1.0
task: safe
checks:
  file_checks:
    - file: output.txt
      contains: "["
`),
      /regular expression/,
    );
    assert.throws(
      () =>
        parseEvalCaseYaml(`
id: safe/case
version: 0.1.0
id: safe/other
version: 0.1.0
task: safe
`),
      /Invalid eval case YAML/,
    );
  });

  it('parses a checks-only experiment config without harness completion models', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    assert.equal(config.forge, undefined);
    assert.deepEqual(config.models, {});
    assert.deepEqual(config.treatments, { baseline: { setup: [] } });
    {
      const actual = config.matrix;
      assert.ok(actual);
      assert.equal(actual.repetitions, 1);
      assert.equal(actual.retries, 0);
      assert.equal(Object.hasOwn(actual, 'groups'), false);
    }
    {
      const actual = 'resources' in config.runtime && config.runtime.resources;
      assert.ok(actual);
      assert.deepEqual(actual.memory_bytes, 4 * 1024 * 1024 * 1024);
      assert.equal(actual.cpu_count, 2);
      assert.equal(actual.process_count, 512);
    }
  });

  it('accepts named case files and nested case.yaml in flat and grouped matrices', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const group = getMatrixGroups(config.matrix)[0]!;
    const cases = [
      'cases/suite/payments-onetime.case.yaml',
      'cases/suite/connect-creator-fans/case.yaml',
      'cases/case.yaml',
    ];
    const flat = parseExperimentConfig({
      ...config,
      matrix: { ...group, cases },
    });
    const grouped = parseExperimentConfig({
      ...config,
      matrix: { groups: [{ ...group, cases }] },
    });
    assert.deepEqual(getMatrixGroups(flat.matrix)[0]!.cases, cases);
    assert.deepEqual(getMatrixGroups(grouped.matrix)[0]!.cases, cases);
  });

  it('rejects case IDs, non-case files and noncanonical paths as matrix case references', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const group = getMatrixGroups(config.matrix)[0]!;
    for (const casePath of [
      'smoke/write',
      'cases/suite/case',
      'cases/suite/case.yml',
      'cases/suite/ordinary.yaml',
      'cases/suite/.case.yaml',
      'fixtures/suite/case.yaml',
      '/cases/suite/case.yaml',
      '../cases/suite/case.yaml',
      './cases/suite/case.yaml',
      'cases/../suite/case.yaml',
      'cases//suite/case.yaml',
      'cases\\suite\\case.yaml',
    ]) {
      for (const matrix of [
        { ...group, cases: [casePath] },
        { groups: [{ ...group, cases: [casePath] }] },
      ]) {
        assert.throws(
          () => parseExperimentConfig({ ...config, matrix }),
          BenchmarkModelError,
        );
      }
    }
  });

  it('preserves grouped matrix axes and applies only global run policy defaults', () => {
    const flat = parseExperimentConfigYaml(experimentConfigYaml());
    const group = getMatrixGroups(flat.matrix)[0]!;
    const authored = {
      ...flat,
      matrix: {
        groups: [
          {
            cases: group.cases,
            treatments: group.treatments,
            agents: group.agents,
          },
        ],
      },
    };
    const before = structuredClone(authored);
    const parsed = parseExperimentConfig(authored);
    assert.deepEqual(parsed.matrix, {
      ...authored.matrix,
      repetitions: 1,
      retries: 0,
    });
    assert.equal(Object.hasOwn(parsed.matrix, 'cases'), false);
    assert.equal(Object.hasOwn(parsed.matrix, 'treatments'), false);
    assert.equal(Object.hasOwn(parsed.matrix, 'agents'), false);
    assert.deepEqual(authored, before);
    assert.notEqual(parsed.matrix.groups, authored.matrix.groups);
    const explicit = parseExperimentConfig({
      ...authored,
      matrix: {
        ...authored.matrix,
        repetitions: 3,
        retries: 2,
      },
    });
    assert.equal(explicit.matrix.repetitions, 3);
    assert.equal(explicit.matrix.retries, 2);
  });

  it('rejects missing, mixed, empty, inherited, and unknown matrix axes', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const { cases, treatments, agents } = getMatrixGroups(config.matrix)[0]!;
    const group = { cases, treatments, agents };
    const axes = {
      cases: group.cases,
      treatments: group.treatments,
      agents: group.agents,
    };
    const invalid: unknown[] = [
      {},
      { groups: [] },
      { groups: [axes], ...axes },
      { groups: [axes], extra: true },
      { groups: [{ ...axes, extra: true }] },
      { groups: [{ ...axes, repetitions: 2 }] },
      { groups: [{ ...axes, retries: 1 }] },
    ];
    for (const axis of ['cases', 'treatments', 'agents'] as const) {
      const missing = { ...axes };
      delete (missing as Partial<typeof axes>)[axis];
      invalid.push(
        missing,
        { ...axes, [axis]: [] },
        { groups: [missing] },
        { groups: [{ ...axes, [axis]: [] }] },
        { groups: [missing], [axis]: axes[axis] },
      );
    }
    for (const matrix of invalid) {
      assert.throws(
        () => parseExperimentConfig({ ...config, matrix }),
        BenchmarkModelError,
      );
    }
  });

  it('allows overlapping case paths when treatments or resolved agents differ', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const { cases, treatments, agents } = getMatrixGroups(config.matrix)[0]!;
    const group = { cases, treatments, agents };
    const groups = [
      group,
      { ...group, treatments: ['seeded'] },
      { ...group, agents: [{ ...group.agents[0]!, model: 'other-model' }] },
    ];
    const parsed = parseExperimentConfig({
      ...config,
      treatments: { ...config.treatments, seeded: { setup: [] } },
      matrix: { groups },
    });
    assert.equal(parsed.matrix.groups?.length, 3);
  });

  it('rejects overlapping resolved selections including the Codex native default', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const { cases, treatments, agents } = getMatrixGroups(config.matrix)[0]!;
    const group = { cases, treatments, agents };
    assert.throws(
      () =>
        parseExperimentConfig({
          ...config,
          matrix: {
            groups: [
              group,
              {
                ...group,
                cases: ['cases/smoke/other.case.yaml', ...group.cases],
              },
            ],
          },
        }),
      /duplicate resolved selections/,
    );
    const codex = {
      ...group,
      agents: [{ adapter: 'codex', provider: 'openai', model: 'gpt' }],
    };
    assert.throws(
      () =>
        parseExperimentConfig({
          ...config,
          matrix: {
            groups: [
              codex,
              {
                ...codex,
                agents: [{ ...codex.agents[0]!, hook_trust: 'native' }],
              },
            ],
          },
        }),
      /duplicate resolved selections/,
    );
    const distinctPolicy = parseExperimentConfig({
      ...config,
      matrix: {
        groups: [
          codex,
          {
            ...codex,
            agents: [{ ...codex.agents[0]!, hook_trust: 'automation' }],
          },
        ],
      },
    });
    assert.equal(distinctPolicy.matrix.groups?.length, 2);
    for (const axis of ['cases', 'treatments', 'agents'] as const) {
      assert.throws(
        () =>
          parseExperimentConfig({
            ...config,
            matrix: {
              groups: [{ ...group, [axis]: [...group[axis], ...group[axis]] }],
            },
          }),
        /unique/,
      );
    }
  });

  it('keeps omitted and native hook policies distinct for custom adapters', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const group = getMatrixGroups(config.matrix)[0]!;
    const implicit = {
      adapter: 'custom-agent',
      provider: 'custom-provider',
      model: 'model',
    };
    const native = { ...implicit, hook_trust: 'native' as const };
    const flat = parseExperimentConfig({
      ...config,
      matrix: {
        ...group,
        agents: [implicit, native],
      },
    });
    assert.deepEqual(getMatrixGroups(flat.matrix)[0]!.agents, [
      implicit,
      native,
    ]);
    const grouped = parseExperimentConfig({
      ...config,
      matrix: {
        groups: [
          { ...group, agents: [implicit] },
          { ...group, agents: [native] },
        ],
      },
    });
    assert.deepEqual(
      getMatrixGroups(grouped.matrix).map(({ agents }) => agents),
      [[implicit], [native]],
    );
  });

  it('validates treatment references and identifiers in every matrix group', () => {
    const config = parseExperimentConfigYaml(experimentConfigYaml());
    const { cases, treatments, agents } = getMatrixGroups(config.matrix)[0]!;
    const group = { cases, treatments, agents };
    for (const [treatment, message] of [
      ['missing', /undefined treatment/],
      ['unsafe/treatment', /safe identifiers/],
    ] as const) {
      assert.throws(
        () =>
          parseExperimentConfig({
            ...config,
            matrix: {
              groups: [
                group,
                {
                  ...group,
                  cases: ['cases/smoke/other.case.yaml'],
                  treatments: [treatment],
                },
              ],
            },
          }),
        message,
      );
    }
  });

  it('rejects an authored Forge package version', () => {
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          experimentConfigYaml().replace(
            'runtime:',
            'forge:\n  version: 0.1.0\nruntime:',
          ),
        ),
      BenchmarkModelError,
    );
  });

  it('accepts a dataset location and rejects empty or unsafe locations', () => {
    const source = experimentConfigYaml();
    const config = parseExperimentConfigYaml(
      source.replace('dataset:', 'dataset:\n  path: ../dataset'),
    );
    assert.equal(config.dataset.path, '../dataset');
    for (const location of ['""', '" "', '"bad\\0path"']) {
      assert.throws(
        () =>
          parseExperimentConfigYaml(
            source.replace('dataset:', `dataset:\n  path: ${location}`),
          ),
        BenchmarkModelError,
      );
    }
  });

  it('accepts native Docker platform authoring', () => {
    const config = parseExperimentConfigYaml(
      experimentConfigYaml().replace(
        'platform: linux/amd64',
        'platform: native',
      ),
    );
    assert.equal(config.runtime.platform, 'native');
  });

  it('rejects mutable baseline setup and undefined matrix treatments', () => {
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          experimentConfigYaml(`
treatments:
  baseline:
    setup:
      - uses: forge/command
        with: {argv: [echo, changed]}
`),
        ),
      /baseline setup must be empty/,
    );
    assert.throws(
      () =>
        parseExperimentConfigYaml(
          experimentConfigYaml().replace(
            'treatments: [baseline]',
            'treatments: [missing]',
          ),
        ),
      /undefined treatment/,
    );
  });

  it('validates manifest case identities, paths, and uniqueness', () => {
    const entry = {
      id: 'smoke/write',
      version: '0.1.0',
      path: 'cases/smoke/write/case.yaml',
    };
    const manifest = {
      dataset: { id: 'forge-smoke', version: '2026.09.0' },
      cases: [entry],
    };
    assert.deepEqual(
      parseDatasetManifestJson(JSON.stringify(manifest)),
      manifest,
    );
    const other = {
      ...entry,
      id: 'smoke/other',
      path: 'cases/other.case.yaml',
    };

    const invalidManifests = [
      { value: { ...manifest, cases: [] }, reason: 'at least 1' },
      {
        value: { ...manifest, files: [] },
        reason: 'Unrecognized key',
      },
      {
        value: { ...manifest, cases: ['cases/smoke/write/case.yaml'] },
        reason: 'Expected object',
      },
      {
        value: { ...manifest, cases: [{ ...entry, version: undefined }] },
        reason: 'Required',
      },
      ...['size', 'sha256', 'files'].map((key) => ({
        value: { ...manifest, cases: [{ ...entry, [key]: 0 }] },
        reason: 'Unrecognized key',
      })),
      {
        value: { ...manifest, cases: [entry, { ...other, path: entry.path }] },
        reason: 'path values must be unique',
      },
      {
        value: { ...manifest, cases: [entry, { ...other, id: entry.id }] },
        reason: 'id values must be unique',
      },
    ];
    for (const casePath of [
      'cases/plain.yaml',
      'cases/.case.yaml',
      'cases/case.yml',
      'fixtures/case.yaml',
      './cases/case.yaml',
    ]) {
      invalidManifests.push({
        value: { ...manifest, cases: [{ ...entry, path: casePath }] },
        reason: casePath.startsWith('./')
          ? 'canonical dataset-relative POSIX path'
          : 'case definitions must be',
      });
    }
    for (const { value, reason } of invalidManifests) {
      assert.throws(
        () => parseDatasetManifestJson(JSON.stringify(value)),
        (error: unknown) => {
          assert.ok(error instanceof Error && 'code' in error);
          assert.equal(error.code, 'invalid_manifest');
          assert.ok(
            error.message.includes(reason),
            `Expected ${reason}: ${error.message}`,
          );
          return true;
        },
      );
    }
  });
});

function experimentConfigYaml(extra = ''): string {
  return `
id: forge-smoke
version: 2026.09.0
dataset:
  id: forge-smoke
  version: 2026.09.0
runtime:
  adapter: docker
  image: {kind: forge}
  platform: linux/amd64
matrix:
  cases: [cases/smoke/write/case.yaml]
  treatments: [baseline]
  agents:
    - adapter: claude-code
      provider: anthropic
      model: claude-sonnet-4-6
${extra}`;
}
