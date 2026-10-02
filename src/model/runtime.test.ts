import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {parseExperimentConfig, parseResolvedRunPlan} from './parse.js';
import type {ForgeExternalRuntimeV1} from './types.js';
import {resolvedRunPlanSha256, serializeResolvedRunPlan} from '../planning/planner.js';
import {createTestResolvedRunPlan} from '../testing/plans.js';

const runtime: ForgeExternalRuntimeV1 = {
  adapter: 'acme/process',
  platform: 'linux/amd64',
  config: {profile: 'worker', tools: {revision: 'immutable-build'}, limit_ms: 20_000},
};

function experiment(selectedRuntime: unknown): unknown {
  return {
    schema_version: 1,
    id: 'example/external',
    version: '1',
    dataset: {id: 'test', version: '1', manifest_sha256: `sha256:${'a'.repeat(64)}`},
    runtime: selectedRuntime,
    matrix: {
      cases: ['testing/example'],
      treatments: ['baseline'],
      agents: [{adapter: 'test-agent', provider: 'test-provider', model: 'test'}],
    },
  };
}

describe('external runtime wire configuration', () => {
  it('preserves explicit configuration without a runtime implementation or normalization', () => {
    const input = {...runtime, config: {...runtime.config, label: '  intentional whitespace  '}};
    const parsed = parseExperimentConfig(experiment(input));
    assert.deepEqual(parsed.runtime, input);
    assert.notEqual(parsed.runtime, input);
    const plan = createTestResolvedRunPlan({runtime: parsed.runtime});
    const reparsed = parseResolvedRunPlan(JSON.parse(serializeResolvedRunPlan(plan)));
    assert.equal(serializeResolvedRunPlan(reparsed), serializeResolvedRunPlan(plan));
    assert('config' in reparsed.runtime);
    assert(Object.isFrozen(reparsed.runtime.config));
    assert(Object.isFrozen(reparsed.runtime.config.tools));
  });

  it('binds adapter, platform and config into the plan digest', () => {
    const original = createTestResolvedRunPlan({runtime});
    for (const variant of [
      {...runtime, adapter: 'acme/other'},
      {...runtime, platform: 'linux/arm64' as const},
      {...runtime, config: {...runtime.config, limit_ms: 10_000}},
    ]) {
      assert.notEqual(
        resolvedRunPlanSha256(createTestResolvedRunPlan({runtime: variant})),
        resolvedRunPlanSha256(original),
      );
    }
  });

  it('rejects reserved identities, incomplete envelopes and invalid JSON configuration', () => {
    const invalid: unknown[] = [
      {...runtime, adapter: 'docker'},
      {...runtime, adapter: 'forge/docker'},
      {...runtime, adapter: '../process'},
      {...runtime, adapter: 'process'},
      {...runtime, adapter: 'acme/process/extra'},
      {...runtime, adapter_version: '1'},
      {...runtime, config_version: 1},
      {...runtime, platform: 'darwin/arm64'},
      {...runtime, image: {kind: 'forge'}},
      {...runtime, config: []},
      {...runtime, config: {limit: Infinity}},
      {...runtime, config: JSON.parse('{"__proto__":{"unsafe":true}}')},
    ];
    for (const field of ['platform', 'config']) {
      const missing: Record<string, unknown> = {...runtime};
      delete missing[field];
      invalid.push(missing);
    }
    for (const selected of invalid) {
      assert.throws(() => parseExperimentConfig(experiment(selected)));
      assert.throws(() => parseResolvedRunPlan({...createTestResolvedRunPlan(), runtime: selected}));
    }
  });

  it('bounds configuration graphs before recursive JSON parsing', () => {
    const config: Record<string, unknown> = {};
    config.self = config;
    assert.throws(() => parseExperimentConfig(experiment({...runtime, config})));
    assert.throws(() => parseExperimentConfig(experiment({
      ...runtime, config: {oversized: 'x'.repeat(1024 * 1024 + 1)},
    })));
    const shared = {text: 'x'.repeat(600_000)};
    for (const oversized of [
      {a: 'x'.repeat(600_000), b: 'y'.repeat(600_000)},
      {escaped: '\u0001'.repeat(200_000)},
      {first: shared, second: shared},
    ]) {
      assert.throws(() => parseExperimentConfig(experiment({...runtime, config: oversized})));
    }
  });

  it('keeps the materialized Docker wire representation unchanged', () => {
    const plan = createTestResolvedRunPlan();
    const before = serializeResolvedRunPlan(plan);
    const parsed = parseResolvedRunPlan(JSON.parse(before));
    assert.equal(serializeResolvedRunPlan(parsed), before);
    assert.deepEqual(Object.keys(parsed.runtime).sort(), ['adapter', 'image', 'platform', 'resources']);
  });
});
