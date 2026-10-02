import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {
  readCampaignSelections,
  runCampaign,
  type CampaignOptions,
  type CampaignProgressEvent,
  type CampaignSummary,
} from './campaign.js';
import {createForgeEngine, defaultForgeEngine} from './engine.js';
import * as rootExports from './index.js';
import type {ForgeComposition} from './contracts/composition.js';
import {createArtifactStore} from './results/index.js';
import {defineSetupActionBundle} from './setup/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './testing/index.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('public campaign API', () => {
  it('exports orchestration through its subpath, separate from the root engine API', () => {
    assert.equal(typeof runCampaign, 'function');
    assert.equal(typeof readCampaignSelections, 'function');
    assert.equal('runCampaign' in rootExports, false);
    const optionsType = (_options: CampaignOptions): void => undefined;
    const summaryType = (_summary: CampaignSummary): void => undefined;
    const eventType = (event: CampaignProgressEvent): string => {
      if ('location' in event) return event.location;
      if (event.state === 'errored') return event.error_code;
      return event.run_id;
    };
    assert.equal(typeof optionsType, 'function');
    assert.equal(typeof summaryType, 'function');
    assert.equal(typeof eventType, 'function');
  });

  it('rejects invalid library concurrency before preflight or filesystem writes', async () => {
    const root = await campaignRoot();
    const composition = makeComposition(root);
    let calls = 0;
    for (const jobs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(runCampaign({
        root, composition, jobs,
        plans: [createTestResolvedRunPlan()],
        engine: {...defaultForgeEngine, preflightEval() {calls += 1;}},
        resume: false,
        signal: new AbortController().signal,
        execute: async () => {throw new Error('must not execute');},
        runIdFactory: () => 'never',
        progress: () => undefined,
      }), /positive safe integer/);
    }
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(root), {code: 'ENOENT'});
  });

  it('preflights every plan before acquiring per-run host resources', async () => {
    const root = await campaignRoot();
    const plans = ['first', 'last'].map((id) => createTestResolvedRunPlan({caseId: `testing/${id}`}));
    const preflighted: string[] = [];
    let calls = 0;
    await assert.rejects(runCampaign({
      root, plans, jobs: 2,
      composition: makeComposition(root),
      engine: {...defaultForgeEngine, preflightEval({plan}) {
        preflighted.push(plan.selection.case_id);
        if (plan === plans[1]) throw new Error('unsupported final plan');
      }},
      resume: false,
      signal: new AbortController().signal,
      execute: async () => {calls += 1; throw new Error('must not execute');},
      runIdFactory: () => 'never',
      progress: () => undefined,
    }), /unsupported final plan/);
    assert.deepEqual(preflighted, ['testing/first', 'testing/last']);
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(root), {code: 'ENOENT'});
  });

  it('shares scheduling and resume with a custom engine and per-run host compositions', async () => {
    const root = await campaignRoot();
    const manifest = {namespace: 'acme-evals', version: '1.0.0', sha256: `sha256:${'a'.repeat(64)}` as const};
    const bundle = defineSetupActionBundle({
      manifest,
      actions: [{
        uses: 'acme-evals/seed',
        parseWith(input) {
          if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length !== 0) {
            throw new Error('Expected empty seed configuration.');
          }
          return {};
        },
        preflight() {
          return {requirements: {}, async apply(context) {
            await context.workspace.writeFile('seed.txt', Buffer.from('ready'));
            return {seed: 'ready'};
          }};
        },
      }],
    });
    const engine = createForgeEngine({setupActionBundles: [bundle]});
    const plans = ['first', 'second'].map((id) => {
      const plan = structuredClone(createTestResolvedRunPlan({caseId: `testing/${id}`, checks: {
        file_checks: [{file: 'seed.txt', exists: true, contains: '^ready$'}],
      }}));
      plan.provenance.forge.action_bundles = [manifest];
      plan.treatment.setup = [{uses: 'acme-evals/seed', with: {}}];
      plan.setup = [...plan.treatment.setup];
      return engine.parseResolvedRunPlan(plan);
    });
    const composition = makeComposition(root);
    const events: CampaignProgressEvent[] = [];
    const opened: string[] = [];
    const closed: string[] = [];
    let nextId = 0;
    let fail = true;
    const options: CampaignOptions = {
      root, plans, composition, engine, resume: false, jobs: 2,
      signal: new AbortController().signal,
      runIdFactory: () => `host-run-${++nextId}`,
      progress: (event) => events.push(event),
      execute: async (input) => {
        assert.equal(input.composition, composition);
        opened.push(input.runId);
        try {
          if (fail && input.plan.selection.case_id === 'testing/second') throw new Error('transient host failure');
          // The host can supply independent bridge/runtime/agent resources for
          // each run after the shared pure preflight boundary.
          return await engine.executeEval({...input, composition: makeComposition(root)});
        } finally {
          closed.push(input.runId);
        }
      },
    };
    assert.deepEqual(await runCampaign(options), {
      campaign: path.join(root, 'campaign.json'), total: 2, executed: 2, skipped: 0, completed: 1, errored: 1,
    });
    assert.deepEqual(await readCampaignSelections(root), plans.map((plan) => plan.selection));
    fail = false;
    const resumed = await runCampaign({...options, resume: true, jobs: 3});
    assert.equal(resumed.executed, 1);
    assert.equal(resumed.skipped, 1);
    assert.equal(resumed.completed, 2);
    assert.deepEqual(opened, ['host-run-1', 'host-run-2', 'host-run-3']);
    assert.deepEqual([...closed].sort(), opened);
    const checkpoint = JSON.parse(await fs.readFile(path.join(root, 'campaign.json'), 'utf8'));
    assert.deepEqual(checkpoint.entries.map((entry: {attempts: unknown[]}) => entry.attempts.length), [1, 2]);
    for (const runId of ['host-run-1', 'host-run-3']) {
      const completed = await engine.verifyCompletedRun(path.join(root, 'runs', runId));
      assert.equal(completed.result.evaluation.status, 'passed');
      await assert.rejects(defaultForgeEngine.verifyCompletedRun(completed.location), /plan.json does not match its schema/);
    }
    assert.ok(events.some((event) => event.state === 'resuming'));
    assert.ok(events.some((event) => event.state === 'skipped'));
    assert.ok(events.some((event) => event.state === 'errored' && event.error_code === 'execution_error'));
  });
});

async function campaignRoot() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-campaign-api-'));
  temporaryDirectories.push(temporary);
  return path.join(temporary, 'host-campaign');
}

function makeComposition(root: string): ForgeComposition {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter();
  return {
    runtime: runtime.adapter,
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({root}),
  };
}
