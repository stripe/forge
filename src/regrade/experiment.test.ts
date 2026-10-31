import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { criterionJudgment } from '../../test/fixtures/criterionJudgment.ts';
import { parseAgentPluginInstallationReceipt } from '../contracts/pluginReceipt.ts';
import { defaultForgeEngine } from '../engine.ts';
import { executeEvalWithTestHooks } from '../execution/execute.ts';
import { runExperiment } from '../experiment.ts';
import { parseExperimentRunReport } from '../experimentReport.ts';
import { mcpToolRefusalWarnings } from '../mcpToolRefusals.ts';
import { createArtifactStore } from '../results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.ts';
import {
  ORIGINAL_JUDGMENT,
  runJudgedFixture,
  temporaryRoot,
} from './__tests__/judgedFixture.ts';
import { REGRADE_SUMMARY_FORMAT, regradeExperimentRun } from './experiment.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const failingJudgment = JSON.stringify(criterionJudgment(false, 'Not shown.'));

function dependencies(responses: string[]) {
  const scripted = createScriptedCompletionProvider({
    id: 'anthropic',
    responses,
  });
  return {
    scripted,
    dependencies: {
      completionProviders: new Map([['anthropic', scripted.provider]]),
      credentialResolver: createStaticCredentialResolver(),
    },
  };
}

