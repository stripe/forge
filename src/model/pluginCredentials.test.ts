import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '../contracts/credentials.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { parseSetupStep } from './parse.ts';
import {
  pluginMcpCredentials,
  pluginMcpEnvironmentBindings,
} from './pluginCredentials.ts';

const servers = ['stripe'] as const;
const step = {
  uses: 'forge/plugin',
  with: { plugin: 'stripe' },
};

describe('plugin credential policy', () => {
  it('declares opaque credentials under their registered names and binds only selected inputs', () => {
    assert.deepEqual(pluginMcpEnvironmentBindings([]), {});
    assert.deepEqual(pluginMcpCredentials(servers), {
      STRIPE_API_KEY: { reference: 'env:STRIPE_API_KEY' },
    });
    const plan = createTestResolvedRunPlan({
      agent: { adapter: 'codex', provider: 'openai', model: 'test' },
      treatmentSetup: [parseSetupStep(step)],
    });
    assert.deepEqual(pluginMcpEnvironmentBindings([plan]), {
      'env:STRIPE_API_KEY': 'STRIPE_API_KEY',
    });
    const explicit = Object.freeze({ 'other.api-key': 'OTHER_KEY' });
    assert.deepEqual(pluginMcpEnvironmentBindings([plan], explicit), {
      ...explicit,
      'env:STRIPE_API_KEY': 'STRIPE_API_KEY',
    });
    assert.deepEqual(explicit, { 'other.api-key': 'OTHER_KEY' });
    const remapped = Object.freeze({
      ...explicit,
      'env:STRIPE_API_KEY': 'STRIPE_TEST_KEY',
    });
    assert.deepEqual(pluginMcpEnvironmentBindings([plan], remapped), remapped);
  });

  it('does not bind plugin credentials for a baseline or unsupported adapter', () => {
    const baseline = createTestResolvedRunPlan({
      agent: { adapter: 'codex', provider: 'openai', model: 'test' },
    });
    const unsupported = createTestResolvedRunPlan({
      agent: { adapter: 'other', provider: 'openai', model: 'test' },
      treatmentSetup: [parseSetupStep(step)],
    });
    assert.deepEqual(pluginMcpEnvironmentBindings([baseline, unsupported]), {});
  });

  it('resolves only the selected host binding without implicit fallbacks', async () => {
    const plan = createTestResolvedRunPlan({
      agent: { adapter: 'codex', provider: 'openai', model: 'test' },
      treatmentSetup: [parseSetupStep(step)],
    });
    for (const [explicit, environment, message] of [
      [{}, { OTHER_KEY: 'synthetic-key' }, /Set STRIPE_API_KEY/],
      [
        { 'env:STRIPE_API_KEY': 'STRIPE_TEST_KEY' },
        { STRIPE_API_KEY: 'synthetic-default-key' },
        /Set STRIPE_TEST_KEY/,
      ],
    ] as const) {
      const resolver = createEnvironmentCredentialResolver({
        bindings: pluginMcpEnvironmentBindings([plan], explicit),
        environment,
      });
      await assert.rejects(
        resolver.resolve(credentialReference('env:STRIPE_API_KEY'), {
          runId: 'test',
          purpose: 'agent',
          signal: new AbortController().signal,
        }),
        message,
      );
    }
  });
});
