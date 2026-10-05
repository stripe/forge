import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import * as campaignExports from './campaign.js';
import {
  CampaignReportError,
  inspectCampaign,
  parseCampaignReport,
  readCampaignSelections,
  runCampaign,
  type CampaignOptions,
  type CampaignProgressEvent,
  type CampaignSummary,
  type CampaignReportV1,
} from './campaign.js';
import {parseCampaign} from './campaignModel.js';
import {createForgeEngine, defaultForgeEngine} from './engine.js';
import type {ForgeComposition} from './contracts/composition.js';
import {createArtifactStore} from './results/index.js';
import {defineSetupActionBundle} from './setup/index.js';
import {FORGE_BUILD_IDENTITY, FORGE_VERSION} from './version.js';
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
    assert.equal(typeof inspectCampaign, 'function');
    assert.equal(typeof parseCampaignReport, 'function');
    assert.equal(typeof CampaignReportError, 'function');
    assert.equal('CAMPAIGN_REPORT_SCHEMA_VERSION' in campaignExports, false);
    const optionsType = (_options: CampaignOptions): void => undefined;
    const summaryType = (_summary: CampaignSummary): void => undefined;
    const reportType = (_report: CampaignReportV1): void => undefined;
    const eventType = (event: CampaignProgressEvent): string => {
      if ('location' in event) return event.location;
      if (event.state === 'errored') return event.error_code;
      return event.run_id;
    };
  });

  it('reads a pending-only checkpoint using its Forge identity without companion artifacts', async () => {
    const root = await campaignRoot();
    const plan = createTestResolvedRunPlan();
    const checkpoint = {
      forge: FORGE_BUILD_IDENTITY,
      experiment_run_id: path.basename(root),
      entries: [{selection: plan.selection, plan_sha256: `sha256:${'a'.repeat(64)}`, attempts: []}],
    };
    await fs.mkdir(root);
    const location = path.join(root, 'campaign.json');
    await fs.writeFile(location, JSON.stringify(checkpoint));
    assert.deepEqual(await readCampaignSelections(root), [plan.selection]);
    const inspected = await inspectCampaign({root, engine: defaultForgeEngine});
    assert.equal(inspected.outcomes[0]!.state, 'pending');
    assert.equal(inspected.outcomes[0]!.artifact, null);
    assert.deepEqual(parseCampaign(checkpoint).forge, FORGE_BUILD_IDENTITY);
    assert.equal(Object.hasOwn(parseCampaign(checkpoint), 'schema_version'), false);

    for (const invalid of [
      {...checkpoint, forge: undefined},
      {...checkpoint, forge: {...checkpoint.forge, unknown: true}},
      {...checkpoint, schema_version: 1},
      {...checkpoint, forge: {version: '9999.0.0'}},
    ]) {
      await fs.writeFile(location, JSON.stringify(invalid));
      await assert.rejects(readCampaignSelections(root), /compatible Forge campaign/);
      await assert.rejects(inspectCampaign({root, engine: defaultForgeEngine}), /compatible Forge campaign/);
    }
  });

  it('checks a checkpoint release before interpreting its selections and treats diagnostics as provenance', () => {
    assert.throws(() => parseCampaign({forge: {version: '9999.0.0'}, entries: 'invalid'}),
      /incompatible with installed Forge/);
    const checkpoint = {
      forge: {version: FORGE_VERSION, commit_sha: 'a'.repeat(40), dirty: true},
      experiment_run_id: 'test-checkpoint',
      entries: [{selection: createTestResolvedRunPlan().selection,
        plan_sha256: `sha256:${'a'.repeat(64)}`, attempts: []}],
    };
    assert.deepEqual(parseCampaign(checkpoint).forge, checkpoint.forge);
  });

  it('stamps the current build when rewriting a resumed checkpoint without changing committed runs', async () => {
    const root = await campaignRoot();
    const options: CampaignOptions = {
      root, plans: [createTestResolvedRunPlan()], composition: makeComposition(root),
      engine: defaultForgeEngine, resume: false, signal: new AbortController().signal,
      runIdFactory: () => 'retained-run', progress: () => undefined,
      execute: (input) => defaultForgeEngine.executeEval({...input, composition: makeComposition(root)}),
    };
    const first = await runCampaign(options);
    const checkpoint = parseCampaign(JSON.parse(await fs.readFile(first.campaign, 'utf8')));
    const oldBuild = {version: FORGE_VERSION, commit_sha: 'a'.repeat(40), dirty: FORGE_BUILD_IDENTITY.dirty !== true};
    assert.notDeepEqual(oldBuild, FORGE_BUILD_IDENTITY);
    await fs.writeFile(first.campaign, JSON.stringify({...checkpoint, forge: oldBuild}));
    const runRoot = path.join(root, 'runs', 'retained-run');
    const savedPlan = await fs.readFile(path.join(runRoot, 'plan.json'));
    const savedResult = await fs.readFile(path.join(runRoot, 'result.json'));

    const resumed = await runCampaign({...options, resume: true,
      execute: async () => {throw new Error('must skip committed runs');}});
    assert.equal(resumed.executed, 0);
    assert.equal(resumed.skipped, 1);
    const rewritten = parseCampaign(JSON.parse(await fs.readFile(first.campaign, 'utf8')));
    assert.deepEqual(rewritten.forge, FORGE_BUILD_IDENTITY);
    assert.deepEqual(rewritten.entries, checkpoint.entries);
    assert.deepEqual(await fs.readFile(path.join(runRoot, 'plan.json')), savedPlan);
    assert.deepEqual(await fs.readFile(path.join(runRoot, 'result.json')), savedResult);
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
      const plan = structuredClone(createTestResolvedRunPlan({
        caseId: `testing/${id}`, checks: {
          file_checks: [{file: 'seed.txt', exists: true, contains: '^ready$'}],
        }
      }));
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
      campaign: path.join(root, 'campaign.json'), report: path.join(root, 'report.json'),
      total: 2, executed: 2, skipped: 0, completed: 1, errored: 1,
    });
    assert.deepEqual(await readCampaignSelections(root), plans.map((plan) => plan.selection));
    assert.deepEqual(await readCampaignSelections(`${root}/.`), plans.map((plan) => plan.selection));
    assert.deepEqual(await readCampaignSelections(path.relative(process.cwd(), root)), plans.map((plan) => plan.selection));
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

  it('drains siblings under the lock when an outcome callback throws and resumes only unfinished work', async () => {
    const root = await campaignRoot();
    const plans = ['first', 'second', 'third'].map((id) => createTestResolvedRunPlan({caseId: `testing/${id}`}));
    const started = createGate();
    const cancelled = createGate();
    const cleanup = createGate();
    const controller = new AbortController();
    const sentinel = new Error('outcome callback failed');
    const calls: string[] = [];
    let nextId = 0;
    const options: CampaignOptions = {
      root, plans, composition: makeComposition(root), engine: defaultForgeEngine,
      jobs: 2, resume: false, signal: controller.signal,
      runIdFactory: () => `callback-${++nextId}`, progress: () => undefined,
      onOutcome(_outcome, index) {if (index === 0) throw sentinel;},
      async execute(input) {
        calls.push(input.plan.selection.case_id);
        if (input.plan === plans[0]) {
          await waitFor(started.promise);
          return defaultForgeEngine.executeEval({...input, composition: makeComposition(root)});
        }
        assert.equal(input.plan, plans[1], 'No third worker may start after callback failure');
        started.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal!.aborted) resolve();
          else input.signal!.addEventListener('abort', () => resolve(), {once: true});
        });
        cancelled.resolve();
        await cleanup.promise;
        throw input.signal!.reason;
      },
    };
    let settled = false;
    const running = runCampaign(options).then(
      () => {settled = true; return null;},
      (error: unknown) => {settled = true; return error;},
    );
    try {
      await waitFor(cancelled.promise);
      await fs.stat(path.join(root, '.campaign.lock'));
      assert.equal(settled, false, 'The callback failure must wait for sibling cleanup');
      assert.deepEqual(calls, ['testing/first', 'testing/second']);
      cleanup.resolve();
      assert.equal(await waitFor(running), sentinel);
      await assert.rejects(fs.stat(path.join(root, '.campaign.lock')), {code: 'ENOENT'});
      const retained = await fs.readFile(path.join(root, 'runs', 'callback-1', 'result.json'));
      const resumed = await runCampaign({...options, resume: true, onOutcome: () => undefined,
        execute: (input) => defaultForgeEngine.executeEval({...input, composition: makeComposition(root)})});
      assert.equal(resumed.skipped, 1);
      assert.equal(resumed.executed, 2);
      assert.deepEqual(await fs.readFile(path.join(root, 'runs', 'callback-1', 'result.json')), retained);
      let executions = 0;
      await assert.rejects(runCampaign({...options, resume: true,
        execute: async () => {executions += 1; throw new Error('must not execute');}}),
      (error) => error === sentinel);
      assert.equal(executions, 0, 'A failing skipped-outcome callback must stop no-op resume');
    } finally {
      controller.abort();
      cleanup.resolve();
      await running;
    }
  });

  it('uses the latest attempt after an older valid result is restored', async () => {
    const root = await campaignRoot();
    const plans = [createTestResolvedRunPlan()];
    let nextId = 0;
    const options: CampaignOptions = {
      root, plans, composition: makeComposition(root), engine: defaultForgeEngine,
      resume: false, signal: new AbortController().signal,
      runIdFactory: () => `history-${++nextId}`, progress: () => undefined,
      execute: (input) => defaultForgeEngine.executeEval({...input, composition: makeComposition(root)}),
    };
    await runCampaign(options);
    const originalPath = path.join(root, 'runs', 'history-1', 'result.json');
    const original = await fs.readFile(originalPath);
    await fs.writeFile(originalPath, 'invalid result');
    const failedRetry = await runCampaign({...options, resume: true,
      execute: async () => {throw new Error('retry execution failed');}});
    assert.equal(failedRetry.errored, 1);
    await fs.writeFile(originalPath, original);
    await defaultForgeEngine.verifyCompletedRun(path.dirname(originalPath));

    const inspection = await inspectCampaign({root, engine: defaultForgeEngine});
    assert.equal(inspection.outcomes[0]!.run_id, 'history-2');
    assert.equal(inspection.outcomes[0]!.state, 'errored');
    assert.equal(inspection.outcomes[0]!.artifact, null);
    const report = parseCampaignReport(JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8')));
    assert.equal(report.summary.completed, 0);
    assert.equal(report.runs[0]!.run_id, 'history-2');
    assert.equal(report.runs[0]!.evaluation, null);
    const resumed = await runCampaign({...options, resume: true});
    assert.equal(resumed.executed, 1);
    assert.equal(resumed.skipped, 0);
    assert.equal(resumed.completed, 1);
    assert.deepEqual(await fs.readFile(originalPath), original);
    const checkpoint = JSON.parse(await fs.readFile(path.join(root, 'campaign.json'), 'utf8'));
    assert.deepEqual(checkpoint.entries[0].attempts.map((attempt: {run_id: string}) => attempt.run_id),
      ['history-1', 'history-2', 'history-3']);
  });
});

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {resolve = done;});
  return {promise, resolve};
}

async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out waiting for campaign test readiness')), 5_000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

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