describe('regradeExperimentRun', () => {
  it('uses worker-verified source data without a serial report verification pass', async () => {
    const root = await temporaryRoot('forge-regrade-verify-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    let verifications = 0;
    const deps = dependencies([failingJudgment]);
    const engine = {
      ...defaultForgeEngine,
      async verifyCompletedRun(location: string) {
        verifications += 1;
        return defaultForgeEngine.verifyCompletedRun(location);
      },
    };
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        output: path.join(root, 'regrade'),
      },
      { ...deps.dependencies, engine },
    );
    assert.deepEqual(summary.failed, []);
    assert.equal(summary.regraded, 1);
    assert.equal(verifications, 2); // Source inspection and regrade worker, with no third report pass.
  });

  it('regrades completed runs into a separate report and reuses them on rerun', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const log = path.join(source.experimentLocation, 'events.jsonl');
    const events = await fs.readFile(log);
    assert.ok(events.byteLength > 0);
    const resultPath = path.join(source.runLocation, 'result.json');
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    result.warnings.push(
      ...mcpToolRefusalWarnings({ state: 'available', count: 1 }),
    );
    await fs.writeFile(resultPath, JSON.stringify(result));
    const output = path.join(root, 'regrade-opus');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    const first = dependencies([failingJudgment]);
    const summary = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      first.dependencies,
    );
    assert.equal(summary.format, REGRADE_SUMMARY_FORMAT);
    assert.deepEqual(summary.mean_confidence, { mean: 1, evaluations: 1 });
    assert.deepEqual(summary.expected_score, {
      experimental: true,
      mean: 0,
      evaluations: 1,
    });
    assert.equal(summary.regraded, 1);
    assert.equal(summary.reused, 0);
    assert.deepEqual(summary.headline, {
      view: 'must_should_average',
      score: 0,
      evaluations: 1,
    });
    const savedSummary = JSON.parse(
      await fs.readFile(path.join(output, 'regrade.json'), 'utf8'),
    );
    assert.equal(Object.keys(savedSummary)[0], 'headline');
    assert.deepEqual(savedSummary.headline, summary.headline);
    assert.deepEqual(summary.failed, []);
    assert.equal(first.scripted.calls.length, 1);

    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(report.summary.completed, 1);
    assert.deepEqual(report.runs[0]!.warnings?.[0]?.mcp_tool_refusals, {
      state: 'available',
      count: 1,
    });
    assert.equal(report.runs[0]!.evaluation!.score, 0);
    assert.equal(report.runs[0]!.evaluation!.mean_confidence, 1);
    assert.equal(report.runs[0]!.evaluation!.expected_score, 0);
    assert.deepEqual(report.summary.expected_score, summary.expected_score);
    assert.deepEqual(savedSummary.expected_score, summary.expected_score);
    assert.equal(
      report.runs[0]!.result_path,
      'runs/regrade-source/result.json',
    );
    const saved = JSON.parse(
      await fs.readFile(
        path.join(output, 'runs', 'regrade-source.json'),
        'utf8',
      ),
    );
    assert.deepEqual(saved.judge, judge);
    assert.equal(saved.source.original_evaluation.score, 1);
    assert.ok(
      saved.completion_calls.every(
        (call: { purpose: string }) => call.purpose === 'judge',
      ),
    );
    assert.equal(
      report.runs[0]!.rate_limit_wait_ms,
      saved.completion_call_totals.rate_limit_wait_ms,
    );
    assert.equal(report.summary.rate_limit_wait_ms, 0);

    // A rerun with the same judge reuses the saved regrade without judge calls.
    const second = dependencies([]);
    const rerun = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      second.dependencies,
    );
    assert.equal(rerun.reused, 1);
    assert.equal(rerun.regraded, 0);
    assert.equal(second.scripted.calls.length, 0);
    const reusedReport = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.deepEqual(reusedReport.runs[0]!.warnings, report.runs[0]!.warnings);

    // Reusing a legacy regrade cannot invent a measured wait total.
    delete saved.completion_call_totals;
    await fs.writeFile(
      path.join(output, 'runs', 'regrade-source.json'),
      JSON.stringify(saved),
    );
    const legacy = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      second.dependencies,
    );
    assert.equal(legacy.reused, 1);
    const legacyReport = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(legacyReport.runs[0]!.rate_limit_wait_ms, undefined);
    assert.equal(legacyReport.summary.rate_limit_wait_ms, undefined);
    assert.equal(second.scripted.calls.length, 0);

    // The source experiment run is untouched and still has its original score.
    const sourceReport = parseExperimentRunReport(
      JSON.parse(
        await fs.readFile(
          path.join(source.experimentLocation, 'report.json'),
          'utf8',
        ),
      ),
    );
    assert.equal(sourceReport.runs[0]!.evaluation!.score, 1);
    assert.deepEqual(await fs.readFile(log), events);
  });

  it('retains verified bundle differences through regrade, reuse, checks-only, and saved errors', async () => {
    const root = await temporaryRoot('forge-regrade-bundles-');
    roots.push(root);
    const source = path.join(root, 'source');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    const receipts = ['a', 'b'].map((hex) =>
      parseAgentPluginInstallationReceipt({
        adapter: 'claude-code',
        plugin: 'stripe@claude-plugins-official',
        native_plugin_id: 'stripe@claude-plugins-official',
        marketplace: 'anthropics/claude-plugins-official',
        marketplace_commit: 'c'.repeat(40),
        version: '1.0.0',
        source: { kind: 'git-subdir', path: 'plugin', commit: 'd'.repeat(40) },
        dropped_parts: [],
        installed_tree: {
          format: 'forge-plugin-tree-v1',
          sha256: `sha256:${hex.repeat(64)}`,
          entry_count: 1,
          file_count: 1,
          size_bytes: 10,
        },
      }),
    );
    const agent = {
      ...createScriptedAgentAdapter({
        id: 'claude-code',
        turns: Array.from({ length: 2 }, () => ({
          text: 'Task is complete.',
          sessionId: 'bundle-session',
          toolCalls: [],
        })),
      }).adapter,
      pluginInstaller: {
        supportsMcpBearerAuth: true as const,
        preflight() {
          return {
            requirements: { executables: [], stateDirectories: [] },
            async install(context: { runId: string }) {
              return receipts[context.runId === 'judged' ? 0 : 1]!;
            },
          };
        },
      },
    };
    const composition = {
      runtime: createFakeRuntimeAdapter().adapter,
      agents: new Map([[agent.id, agent]]),
      ...dependencies([ORIGINAL_JUDGMENT]).dependencies,
      credentialResolver: createStaticCredentialResolver({
        'env:STRIPE_API_KEY': 'synthetic-test-key',
      }),
      artifactStore: createArtifactStore({ root: source }),
      inputProvider: createMemoryRunInputProvider(),
    };
    const plans = ['judged', 'checks', 'errored'].map((kind) =>
      createTestResolvedRunPlan({
        caseId: `testing/${kind}`,
        agent: { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
        treatment: 'plugin',
        treatmentSetup: [{ uses: 'forge/plugin', with: { plugin: 'stripe' } }],
        ...(kind === 'judged' ? { judge } : {}),
        ...(kind === 'errored'
          ? { mode: 'multi_turn' as const, rolePlayer: judge }
          : {}),
        judgingCriteria:
          kind === 'judged' ? [{ value: 'Task is complete.' }] : [],
      }),
    );
    const runIds = ['judged', 'checks', 'errored'];
    await runExperiment({
      root: source,
      plans,
      composition,
      engine: defaultForgeEngine,
      resume: false,
      signal: new AbortController().signal,
      execute: (input) => {
        const provider = createScriptedCompletionProvider({
          id: 'anthropic',
          responses: Array.from({ length: 3 }, () => new Error('unavailable')),
        }).provider;
        return executeEvalWithTestHooks(
          {
            ...input,
            composition:
              input.runId === 'errored'
                ? {
                    ...composition,
                    completionProviders: new Map([[provider.id, provider]]),
                  }
                : composition,
          },
          { waitBeforeCompletionRetry: async () => undefined },
        );
      },
      runIdFactory: () => runIds.shift()!,
      progress: () => undefined,
    });
    const original = await fs.readFile(
      path.join(source, 'report.json'),
      'utf8',
    );
    const output = path.join(root, 'regrade');
    for (const reused of [false, true]) {
      const scripted = dependencies(reused ? [] : [failingJudgment]);
      const summary = await regradeExperimentRun(
        { experimentRun: source, judge, output },
        scripted.dependencies,
      );
      assert.equal(summary.regraded, reused ? 0 : 1);
      assert.equal(summary.reused, reused ? 1 : 0);
      assert.equal(summary.not_judged, 1);
      assert.equal(summary.not_completed, 1);
      assert.deepEqual(summary.failed, []);
      const report = parseExperimentRunReport(
        JSON.parse(await fs.readFile(summary.report, 'utf8')),
      );
      assert.deepEqual(
        report.runs.map((run) => run.plugin_installations),
        [[receipts[0]], [receipts[1]], [receipts[1]]],
      );
      assert.equal(report.runs[2]!.state, 'errored');
      assert.deepEqual(report.plugin_bundle_comparisons, [
        {
          treatment: 'plugin',
          status: 'different',
          selection_indices: [0, 1, 2],
          compared_fields: [
            {
              installation_index: 0,
              fields: [
                'plugin',
                'marketplace',
                'version',
                'source.kind',
                'source.path',
                'source.commit',
                'installed_tree',
                'dropped_parts',
              ],
            },
          ],
        },
      ]);
    }
    assert.equal(
      await fs.readFile(path.join(source, 'report.json'), 'utf8'),
      original,
    );
  });

  it('refuses to mix judges in one output and leaves that run unscored', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        output,
      },
      dependencies([ORIGINAL_JUDGMENT]).dependencies,
    );
    const other = dependencies([ORIGINAL_JUDGMENT]);
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        output,
      },
      other.dependencies,
    );
    assert.equal(other.scripted.calls.length, 0);
    assert.equal(summary.failed.length, 1);
    assert.match(summary.failed[0]!.message, /different judge/);
    const report = parseExperimentRunReport(
      JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')),
    );
    assert.equal(report.runs[0]!.state, 'pending');
  });

  it('records the judge method, reads older mode names, and refuses to mix methods', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regrade');
    const judge = { provider: 'anthropic', model: 'claude-opus-4-6' };
    const first = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      dependencies([ORIGINAL_JUDGMENT]).dependencies,
    );
    assert.equal(first.judge_mode, 'explained');
    assert.equal(Object.hasOwn(first, 'judge_candidates'), false);
    const file = path.join(
      output,
      'runs',
      (await fs.readdir(path.join(output, 'runs')))[0]!,
    );
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.judge_mode, 'explained');
    // A regrade written before the rename recorded `standard`; it still counts as explained.
    await fs.writeFile(
      file,
      JSON.stringify({ ...saved, judge_mode: 'standard' }),
    );
    const legacy = dependencies([ORIGINAL_JUDGMENT]);
    const reused = await regradeExperimentRun(
      { experimentRun: source.experimentLocation, judge, output },
      legacy.dependencies,
    );
    assert.equal(legacy.scripted.calls.length, 0);
    assert.equal(reused.reused, 1);
    const other = dependencies([ORIGINAL_JUDGMENT]);
    const summary = await regradeExperimentRun(
      {
        experimentRun: source.experimentLocation,
        judge,
        judgeMethod: { mode: 'verbalized-sampling', candidates: 5 },
        output,
      },
      other.dependencies,
    );
    assert.equal(other.scripted.calls.length, 0);
    assert.equal(summary.judge_mode, 'verbalized-sampling');
    assert.equal(summary.judge_candidates, 5);
    assert.match(summary.failed[0]!.message, /different judge/);
  });

  it('rejects an output inside the source experiment run before any work', async () => {
    const root = await temporaryRoot('forge-regrade-exp-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const scripted = dependencies([ORIGINAL_JUDGMENT]);
    await assert.rejects(
      regradeExperimentRun(
        {
          experimentRun: source.experimentLocation,
          judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          output: path.join(source.experimentLocation, 'regrades'),
        },
        scripted.dependencies,
      ),
      /outside the source experiment run/,
    );
    assert.equal(scripted.scripted.calls.length, 0);
  });
});
