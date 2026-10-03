import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {inspectCampaign, parseCampaignReport} from './campaign.js';
import {
  CAMPAIGN_CLI_OPTIONS,
  CampaignCommandError,
  CampaignUsageError,
  createCampaignCliOptions,
  parseCampaignArgs,
  runCampaignCommand,
  type CampaignCommandOptions,
  type CampaignCommandResult,
  type CampaignLoadContext,
} from './campaignCli.js';
import type {ForgeComposition} from './contracts/composition.js';
import {createForgeEngine, defaultForgeEngine} from './engine.js';
import {executeEvalWithTestHooks} from './execution/execute.js';
import {createArtifactStore} from './results/index.js';
import {defineSetupActionBundle} from './setup/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './testing/index.js';

const hostOptions = {
  experiment: {type: 'string', short: 'e'},
  case: {type: 'string', short: 'c'},
  upload: {type: 'boolean'},
  label: {type: 'string', multiple: true},
} as const;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('shared campaign command', () => {
  it('keeps command APIs on their subpath and rejects option/alias collisions', () => {
    assert.equal(typeof runCampaignCommand, 'function');
    assert.deepEqual(Object.keys(CAMPAIGN_CLI_OPTIONS), ['output', 'run-id', 'resume', 'jobs']);
    for (const definitions of [
      {jobs: {type: 'boolean' as const}},
      {upload: {type: 'boolean' as const, short: 'j'}},
      {j: {type: 'string' as const}},
      {first: {type: 'string' as const, short: 'x'}, second: {type: 'boolean' as const, short: 'x'}},
      {x: {type: 'string' as const}, second: {type: 'boolean' as const, short: 'x'}},
    ]) {
      assert.throws(() => createCampaignCliOptions(definitions), CampaignUsageError);
    }
    assert.equal(createCampaignCliOptions(hostOptions).jobs.short, 'j');
  });

  it('parses host flags, repeats, aliases and positionals alongside shared flags', () => {
    const parsed = parseCampaignArgs(['case-a', '-e', 'host.yaml', '--upload',
      '--label=one', '--label', 'two', '-j3', '-o', 'out'], {hostOptions, allowPositionals: true});
    assert.equal(parsed.values.experiment, 'host.yaml');
    assert.equal(parsed.values.upload, true);
    assert.deepEqual(parsed.values.label, ['one', 'two']);
    assert.deepEqual(parsed.positionals, ['case-a']);
    assert.equal(parsed.jobs, 3);
    assert.equal(parsed.values.output, 'out');
    assert.deepEqual(parsed.suppliedOptions, ['experiment', 'upload', 'label', 'jobs', 'output']);
    assert.throws(() => parseCampaignArgs(['case-a'], {hostOptions}), /positional/);
    assert.throws(() => parseCampaignArgs(['--unknown'], {hostOptions}), /Unknown option/);
  });

  it('rejects invalid shared flags before loading inputs or generating an ID', async () => {
    let calls = 0;
    const options: CampaignCommandOptions<typeof hostOptions> = {
      hostOptions, selectorOptions: ['case'], engine: defaultForgeEngine,
      experimentRunIdFactory: () => {calls += 1; return 'never';},
      loadCampaign: async () => {calls += 1; throw new Error('never');},
    };
    for (const args of [
      ['--resume'], ['--jobs'], ['--resume', '../escape'], ['--run-id', '../escape'],
      ['--output='], ['--output', 'bad\0path'],
      ['--resume', 'exp-1', '--case', 'testing/first'],
      ['--resume', 'exp-1', '--run-id', 'run-1'],
      ...['0', '-1', '1.5', '01', 'NaN', 'Infinity', '9007199254740992'].map((jobs) => [`--jobs=${jobs}`]),
    ]) {
      await assert.rejects(runCampaignCommand(args, options));
    }
    assert.equal(calls, 0);
  });

  it('distinguishes explicit resume selectors from configured defaults', () => {
    const options = {hostOptions: {case: {type: 'string', default: 'testing/second'} as const}, selectorOptions: ['case'] as const};
    const parsed = parseCampaignArgs(['--resume', 'exp-1'], options);
    assert.equal(parsed.values.case, 'testing/second');
    assert.deepEqual(parsed.suppliedOptions, ['resume']);
    assert.throws(() => parseCampaignArgs(['--resume', 'exp-1', '--case', 'testing/second'], options), /saved selections/);
  });

  it('allows the host to validate its own positional grammar before input loading', async () => {
    const fixture = await createFixture();
    let loaded = 0;
    const options: CampaignCommandOptions<typeof hostOptions> = {
      ...fixture.options, allowPositionals: true,
      validateHostArgs: ({positionals, values}) => {
        if (positionals.length > 1) throw new CampaignUsageError('Expected at most one case.');
        if (values.resume !== undefined && positionals.length) throw new CampaignUsageError('Omit the case on resume.');
      },
      loadCampaign: async (context) => {
        loaded += 1;
        assert.deepEqual(context.positionals, ['testing/second']);
        return {plans: [fixture.plans[1]!], composition: makeComposition(context.root)};
      },
    };
    await assert.rejects(runCampaignCommand(['first', 'second'], options), /at most one case/);
    await assert.rejects(runCampaignCommand(['first', '--resume', 'missing'], options), /Omit the case/);
    assert.equal(loaded, 0);
    const result = await fixture.run(['testing/second'], options);
    assert.equal(result.total, 1);
    assert.equal(loaded, 1);
  });

  it('shares bounded execution and restores original selections before preparing inputs', {timeout: 10_000}, async () => {
    const fixture = await createFixture();
    let fail = true;
    let active = 0;
    let maximum = 0;
    const bothStarted = gate();
    const executed: string[] = [];
    const loadedSelections: Array<readonly string[] | undefined> = [];
    const options: CampaignCommandOptions<typeof hostOptions> = {
      ...fixture.options,
      loadCampaign: async (context) => {
        loadedSelections.push(context.savedSelections?.map((selection) => selection.case_id));
        const loaded = await fixture.options.loadCampaign(context);
        return {...loaded, execute: async (input) => {
          active += 1;
          maximum = Math.max(maximum, active);
          executed.push(input.plan.selection.case_id);
          if (active === 2) bothStarted.resolve();
          try {
            if (fail) await bothStarted.promise;
            if (fail && input.plan.selection.case_id === 'testing/second') throw new Error('private host error');
            return await context.engine.executeEval({...input, composition: makeComposition(context.root)});
          } finally {
            active -= 1;
          }
        }};
      },
    };
    const first = await fixture.run(['--jobs', '2', '--upload', '--label', 'test'], options);
    assert.equal(maximum, 2);
    assert.equal(first.completed, 1);
    assert.equal(first.errored, 1);
    assert.equal(first.arguments.values.upload, true);
    assert.deepEqual(first.arguments.values.label, ['test']);
    assert.deepEqual(first.outcomes.map((outcome) => outcome.selection.case_id), ['testing/first', 'testing/second']);
    assert.equal(first.outcomes[0]!.artifact!.evaluation.status, 'failed');
    assert.equal(first.outcomes[1]!.artifact, null);
    assert.equal(first.outcomes[1]!.error_code, 'execution_error');
    assert.equal(JSON.stringify(first).includes('private host error'), false);
    fail = false;
    const resumed = await fixture.run(['--resume', 'exp-1', '-j3'], options);
    assert.deepEqual(loadedSelections, [undefined, ['testing/first', 'testing/second']]);
    assert.deepEqual(executed, ['testing/first', 'testing/second', 'testing/second']);
    assert.equal(resumed.executed, 1);
    assert.equal(resumed.skipped, 1);
    assert.equal(resumed.outcomes[0]!.run_id, first.outcomes[0]!.run_id);
    assert.equal(resumed.outcomes[0]!.artifact!.evaluation.status, 'failed');
    assert.equal(resumed.outcomes[1]!.artifact!.evaluation.status, 'passed');
  });

  it('resumes an originally filtered campaign and rejects changed resolved plans', async () => {
    const fixture = await createFixture();
    await fixture.run(['--case', 'testing/second']);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.total, 1);
    assert.equal(resumed.executed, 0);
    let executed = 0;
    let disposed = 0;
    await assert.rejects(fixture.run(['--resume', 'exp-1'], {
      ...fixture.options,
      loadCampaign: async (context) => ({
        plans: [createTestResolvedRunPlan({caseId: 'testing/second', prompt: 'changed'})],
        composition: makeComposition(context.root),
        execute: async () => {executed += 1; throw new Error('never');},
        dispose: async () => {disposed += 1;},
      }),
    }), /resolved plans differ/);
    assert.equal(executed, 0);
    assert.equal(disposed, 1);
  });

  it('inspects verified outcomes without loading inputs or changing the checkpoint', async () => {
    const fixture = await createFixture();
    const first = await fixture.run([]);
    const checkpoint = await fs.readFile(first.campaign);
    const inspected = await inspectCampaign({root: `${first.location}/.`, engine: defaultForgeEngine});
    assert.deepEqual(inspected.outcomes, first.outcomes);
    assert.deepEqual(await fs.readFile(first.campaign), checkpoint);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.executed, 0);
    assert.deepEqual(resumed.outcomes, first.outcomes);
    await fs.appendFile(path.join(first.outcomes[0]!.artifact!.location, 'plan.json'), 'tampered');
    const corrupt = await inspectCampaign({root: first.location, engine: defaultForgeEngine});
    assert.equal(corrupt.outcomes[0]!.artifact, null);
    assert.equal(corrupt.outcomes[0]!.error_code, 'invalid_artifacts');
    assert.deepEqual(await fs.readFile(first.campaign), checkpoint);
  });

  it('uses the supplied custom engine for loading, preflight, execution and verification', async () => {
    const fixture = await createFixture();
    const bundle = defineSetupActionBundle({
      manifest: {namespace: 'acme-evals', version: '1.0.0', sha256: `sha256:${'a'.repeat(64)}`},
      actions: [{
        uses: 'acme-evals/seed', parseWith: () => ({}),
        preflight: () => ({requirements: {}, apply: async () => undefined})
      }],
    });
    const engine = createForgeEngine({setupActionBundles: [bundle]});
    const raw = structuredClone(createTestResolvedRunPlan());
    raw.provenance.forge.action_bundles = [bundle.manifest];
    raw.treatment.setup = [{uses: 'acme-evals/seed', with: {}}];
    raw.setup = [...raw.treatment.setup];
    const plan = engine.parseResolvedRunPlan(raw);
    const result = await fixture.run([], {
      ...fixture.options, engine,
      loadCampaign: async (context) => {
        assert.equal(context.engine, engine);
        return {plans: [plan], composition: makeComposition(context.root)};
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(result.outcomes[0]!.artifact!.evaluation.status, 'passed');
    assert.equal(result.report, path.join(result.location, 'report.json'));
    const report = parseCampaignReport(JSON.parse(await fs.readFile(result.report, 'utf8')));
    assert.equal(report.summary.completed, 1);
    assert.equal(report.cases[0]!.case_id, plan.selection.case_id);
    const inspected = await inspectCampaign({root: result.location, engine});
    assert.deepEqual(inspected.outcomes, result.outcomes);
    const wrongEngine = await inspectCampaign({root: result.location, engine: defaultForgeEngine});
    assert.equal(wrongEngine.outcomes[0]!.artifact, null);
  });

  it('rejects inspection when cancellation arrives during the final artifact verification', async () => {
    const fixture = await createFixture();
    const result = await fixture.run(['--case', 'testing/second']);
    const before = await fs.readFile(result.campaign);
    const controller = new AbortController();
    const reason = new Error('inspection cancelled');
    const engine = {...defaultForgeEngine, async verifyCompletedRun(location: string) {
      const completed = await defaultForgeEngine.verifyCompletedRun(location);
      controller.abort(reason);
      return completed;
    }};
    await assert.rejects(inspectCampaign({root: result.location, engine, signal: controller.signal}),
      (error: unknown) => error === reason);
    assert.deepEqual(await fs.readFile(result.campaign), before);
  });

  it('withholds artifacts when checkpoint selections disagree with their verified commits', async () => {
    const fixture = await createFixture();
    const result = await fixture.run(['--case', 'testing/second']);
    const original = JSON.parse(await fs.readFile(result.campaign, 'utf8'));
    const selection = original.entries[0].selection;
    for (const changed of [
      {...selection, case_id: 'testing/wrong'},
      {...selection, treatment: 'wrong'},
      {...selection, agent: {...selection.agent, model: 'wrong'}},
      {...selection, repetition: 1},
    ]) {
      const corrupt = structuredClone(original);
      corrupt.entries[0].selection = changed;
      const body = JSON.stringify(corrupt);
      await fs.writeFile(result.campaign, body);
      const inspected = await inspectCampaign({root: result.location, engine: defaultForgeEngine});
      assert.equal(inspected.outcomes[0]!.artifact, null);
      assert.equal(inspected.outcomes[0]!.state, 'errored');
      assert.equal(inspected.outcomes[0]!.error_code, 'invalid_artifacts');
      assert.equal(await fs.readFile(result.campaign, 'utf8'), body);
    }
  });

  it('returns verified role-player failures as publishable artifacts and retries their execution', async () => {
    const fixture = await createFixture();
    const plan = createTestResolvedRunPlan({mode: 'multi_turn',
      rolePlayer: {provider: 'scripted', model: 'role-player'}});
    const options: CampaignCommandOptions<typeof hostOptions> = {
      ...fixture.options,
      loadCampaign: async (context) => {
        const provider = createScriptedCompletionProvider({id: 'scripted',
          responses: Array.from({length: 3}, () => new Error('unavailable'))}).provider;
        return {plans: [plan], composition: {...makeComposition(context.root),
          completionProviders: new Map([[provider.id, provider]])},
          execute: (request) => executeEvalWithTestHooks(request, {
            waitBeforeCompletionRetry: async () => undefined,
          })};
      },
    };
    const first = await fixture.run([], options);
    assert.equal(first.errored, 1);
    assert.equal(first.outcomes[0]!.error_code, 'role_player_error');
    assert.equal(first.outcomes[0]!.artifact!.failure, 'role_player_error');
    const report = parseCampaignReport(JSON.parse(await fs.readFile(first.report, 'utf8')));
    assert.equal(report.summary.completed, 0);
    assert.equal(report.summary.errored, 1);
    assert.equal(report.summary.pass_rate, null);
    assert.equal(report.runs[0]!.evaluation, null);
    assert.equal(report.runs[0]!.error_code, 'role_player_error');
    assert.equal(report.runs[0]!.result_path, `runs/${first.outcomes[0]!.run_id}/result.json`);
    const inspected = await inspectCampaign({root: first.location, engine: defaultForgeEngine});
    assert.deepEqual(inspected.outcomes, first.outcomes);
    const resumed = await fixture.run(['--resume', 'exp-1'], options);
    assert.equal(resumed.executed, 1);
    assert.equal(resumed.skipped, 0);
    assert.notEqual(resumed.outcomes[0]!.run_id, first.outcomes[0]!.run_id);
  });

  it('retains verified artifacts when an execution callback fails after committing', async () => {
    const fixture = await createFixture();
    const first = await fixture.run(['--case', 'testing/second'], {...fixture.options,
      loadCampaign: async (context) => ({plans: [fixture.plans[1]!], composition: makeComposition(context.root),
        execute: async (request) => {
          await context.engine.executeEval(request);
          throw new Error('private cleanup error');
        }}),
    });
    assert.equal(first.errored, 1);
    assert.equal(first.outcomes[0]!.error_code, 'execution_error');
    assert.equal(first.outcomes[0]!.artifact!.evaluation.status, 'passed');
    assert.equal(JSON.stringify(first).includes('private cleanup error'), false);
    // The report uses the same committed-result recovery as the next resume.
    const report = parseCampaignReport(JSON.parse(await fs.readFile(first.report, 'utf8')));
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.errored, 0);
    assert.equal(report.runs[0]!.evaluation!.status, 'passed');
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.executed, 0);
    assert.equal(resumed.outcomes[0]!.run_id, first.outcomes[0]!.run_id);
  });

  it('exposes partial execution for inspection after a coordinator failure without mutating it', async () => {
    const fixture = await createFixture();
    const primary = new Error('progress failed');
    try {
      await fixture.run([], {...fixture.options, progress: (event) => {
        if (event.state === 'running') throw primary;
      }});
      assert.fail('expected failure');
    } catch (error) {
      assert.ok(error instanceof CampaignCommandError);
      assert.equal(error.cause, primary);
      const before = await fs.readFile(error.reference.campaign);
      const inspected = await inspectCampaign({root: error.reference.location, engine: defaultForgeEngine});
      assert.equal(inspected.outcomes[0]!.artifact, null);
      assert.equal(inspected.outcomes[0]!.error_code, 'invalid_artifacts');
      assert.equal(inspected.outcomes[1]!.state, 'pending');
      assert.equal(inspected.outcomes[1]!.run_id, null);
      assert.deepEqual(await fs.readFile(error.reference.campaign), before);
    }
  });

  it('disposes prepared inputs exactly once on preflight failure and preserves the primary error', async () => {
    const fixture = await createFixture();
    const primary = new Error('unsupported final plan');
    let executed = 0;
    let disposed = 0;
    const engine = {...defaultForgeEngine, preflightEval() {throw primary;}};
    try {
      await fixture.run([], {...fixture.options, engine,
        loadCampaign: async (context) => ({plans: fixture.plans, composition: makeComposition(context.root),
          execute: async () => {executed += 1; throw new Error('never');},
          dispose: async () => {disposed += 1; throw new Error('cleanup also failed');}}),
      });
      assert.fail('expected failure');
    } catch (error) {
      assert.ok(error instanceof CampaignCommandError);
      assert.equal(error.cause, primary);
      assert.equal(error.reference.experiment_run_id, 'exp-1');
      await assert.rejects(fs.stat(error.reference.location), {code: 'ENOENT'});
    }
    assert.equal(executed, 0);
    assert.equal(disposed, 1);
  });

  it('awaits successful disposal and reports a disposal failure with the committed campaign reference', async () => {
    const fixture = await createFixture();
    const primary = new Error('dispose failed');
    let disposed = 0;
    try {
      await fixture.run([], {...fixture.options,
        loadCampaign: async (context) => ({...await fixture.options.loadCampaign(context),
          dispose: async () => {disposed += 1; throw primary;}}),
      });
      assert.fail('expected failure');
    } catch (error) {
      assert.ok(error instanceof CampaignCommandError);
      assert.equal(error.cause, primary);
      const inspected = await inspectCampaign({root: error.reference.location, engine: defaultForgeEngine});
      assert.ok(inspected.outcomes.every((outcome) => outcome.artifact !== null));
    }
    assert.equal(disposed, 1);
  });

  it('finishes disposal but rejects success when cancellation arrives during that cleanup', {timeout: 10_000}, async () => {
    const fixture = await createFixture();
    const entered = gate();
    const release = gate();
    const controller = new AbortController();
    const reason = new Error('cancelled during disposal');
    let disposed = 0;
    let publicationReached = false;
    const running = fixture.run(['--case', 'testing/second'], {...fixture.options,
      signal: controller.signal,
      loadCampaign: async (context) => ({...await fixture.options.loadCampaign(context),
        dispose: async () => {
          entered.resolve();
          await release.promise;
          disposed += 1;
        }}),
    }).then((result) => {
      publicationReached = true;
      return result;
    });
    const rejected = assert.rejects(running, (error: unknown) =>
      error instanceof CampaignCommandError && error.cause === reason);
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    await rejected;
    assert.equal(disposed, 1);
    assert.equal(publicationReached, false);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.executed, 0);
    assert.equal(resumed.skipped, 1);
  });

  it('drains aborted callbacks before releasing the lock and disposing prepared inputs', {timeout: 10_000}, async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const started = gate();
    const cleaning = gate();
    const releaseCleanup = gate();
    let active = 0;
    let disposed = 0;
    const running = fixture.run(['--jobs', '2'], {...fixture.options, signal: controller.signal,
      loadCampaign: async (context) => ({plans: fixture.plans, composition: makeComposition(context.root),
        execute: async ({signal}) => {
          assert.ok(signal);
          active += 1;
          if (active === 2) started.resolve();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {once: true}));
          cleaning.resolve();
          await releaseCleanup.promise;
          active -= 1;
          signal.throwIfAborted();
          throw new Error('never');
        },
        dispose: async () => {
          assert.equal(active, 0);
          await assert.rejects(fs.stat(path.join(context.root, '.campaign.lock')), {code: 'ENOENT'});
          disposed += 1;
        },
      }),
    });
    // Attach the rejection handler before aborting to avoid an unhandled rejection.
    const rejected = assert.rejects(running, CampaignCommandError);
    await started.promise;
    controller.abort(new Error('cancelled'));
    await cleaning.promise;
    const root = path.join(fixture.output, 'experiments', 'exp-1');
    try {
      assert.equal(disposed, 0);
      assert.equal(active, 2);
      assert.ok((await fs.stat(path.join(root, '.campaign.lock'))).isDirectory());
    } finally {
      releaseCleanup.resolve();
    }
    await rejected;
    assert.equal(disposed, 1);
    const resumed = await fixture.run(['--resume', 'exp-1']);
    assert.equal(resumed.executed, 2);
  });

  it('rejects explicit eval IDs for multiple plans and cleans loaded inputs', async () => {
    const fixture = await createFixture();
    let disposed = 0;
    await assert.rejects(fixture.run(['--run-id', 'named'], {...fixture.options,
      loadCampaign: async (context) => ({...await fixture.options.loadCampaign(context),
        dispose: async () => {disposed += 1;}}),
    }), /exactly one/);
    assert.equal(disposed, 1);
    const single = await fixture.run(['--case', 'testing/second', '--run-id', 'named']);
    assert.equal(single.outcomes[0]!.run_id, 'named');
  });
});

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-command-'));
  temporaryDirectories.push(directory);
  const output = path.join(directory, 'results');
  const plans = [
    createTestResolvedRunPlan({caseId: 'testing/first', checks: {files_created: ['missing.txt']}}),
    createTestResolvedRunPlan({caseId: 'testing/second'}),
  ];
  let nextRun = 0;
  const options: CampaignCommandOptions<typeof hostOptions> = {
    hostOptions, selectorOptions: ['case'], engine: defaultForgeEngine,
    experimentRunIdFactory: () => 'exp-1',
    runIdFactory: () => `run-${++nextRun}`,
    loadCampaign: async (context: CampaignLoadContext<typeof hostOptions>) => {
      const selected = context.savedSelections === undefined
        ? plans.filter((plan) => context.values.case === undefined || plan.selection.case_id === context.values.case)
        : context.savedSelections.map((selection) => plans.find((plan) => plan.selection.case_id === selection.case_id)!);
      return {plans: selected, composition: makeComposition(context.root),
        execute: (request) => context.engine.executeEval({...request, composition: makeComposition(context.root)})};
    },
  };
  return {directory, output, plans, options,
    run: (args: readonly string[], overrides = options) => runCampaignCommand(['--output', output, ...args], overrides)};
}

function makeComposition(root: string): ForgeComposition {
  const agent = createScriptedAgentAdapter();
  return {runtime: createFakeRuntimeAdapter().adapter, agents: new Map([[agent.adapter.id, agent.adapter]]),
    credentialResolver: createStaticCredentialResolver(), inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({root})};
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {resolve = ready;});
  return {promise, resolve};
}
