import * as assert from 'node:assert/strict';
import fsPromises, * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { credentialReference } from './contracts/credentials.ts';
import { defaultForgeEngine } from './engine.ts';
import { parseCriterionJudgment } from './evaluation/criterionJudge.ts';
import { scoreEvaluation } from './evaluation/score.ts';
import { executeEvalWithTestHooks } from './execution/execute.ts';
import {
  type ExperimentRunOptions,
  ExperimentRunReportError,
  parseExperimentRunReport,
  runExperiment,
} from './experiment.ts';
import {
  buildExperimentRunReport,
  type ExperimentRunReportRunV1,
  serializeExperimentRunReport,
  summarizeReportEvaluation,
} from './experimentReport.ts';
import { sha256Digest } from './model/hashes.ts';
import { createArtifactStore } from './results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from './testing/index.ts';
import { FORGE_BUILD_IDENTITY, FORGE_VERSION } from './version.ts';

const temporaryDirectories: string[] = [];
type MutableExperimentRunOptions = {
  -readonly [K in keyof ExperimentRunOptions]: ExperimentRunOptions[K];
};
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('experiment run scorecards', () => {
  it('records the producing Forge build and reads standalone pending scorecards', () => {
    const pending = row(0);
    Object.assign(pending, {
      state: 'pending',
      run_id: null,
      result_path: null,
      evaluation: null,
      attempt_count: 0,
    });
    const report = build([pending]);
    assert.deepEqual(report.forge, FORGE_BUILD_IDENTITY);
    assert.equal(Object.hasOwn(report, 'schema_version'), false);
    assert.equal(parseExperimentRunReport(report).summary.pending, 1);
    assert.deepEqual(report.summary.criterion_scores, {
      required: { strict: null, avg: null, evaluations: 0 },
      recommended: { strict: null, avg: null, evaluations: 0 },
      blend: { score: null, evaluations: 0 },
    });
    assert.throws(() =>
      parseExperimentRunReport({ ...report, forge: undefined }),
    );
    assert.throws(() =>
      parseExperimentRunReport({
        ...report,
        forge: { ...report.forge, unknown: true },
      }),
    );
    assert.throws(() =>
      parseExperimentRunReport({ ...report, schema_version: 1 }),
    );
    assert.throws(
      () =>
        parseExperimentRunReport({
          forge: { version: '9999.0.0' },
          runs: 'invalid',
        }),
      /incompatible with installed Forge/,
    );
    const diagnosticIdentity = {
      version: FORGE_VERSION,
      commit_sha: 'b'.repeat(40),
      dirty: true,
    };
    assert.deepEqual(
      parseExperimentRunReport({ ...report, forge: diagnosticIdentity }).forge,
      diagnosticIdentity,
    );
  });

  it('permits different development releases only when the reader is also a development build', () => {
    const report = {
      ...build([row(0)]),
      forge: {
        version: '9999.0.0-dev.123',
        commit_sha: 'c'.repeat(40),
        dirty: false,
      },
    };
    if (/^\d+\.\d+\.\d+-dev(?:\.|$)/.test(FORGE_VERSION)) {
      assert.deepEqual(parseExperimentRunReport(report).forge, report.forge);
    } else {
      assert.throws(
        () => parseExperimentRunReport(report),
        /incompatible with installed Forge/,
      );
    }
  });

  it('keeps Codex hook policies in report coordinates and separates their score groups', () => {
    const runs = [row(0), row(1)];
    runs[0]!.selection.agent = {
      adapter: 'codex',
      provider: 'openai',
      model: 'gpt',
      hook_trust: 'native',
    };
    runs[1]!.selection.agent = {
      ...runs[0]!.selection.agent,
      hook_trust: 'automation',
    };
    const report = build(runs);
    assert.equal(report.cases.length, 2);
    assert.deepEqual(
      report.cases.map(({ agent }) => agent.hook_trust),
      ['native', 'automation'],
    );
    assert.deepEqual(parseExperimentRunReport(report), report);
  });

  it('rejects former judging counter and score aggregate fields', () => {
    const report = build([row(0)]);
    assert.throws(() =>
      parseExperimentRunReport({
        ...report,
        summary: {
          ...report.summary,
          guideline_score: report.summary.judging_score,
        },
      }),
    );
    const { judging_score, ...summary } = report.summary;
    assert.throws(() =>
      parseExperimentRunReport({
        ...report,
        summary: { ...summary, guideline_score: judging_score },
      }),
    );
    for (const former of ['guidelines_passed', 'guidelines_total']) {
      assert.throws(() =>
        parseExperimentRunReport({
          ...report,
          runs: [
            {
              ...report.runs[0],
              evaluation: { ...report.runs[0]!.evaluation, [former]: 0 },
            },
          ],
        }),
      );
    }
  });
  it('groups repetitions by exact case/treatment/agent coordinates and separates execution coverage from scores', () => {
    const runs = [row(0), row(1), row(2), row(3), row(4), row(5)];
    runs[0]!.evaluation = evaluation(2, 2, 'passed');
    runs[1]!.evaluation = evaluation(1, 2, 'partial');
    runs[2]!.evaluation = evaluation(0, 2, 'failed');
    runs[3]!.selection.treatment = 'other';
    runs[4]!.selection.agent.model = 'other-model';
    runs[4]!.state = 'errored';
    runs[4]!.evaluation = null;
    runs[4]!.error_code = 'agent_failed';
    runs[4]!.result_path = null;
    runs[4]!.attempt_count = 2;
    runs[5]!.selection.case_id = 'testing/second';
    runs[5]!.state = 'pending';
    runs[5]!.run_id = null;
    runs[5]!.evaluation = null;
    runs[5]!.result_path = null;
    runs[5]!.attempt_count = 0;
    const report = build(runs);
    assert.deepEqual(report.summary, {
      selections: 6,
      completed: 4,
      errored: 1,
      pending: 1,
      passed: 2,
      partial: 1,
      failed: 1,
      attempts_total: 6,
      retry_attempts: 1,
      judge_errors: { evaluations: 0, criteria: 0 },
      coverage: 4 / 6,
      pass_rate: 0.5,
      judging_score: { mean: 0.5, evaluations: 3 },
      criterion_scores: {
        required: { strict: null, avg: null, evaluations: 0 },
        recommended: { strict: 1 / 3, avg: 0.5, evaluations: 3 },
        blend: { score: 0.5, evaluations: 3 },
      },
      criteria_by_requirement: {
        MUST: {
          passed: 0,
          total: 0,
          evaluations: 0,
          judged_evaluations: 0,
          fully_judged_evaluations: 0,
          errored: 0,
          strict_pass_rate: null,
          average_pass_rate: null,
        },
        SHOULD: {
          passed: 3,
          total: 6,
          evaluations: 3,
          judged_evaluations: 3,
          fully_judged_evaluations: 3,
          errored: 0,
          strict_pass_rate: 1 / 3,
          average_pass_rate: 0.5,
        },
        OPTIONAL: {
          passed: 0,
          total: 0,
          evaluations: 0,
          judged_evaluations: 0,
          fully_judged_evaluations: 0,
          errored: 0,
          strict_pass_rate: null,
          average_pass_rate: null,
        },
      },
    });
    assert.equal(report.cases.length, 4);
    assert.equal(report.cases[0]!.selections, 3);
    assert.equal(report.cases[0]!.judging_score.mean, 0.5);
    assert.deepEqual(report.cases[0]!.criterion_scores, {
      required: { strict: null, avg: null, evaluations: 0 },
      recommended: { strict: 1 / 3, avg: 0.5, evaluations: 3 },
      blend: { score: 0.5, evaluations: 3 },
    });
    for (const group of report.cases.slice(1)) {
      assert.deepEqual(group.criterion_scores, {
        required: { strict: null, avg: null, evaluations: 0 },
        recommended: { strict: null, avg: null, evaluations: 0 },
        blend: { score: null, evaluations: 0 },
      });
    }
    assert.equal(report.cases[1]!.judging_score.mean, null);
    assert.equal(report.cases[2]!.pass_rate, null);
    assert.equal(report.cases[3]!.coverage, 0);
    assert.equal(report.checkpoint_sha256, sha256Digest('{}\n'));
  });

  it('separates MUST failures, SHOULD failures, and non-scoring telemetry', () => {
    const runs = [row(0), row(1), row(2), row(3)];
    runs[0]!.evaluation = summarizeReportEvaluation(
      scoreEvaluation(
        [
          judgment('MUST', false),
          judgment('MUST', true),
          judgment('SHOULD', true),
          judgment('OPTIONAL', true),
        ],
        [],
      ),
    );
    runs[1]!.evaluation = summarizeReportEvaluation(
      scoreEvaluation(
        [
          judgment('MUST', true),
          judgment(undefined, false),
          judgment('OPTIONAL', false),
        ],
        [],
      ),
    );
    // Checks-only and pending runs do not enter any criterion-group denominator.
    Object.assign(runs[3]!, {
      state: 'pending',
      run_id: null,
      attempt_count: 0,
      result_path: null,
      evaluation: null,
    });
    const report = build(runs);
    assert.deepEqual(
      report.runs.map((run) => run.evaluation?.criterion_scores ?? null),
      [
        {
          required: { strict: 0, avg: 1 / 2 },
          recommended: { strict: 0, avg: 2 / 3 },
          blend: { score: 0 },
        },
        {
          required: { strict: 1, avg: 1 },
          recommended: { strict: 0, avg: 1 / 2 },
          blend: { score: 0 },
        },
        {
          required: { strict: null, avg: null },
          recommended: { strict: null, avg: null },
          blend: { score: null },
        },
        null,
      ],
    );
    // Avg pools criteria across runs, so a larger set carries more weight.
    assert.deepEqual(report.summary.criterion_scores, {
      required: { strict: 0.5, avg: 2 / 3, evaluations: 2 },
      recommended: { strict: 0, avg: 3 / 5, evaluations: 2 },
      blend: { score: 0, evaluations: 2 },
    });
    assert.deepEqual(
      report.cases[0]!.criterion_scores,
      report.summary.criterion_scores,
    );
    assert.deepEqual(report.summary.criteria_by_requirement, {
      MUST: {
        passed: 2,
        total: 3,
        evaluations: 2,
        judged_evaluations: 2,
        fully_judged_evaluations: 2,
        errored: 0,
        strict_pass_rate: 0.5,
        average_pass_rate: 0.75,
      },
      SHOULD: {
        passed: 1,
        total: 2,
        evaluations: 2,
        judged_evaluations: 2,
        fully_judged_evaluations: 2,
        errored: 0,
        strict_pass_rate: 0.5,
        average_pass_rate: 0.5,
      },
      OPTIONAL: {
        passed: 1,
        total: 2,
        evaluations: 2,
        judged_evaluations: 2,
        fully_judged_evaluations: 2,
        errored: 0,
        strict_pass_rate: 0.5,
        average_pass_rate: 0.5,
      },
    });
    assert.deepEqual(
      report.cases[0]!.criteria_by_requirement,
      report.summary.criteria_by_requirement,
    );
    assert.equal(report.summary.judging_score.mean, (2 / 3 + 1 / 2) / 2);
    assert.equal(
      report.runs[0]!.evaluation!.criteria_by_requirement.MUST.passed,
      1,
    );
    assert.equal(
      report.runs[1]!.evaluation!.criteria_by_requirement.SHOULD.passed,
      0,
    );
    assert.deepEqual(
      parseExperimentRunReport(
        JSON.parse(serializeExperimentRunReport(report)),
      ),
      report,
    );
  });

  it.each([
    {
      name: 'a failed MUST cannot be hidden by a passed SHOULD',
      criteria: [judgment('MUST', false), judgment('SHOULD', true)],
      required: { strict: 0, avg: 0 },
      recommended: { strict: 0, avg: 0.5 },
      blend: { score: 0 },
    },
    {
      name: 'a failed SHOULD affects Recommended while Required passes',
      criteria: [judgment('MUST', true), judgment('SHOULD', false)],
      required: { strict: 1, avg: 1 },
      recommended: { strict: 0, avg: 0.5 },
      blend: { score: 0 },
    },
    {
      name: 'a failed OPTIONAL does not affect either score',
      criteria: [
        judgment('MUST', true),
        judgment('SHOULD', true),
        judgment('OPTIONAL', false),
      ],
      required: { strict: 1, avg: 1 },
      recommended: { strict: 1, avg: 1 },
      blend: { score: 1 },
    },
    {
      name: 'no MUST leaves Required empty while SHOULD is scored',
      criteria: [judgment('SHOULD', true), judgment('SHOULD', false)],
      required: { strict: null, avg: null },
      recommended: { strict: 0, avg: 0.5 },
      blend: { score: 0.5 },
    },
    {
      name: 'MUST alone contributes to both sets',
      criteria: [judgment('MUST', false)],
      required: { strict: 0, avg: 0 },
      recommended: { strict: 0, avg: 0 },
      blend: { score: 0 },
    },
    {
      name: 'MUST alone earns full credit when all pass',
      criteria: [judgment('MUST', true)],
      required: { strict: 1, avg: 1 },
      recommended: { strict: 1, avg: 1 },
      blend: { score: 1 },
    },
    {
      name: 'passing MUST gates the SHOULD average without adding to it',
      criteria: [
        judgment('MUST', true),
        judgment('MUST', true),
        judgment('SHOULD', true),
        judgment('SHOULD', false),
      ],
      required: { strict: 1, avg: 1 },
      recommended: { strict: 0, avg: 0.75 },
      blend: { score: 0.5 },
    },
    {
      name: 'one failed MUST gates a mixed required set and passing SHOULD',
      criteria: [
        judgment('MUST', true),
        judgment('MUST', false),
        judgment('SHOULD', true),
        judgment('SHOULD', true),
      ],
      required: { strict: 0, avg: 0.5 },
      recommended: { strict: 0, avg: 0.75 },
      blend: { score: 0 },
    },
    {
      name: 'an errored MUST leaves Blend and Recommended Strict unresolved',
      criteria: [judgment('MUST', null), judgment('SHOULD', true)],
      required: { strict: null, avg: null },
      recommended: { strict: null, avg: 1 },
      blend: { score: null },
    },
    {
      name: 'errored MUST and SHOULD leave Strict and Blend unresolved but retain Avg',
      criteria: [
        judgment('MUST', null),
        judgment('SHOULD', null),
        judgment('SHOULD', true),
        judgment('SHOULD', false),
      ],
      required: { strict: null, avg: null },
      recommended: { strict: null, avg: 0.5 },
      blend: { score: null },
    },
    {
      name: 'a passed MUST and an errored MUST leave Required Strict unresolved',
      criteria: [judgment('MUST', null), judgment('MUST', true)],
      required: { strict: null, avg: 1 },
      recommended: { strict: null, avg: 1 },
      blend: { score: null },
    },
    {
      name: 'all-error SHOULD leaves Blend unresolved despite a passing MUST',
      criteria: [judgment('MUST', true), judgment('SHOULD', null)],
      required: { strict: 1, avg: 1 },
      recommended: { strict: null, avg: 1 },
      blend: { score: null },
    },
    {
      name: 'a valid MUST failure still gates Blend alongside judge errors',
      criteria: [
        judgment('MUST', false),
        judgment('MUST', null),
        judgment('SHOULD', true),
      ],
      required: { strict: null, avg: 0 },
      recommended: { strict: null, avg: 0.5 },
      blend: { score: 0 },
    },
    {
      name: 'a SHOULD error leaves Strict unresolved while Blend uses valid SHOULD',
      criteria: [judgment('SHOULD', null), judgment('SHOULD', true)],
      required: { strict: null, avg: null },
      recommended: { strict: null, avg: 1 },
      blend: { score: 1 },
    },
    {
      name: 'all-error MUST and SHOULD leave every view empty',
      criteria: [judgment('MUST', null), judgment('SHOULD', null)],
      required: { strict: null, avg: null },
      recommended: { strict: null, avg: null },
      blend: { score: null },
    },
    {
      name: 'an OPTIONAL error does not affect any score',
      criteria: [judgment('MUST', true), judgment('OPTIONAL', null)],
      required: { strict: 1, avg: 1 },
      recommended: { strict: 1, avg: 1 },
      blend: { score: 1 },
    },
    {
      name: 'OPTIONAL alone leaves both sets empty',
      criteria: [judgment('OPTIONAL', false)],
      required: { strict: null, avg: null },
      recommended: { strict: null, avg: null },
      blend: { score: null },
    },
  ])(
    'scores the criterion views: $name',
    ({ criteria, required, recommended, blend }) => {
      const run = row(0);
      run.evaluation = summarizeReportEvaluation(scoreEvaluation(criteria, []));
      const report = build([run]);
      assert.deepEqual(report.runs[0]!.evaluation!.criterion_scores, {
        required,
        recommended,
        blend,
      });
      assert.deepEqual(report.summary.criterion_scores, {
        required: {
          ...required,
          evaluations: Number(
            criteria.some((criterion) => criterion.requirement_level === 'MUST'),
          ),
        },
        recommended: {
          ...recommended,
          evaluations: Number(
            criteria.some(
              (criterion) => criterion.requirement_level !== 'OPTIONAL',
            ),
          ),
        },
        blend: { ...blend, evaluations: blend.score === null ? 0 : 1 },
      });
      assert.deepEqual(
        report.cases[0]!.criterion_scores,
        report.summary.criterion_scores,
      );
    },
  );

  it('excludes unresolved Strict and Blend votes while pooling valid judgments from judge-error runs', () => {
    const criteria = [
      [
        judgment('MUST', null),
        judgment('SHOULD', true),
        judgment('SHOULD', false),
      ],
      [judgment('MUST', true), judgment('SHOULD', null)],
      [judgment('MUST', null), judgment('SHOULD', null)],
    ];
    const runs = criteria.map((judgments, index) => ({
      ...row(index),
      evaluation: summarizeReportEvaluation(scoreEvaluation(judgments, [])),
    }));
    const report = build(runs);
    assert.deepEqual(report.summary.criterion_scores, {
      required: { strict: 1, avg: 1, evaluations: 3 },
      recommended: { strict: null, avg: 2 / 3, evaluations: 3 },
      blend: { score: null, evaluations: 0 },
    });
    assert.deepEqual(
      report.cases[0]!.criterion_scores,
      report.summary.criterion_scores,
    );
    assert.deepEqual(report.summary.judge_errors, {
      evaluations: 3,
      criteria: 4,
    });
    assert.equal(report.summary.pass_rate, null);
    assert.deepEqual(report.summary.judging_score, {
      mean: 0.75,
      evaluations: 2,
    });
    assert.deepEqual(
      report.runs.map((run) => run.evaluation!.status),
      ['judge_error', 'judge_error', 'judge_error'],
    );
    for (const view of ['required', 'recommended', 'blend'] as const) {
      const changed = structuredClone(report);
      const scores = changed.runs[2]!.evaluation!.criterion_scores;
      if (view === 'blend') scores.blend.score = 0;
      else scores[view].strict = 0;
      assert.throws(
        () => parseExperimentRunReport(changed),
        /Criterion scores must match/,
      );
    }
    assert.deepEqual(
      parseExperimentRunReport(
        JSON.parse(serializeExperimentRunReport(report)),
      ),
      report,
    );
  });

  it.each([
    {
      name: 'MUST error and SHOULD pass',
      criteria: [judgment('MUST', null), judgment('SHOULD', true)],
      requiredAvg: 0.5,
    },
    {
      name: 'MUST pass and MUST error',
      criteria: [judgment('MUST', true), judgment('MUST', null)],
      requiredAvg: 2 / 3,
    },
  ])(
    'excludes unresolved votes from mixed aggregates: $name',
    ({ criteria, requiredAvg }) => {
      const runs = [
        criteria,
        [judgment('MUST', true), judgment('SHOULD', true)],
        [judgment('MUST', false), judgment('SHOULD', true)],
      ].map((judgments, index) => ({
        ...row(index),
        evaluation: summarizeReportEvaluation(scoreEvaluation(judgments, [])),
      }));
      const report = build(runs);
      assert.deepEqual(report.summary.criterion_scores, {
        required: { strict: 0.5, avg: requiredAvg, evaluations: 3 },
        recommended: { strict: 0.5, avg: 4 / 5, evaluations: 3 },
        blend: { score: 0.5, evaluations: 2 },
      });
      assert.deepEqual(
        report.cases[0]!.criterion_scores,
        report.summary.criterion_scores,
      );
      for (const scope of ['summary', 'cases'] as const) {
        const changed = structuredClone(report);
        const scores =
          scope === 'summary'
            ? changed.summary.criterion_scores
            : changed.cases[0]!.criterion_scores;
        scores.recommended.strict = 2 / 3;
        assert.throws(
          () => parseExperimentRunReport(changed),
          /statistics do not match/,
        );
      }
      assert.deepEqual(
        parseExperimentRunReport(
          JSON.parse(serializeExperimentRunReport(report)),
        ),
        report,
      );
    },
  );

  it('averages Blend per evaluation after gating and keeps failed MUST runs in the denominator', () => {
    const runs = [row(0), row(1), row(2), row(3), row(4), row(5)];
    const criteria = [
      [judgment('MUST', false), judgment('SHOULD', true)],
      [
        judgment('MUST', true),
        judgment('SHOULD', true),
        judgment('SHOULD', true),
        judgment('SHOULD', false),
        judgment('SHOULD', false),
      ],
      [judgment('MUST', true)],
    ];
    for (const [index, judgments] of criteria.entries()) {
      runs[index]!.evaluation = summarizeReportEvaluation(
        scoreEvaluation(judgments, [{ name: 'file', passed: false }]),
      );
    }
    // Checks-only, errored, and pending rows carry no Blend score.
    Object.assign(runs[4]!, {
      state: 'errored',
      evaluation: null,
      error_code: 'agent_failed',
      result_path: null,
    });
    Object.assign(runs[5]!, {
      state: 'pending',
      run_id: null,
      attempt_count: 0,
      result_path: null,
      evaluation: null,
    });
    const report = build(runs);
    assert.deepEqual(
      report.runs.map((run) => run.evaluation?.criterion_scores.blend ?? null),
      [{ score: 0 }, { score: 0.5 }, { score: 1 }, { score: null }, null, null],
    );
    assert.deepEqual(report.summary.criterion_scores.blend, {
      score: 0.5,
      evaluations: 3,
    });
    assert.deepEqual(
      report.cases[0]!.criterion_scores.blend,
      report.summary.criterion_scores.blend,
    );
    // Blend is a report view; the canonical score and check-constrained status remain intact.
    assert.equal(report.runs[0]!.evaluation!.score, 0.5);
    assert.equal(report.runs[0]!.evaluation!.status, 'partial');
    assert.deepEqual(
      parseExperimentRunReport(
        JSON.parse(serializeExperimentRunReport(report)),
      ),
      report,
    );
  });

  it('excludes unavailable judgments from requirement-group rates and verifies their error counts', () => {
    function judgment(
      requirement_level: 'MUST' | 'SHOULD' | 'OPTIONAL',
      passed: boolean | null,
    ) {
      const raw =
        passed === null
          ? '{}'
          : JSON.stringify({
              results: [{ index: 0, passed, explanation: 'Judged.' }],
            });
      return parseCriterionJudgment(raw, {
        value: 'The answer MUST be complete.',
        requirement_level,
      });
    }
    const runs = [row(0), row(1), row(2)];
    const judgments = [
      [
        judgment('MUST', true),
        judgment('MUST', null),
        judgment('SHOULD', false),
        judgment('OPTIONAL', null),
      ],
      [
        judgment('MUST', false),
        judgment('SHOULD', null),
        judgment('OPTIONAL', true),
      ],
      [
        judgment('MUST', null),
        judgment('SHOULD', true),
        judgment('OPTIONAL', null),
      ],
    ];
    for (const [index, run] of runs.entries()) {
      run.evaluation = summarizeReportEvaluation(
        scoreEvaluation(judgments[index]!, []),
      );
    }
    const report = build(runs);
    assert.deepEqual(report.summary.criteria_by_requirement, {
      MUST: {
        passed: 1,
        total: 4,
        errored: 2,
        evaluations: 3,
        judged_evaluations: 2,
        fully_judged_evaluations: 1,
        strict_pass_rate: 0,
        average_pass_rate: 0.5,
      },
      SHOULD: {
        passed: 1,
        total: 3,
        errored: 1,
        evaluations: 3,
        judged_evaluations: 2,
        fully_judged_evaluations: 2,
        strict_pass_rate: 0.5,
        average_pass_rate: 0.5,
      },
      OPTIONAL: {
        passed: 1,
        total: 3,
        errored: 2,
        evaluations: 3,
        judged_evaluations: 1,
        fully_judged_evaluations: 1,
        strict_pass_rate: 1,
        average_pass_rate: 1,
      },
    });
    assert.deepEqual(report.summary.judge_errors, {
      evaluations: 3,
      criteria: 5,
    });
    assert.deepEqual(report.summary.criterion_scores, {
      required: { strict: 0, avg: 0.5, evaluations: 3 },
      recommended: { strict: null, avg: 0.5, evaluations: 3 },
      blend: { score: 0, evaluations: 1 },
    });
    assert.deepEqual(
      report.cases[0]!.criterion_scores,
      report.summary.criterion_scores,
    );
    const changedScores = structuredClone(report);
    changedScores.runs[2]!.evaluation!.criterion_scores.blend.score = 0;
    assert.throws(
      () => parseExperimentRunReport(changedScores),
      /Criterion scores must match/,
    );
    assert.equal(report.summary.pass_rate, null);
    assert.equal(report.summary.judging_score.mean, 0.5);
    assert.deepEqual(
      report.cases[0]!.criteria_by_requirement,
      report.summary.criteria_by_requirement,
    );
    for (const requirement of ['MUST', 'OPTIONAL'] as const) {
      const changed = structuredClone(report);
      changed.runs[0]!.evaluation!.criteria_by_requirement[
        requirement
      ].errored = 0;
      assert.throws(
        () => parseExperimentRunReport(changed),
        /counts must match/,
      );
    }
    for (const field of [
      'errored',
      'judged_evaluations',
      'fully_judged_evaluations',
    ] as const) {
      const changed = structuredClone(report);
      changed.summary.criteria_by_requirement.MUST[field] += 1;
      assert.throws(
        () => parseExperimentRunReport(changed),
        /statistics do not match/,
      );
    }
  });

  it('rejects false classifications, scores, and requirement-group aggregates', () => {
    const run = row(0);
    run.evaluation = evaluation(1, 2, 'partial');
    const report = build([run]);
    for (const change of [
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criteria_by_requirement.SHOULD.total = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criteria_by_requirement.MUST.passed = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.score = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criterion_scores.recommended.strict = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criterion_scores.recommended.avg = null;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criterion_scores.required.strict = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criterion_scores.blend.score = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.criterion_scores.blend.score = null;
      },
      (value: typeof report) => {
        value.summary.criterion_scores.blend.score = 1;
      },
      (value: typeof report) => {
        value.summary.criterion_scores.blend.evaluations = 0;
      },
      (value: typeof report) => {
        value.cases[0]!.criterion_scores.blend.score = 1;
      },
      (value: typeof report) => {
        value.summary.criterion_scores.recommended.avg = 1;
      },
      (value: typeof report) => {
        value.summary.criterion_scores.required.evaluations = 1;
      },
      (value: typeof report) => {
        value.cases[0]!.criterion_scores.recommended.strict = 1;
      },
      (value: typeof report) => {
        Object.assign(value.runs[0]!.evaluation!.criterion_scores, {
          optional: { strict: 1, avg: 1 },
        });
      },
      (value: typeof report) => {
        Object.assign(value.summary.criterion_scores.required, { total: 1 });
      },
      (value: typeof report) => {
        Reflect.deleteProperty(value.runs[0]!.evaluation!, 'criterion_scores');
      },
      (value: typeof report) => {
        Reflect.deleteProperty(value.summary, 'criterion_scores');
      },
      (value: typeof report) => {
        Reflect.deleteProperty(value.cases[0]!, 'criterion_scores');
      },
      (value: typeof report) => {
        value.summary.criteria_by_requirement.SHOULD.strict_pass_rate = 1;
      },
      (value: typeof report) => {
        value.cases[0]!.criteria_by_requirement.OPTIONAL.total = 1;
      },
      (value: typeof report) => {
        Object.assign(value.runs[0]!.evaluation!.criteria_by_requirement, {
          EXCLUDE: { passed: 0, total: 0, errored: 0 },
        });
      },
    ]) {
      const changed = structuredClone(report);
      change(changed);
      assert.throws(() => parseExperimentRunReport(changed));
    }
  });

  it('distinguishes adapter, provider and model while preserving the original selection order', () => {
    const runs = [row(0), row(1), row(2), row(3)];
    runs[1]!.selection.agent.adapter = 'other-agent';
    runs[2]!.selection.agent.provider = 'other-provider';
    runs[3]!.selection.agent.model = 'other-model';
    const report = build(runs);
    assert.equal(report.cases.length, 4);
    assert.deepEqual(
      report.runs.map((run) => run.selection_index),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      report.cases.map((group) => group.agent),
      runs.map((run) => run.selection.agent),
    );
  });

  it('uses status for checks-only pass rates and leaves criterion means unavailable', () => {
    const failed = row(1);
    failed.evaluation = { ...evaluation(0, 0, 'failed'), checks_passed: 0 };
    const report = build([row(0), failed]);
    assert.equal(report.summary.pass_rate, 0.5);
    assert.deepEqual(report.summary.judging_score, {
      mean: null,
      evaluations: 0,
    });
    assert.equal(report.runs[0]!.evaluation!.score, 0);
    assert.equal(report.runs[0]!.evaluation!.checks_passed, 1);
  });

  it('reports all-error judgments separately with unavailable score and pass rate', () => {
    const run = row(0);
    run.evaluation = summarizeReportEvaluation(
      scoreEvaluation([judgment('SHOULD', null)], []),
    );
    const report = build([run]);
    assert.deepEqual(report.summary.judge_errors, {
      evaluations: 1,
      criteria: 1,
    });
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.errored, 0);
    assert.equal(report.summary.pass_rate, null);
    assert.deepEqual(report.summary.criteria_by_requirement.SHOULD, {
      passed: 0,
      total: 1,
      errored: 1,
      evaluations: 1,
      judged_evaluations: 0,
      fully_judged_evaluations: 0,
      strict_pass_rate: null,
      average_pass_rate: null,
    });
    assert.deepEqual(report.summary.judging_score, {
      mean: null,
      evaluations: 0,
    });
    for (const evaluation of [
      { ...run.evaluation, score: 0 },
      { ...run.evaluation, status: 'failed' as const },
      { ...run.evaluation, judging_criteria_errored: 2 },
      { ...run.evaluation, judging_criteria_passed: 1 },
    ])
      assert.throws(() => build([{ ...run, evaluation }]));
    assert.throws(
      () =>
        parseExperimentRunReport({
          ...report,
          summary: {
            ...report.summary,
            judge_errors: { evaluations: 0, criteria: 0 },
          },
        }),
      /statistics/,
    );
  });

  it('rejects unknown fields, false aggregates and invalid run references', () => {
    const report = build([row(0)]);
    for (const mutate of [
      (value: typeof report) => {
        Object.assign(value, { schema_version: 1 });
      },
      (value: typeof report) => {
        Object.assign(value, { transcript: 'not scorecard data' });
      },
      (value: typeof report) => {
        value.summary.passed = 0;
      },
      (value: typeof report) => {
        value.cases[0]!.agent.model = 'different';
      },
      (value: typeof report) => {
        value.runs[0]!.selection_index = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.result_path = '../other/result.json';
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation = null;
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.checks_passed = 2;
      },
      (value: typeof report) => {
        Object.assign(value.runs[0]!, { extra: true });
      },
      (value: typeof report) => {
        Object.assign(value.runs[0]!.evaluation!, { extra: true });
      },
      (value: typeof report) => {
        value.runs[0]!.evaluation!.judging_criteria_passed = 1;
      },
      (value: typeof report) => {
        value.runs[0]!.error_code = 'execution_error';
      },
      (value: typeof report) => {
        value.runs[0]!.state = 'errored';
      },
      (value: typeof report) => {
        value.runs[0]!.state = 'pending';
        value.runs[0]!.run_id = null;
      },
      (value: typeof report) => {
        value.runs[0]!.run_id = '../unsafe';
        value.runs[0]!.result_path = 'runs/../unsafe/result.json';
      },
    ]) {
      const changed = structuredClone(report);
      mutate(changed);
      assert.throws(() => parseExperimentRunReport(changed));
    }
    assert.deepEqual(parseExperimentRunReport(report), report);
    const duplicate = build([row(0), row(1)]);
    duplicate.runs[1]!.run_id = duplicate.runs[0]!.run_id;
    duplicate.runs[1]!.result_path = duplicate.runs[0]!.result_path;
    assert.throws(
      () => parseExperimentRunReport(duplicate),
      /duplicate run IDs/,
    );
  });

  it('writes partial results after execution errors and refreshes only latest attempts on resume', async () => {
    const fixture = await experimentRunFixture();
    let fail = true;
    let verified = 0;
    fixture.options.engine = {
      ...defaultForgeEngine,
      async verifyCompletedRun(location) {
        verified += 1;
        return defaultForgeEngine.verifyCompletedRun(location);
      },
    };
    fixture.options.execute = async (input) => {
      if (fail && input.plan.selection.case_id === 'testing/second')
        throw new Error('private execution failure');
      return defaultForgeEngine.executeEval({
        ...input,
        composition: composition(fixture.root),
      });
    };
    const first = await runExperiment(fixture.options);
    const report = await readReport(first.report);
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.errored, 1);
    assert.equal(report.summary.pass_rate, 1);
    assert.equal(report.summary.coverage, 0.5);
    assert.equal(report.runs[1]!.error_code, 'execution_error');
    assert.equal(report.runs[1]!.evaluation, null);
    assert.equal(
      JSON.stringify(report).includes('private execution failure'),
      false,
    );
    assert.equal(
      report.checkpoint_sha256,
      sha256Digest(await fs.readFile(first.checkpoint)),
    );
    assert.equal(verified, 2, 'report reuses each latest attempt verification');
    const previousResult = await fs.readFile(
      path.join(fixture.root, report.runs[0]!.result_path!),
    );
    fail = false;
    const resumed = await runExperiment({ ...fixture.options, resume: true });
    const refreshed = await readReport(resumed.report);
    assert.equal(resumed.executed, 1);
    assert.equal(refreshed.summary.completed, 2);
    assert.equal(refreshed.summary.errored, 0);
    assert.equal(refreshed.summary.attempts_total, 3);
    assert.equal(refreshed.summary.retry_attempts, 1);
    assert.deepEqual(
      refreshed.runs.map((run) => run.attempt_count),
      [1, 2],
    );
    assert.equal(refreshed.runs[0]!.run_id, report.runs[0]!.run_id);
    assert.notEqual(refreshed.runs[1]!.run_id, report.runs[1]!.run_id);
    assert.deepEqual(
      await fs.readFile(
        path.join(fixture.root, refreshed.runs[0]!.result_path!),
      ),
      previousResult,
    );
    assert.equal(
      refreshed.checkpoint_sha256,
      sha256Digest(await fs.readFile(resumed.checkpoint)),
    );
  });

  it('regenerates missing, corrupt, or older report shapes on a no-op resume without changing eval artifacts', async () => {
    const fixture = await experimentRunFixture();
    const first = await runExperiment(fixture.options);
    const report = await readReport(first.report);
    const checkpoint = await fs.readFile(first.checkpoint);
    for (const shape of ['missing', 'corrupt', 'older']) {
      if (shape === 'missing') await fs.rm(first.report);
      else if (shape === 'corrupt')
        await fs.writeFile(first.report, '{invalid report');
      else {
        const older = structuredClone(report);
        for (const value of [
          older.summary,
          ...older.cases,
          ...older.runs.map((run) => run.evaluation!),
        ]) {
          Reflect.deleteProperty(value, 'criterion_scores');
        }
        assert.throws(() => parseExperimentRunReport(older));
        await fs.writeFile(first.report, JSON.stringify(older));
      }
      const resumed = await runExperiment({
        ...fixture.options,
        resume: true,
        execute: async () => {
          throw new Error('must skip completed evals');
        },
      });
      assert.equal(resumed.executed, 0);
      const restored = await readReport(resumed.report);
      assert.deepEqual(restored.runs, report.runs);
      assert.deepEqual(restored.summary, report.summary);
      assert.deepEqual(await fs.readFile(first.checkpoint), checkpoint);
    }
  });

  it('extracts criterion and check scores from real engine commits and averages repetitions', async () => {
    const fixture = await experimentRunFixture();
    const plan = createTestResolvedRunPlan({
      caseId: 'testing/criteria',
      judgingCriteria: [
        {
          value: 'The answer MUST be complete.',
          requirement_level: 'MUST',
          label: 'correctness',
        },
        {
          value: 'Read docs',
          label: 'source',
          requirement_level: 'OPTIONAL' as const,
        },
      ],
      judge: { provider: 'scripted', model: 'judge' },
      checks: { file_checks: [{ file: 'missing.txt', exists: true }] },
    });
    const repeated = structuredClone(plan);
    repeated.selection.repetition = 1;
    fixture.options.plans = [
      plan,
      defaultForgeEngine.parseResolvedRunPlan(repeated),
    ];
    fixture.options.execute = (input) => {
      const passed = input.plan.selection.repetition === 0;
      const provider = createScriptedCompletionProvider({
        id: 'scripted',
        responses: [
          JSON.stringify({
            results: [{ index: 0, passed, explanation: 'Scripted judgment.' }],
          }),
          JSON.stringify({
            results: [
              { index: 0, passed: !passed, explanation: 'Source observation.' },
            ],
          }),
        ],
      }).provider;
      return defaultForgeEngine.executeEval({
        ...input,
        composition: {
          ...composition(fixture.root),
          completionProviders: new Map([[provider.id, provider]]),
        },
      });
    };
    const provider = createScriptedCompletionProvider({
      id: 'scripted',
    }).provider;
    fixture.options.composition = {
      ...composition(fixture.root),
      completionProviders: new Map([[provider.id, provider]]),
    };
    const summary = await runExperiment(fixture.options);
    const report = await readReport(summary.report);
    assert.equal(report.summary.completed, 2);
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0]!.selections, 2);
    assert.deepEqual(report.summary.judging_score, {
      mean: 0.5,
      evaluations: 2,
    });
    assert.equal(report.summary.pass_rate, 0);
    assert.deepEqual(
      report.runs.map((run) => run.evaluation),
      [
        {
          status: 'partial',
          score: 1,
          judging_criteria_passed: 1,
          judging_criteria_total: 1,
          criterion_scores: {
            required: { strict: 1, avg: 1 },
            recommended: { strict: 1, avg: 1 },
            blend: { score: 1 },
          },
          criteria_by_requirement: {
            MUST: { passed: 1, total: 1, errored: 0 },
            SHOULD: { passed: 0, total: 0, errored: 0 },
            OPTIONAL: { passed: 0, total: 1, errored: 0 },
          },
          judging_criteria_errored: 0,
          judging_criteria_excluded_errored: 0,
          checks_passed: 0,
          checks_total: 1,
        },
        {
          status: 'failed',
          score: 0,
          judging_criteria_passed: 0,
          judging_criteria_total: 1,
          criterion_scores: {
            required: { strict: 0, avg: 0 },
            recommended: { strict: 0, avg: 0 },
            blend: { score: 0 },
          },
          criteria_by_requirement: {
            MUST: { passed: 0, total: 1, errored: 0 },
            SHOULD: { passed: 0, total: 0, errored: 0 },
            OPTIONAL: { passed: 1, total: 1, errored: 0 },
          },
          judging_criteria_errored: 0,
          judging_criteria_excluded_errored: 0,
          checks_passed: 0,
          checks_total: 1,
        },
      ],
    );
    assert.deepEqual(report.summary.criterion_scores, {
      required: { strict: 0.5, avg: 0.5, evaluations: 2 },
      recommended: { strict: 0.5, avg: 0.5, evaluations: 2 },
      blend: { score: 0.5, evaluations: 2 },
    });
    const resumed = await runExperiment({ ...fixture.options, resume: true });
    assert.equal(resumed.executed, 0);
    assert.deepEqual(
      (await readReport(resumed.report)).summary.criterion_scores,
      report.summary.criterion_scores,
    );
  });

  it('commits mixed judge outcomes, reports errors separately, and preserves them on resume', async () => {
    const fixture = await experimentRunFixture();
    const plan = createTestResolvedRunPlan({
      caseId: 'testing/judge-errors',
      checks: {},
      judgingCriteria: [
        'Available criterion.',
        'Unavailable criterion.',
        {
          value: 'Observational criterion.',
          label: 'source',
          requirement_level: 'OPTIONAL',
        },
      ],
      judge: { provider: 'scripted', model: 'judge' },
    });
    fixture.options.plans = Array.from({ length: 4 }, (_, repetition) => {
      const repeated = structuredClone(plan);
      repeated.selection.repetition = repetition;
      return defaultForgeEngine.parseResolvedRunPlan(repeated);
    });
    const requirements = {
      credentials: { token: { reference: credentialReference('test.judge') } },
    };
    const credentialResolver = createStaticCredentialResolver({
      'test.judge': 'scripted-token',
    });
    const preflight = createScriptedCompletionProvider({
      id: 'scripted',
      requirements,
    }).provider;
    fixture.options.composition = {
      ...composition(fixture.root),
      credentialResolver,
      completionProviders: new Map([[preflight.id, preflight]]),
    };
    fixture.options.execute = (input) => {
      const repetition = input.plan.selection.repetition;
      const provider = createScriptedCompletionProvider({
        id: 'scripted',
        requirements,
        responses: Array.from({ length: 9 }, () => (request) => {
          if (repetition === 2)
            throw new Error('Service unavailable for scripted-token');
          if (
            repetition === 0 &&
            request.systemPrompt!.includes(
              'Success Criterion:\nObservational criterion.\n',
            )
          )
            return '{}';
          if (
            repetition === 1 &&
            request.systemPrompt!.includes(
              'Success Criterion:\nUnavailable criterion.\n',
            )
          )
            return '{}';
          return JSON.stringify({
            results: [
              {
                index: 0,
                passed: repetition !== 3,
                explanation: 'Valid judgment.',
              },
            ],
          });
        }),
      }).provider;
      return executeEvalWithTestHooks(
        {
          ...input,
          composition: {
            ...composition(fixture.root),
            credentialResolver,
            completionProviders: new Map([[provider.id, provider]]),
          },
        },
        { waitBeforeCompletionRetry: async () => undefined },
      );
    };
    const first = await runExperiment(fixture.options);
    const report = await readReport(first.report);
    assert.equal(report.summary.completed, 4);
    assert.equal(report.summary.errored, 0);
    assert.equal(report.summary.passed, 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.partial, 0);
    assert.equal(report.summary.coverage, 1);
    assert.equal(report.summary.pass_rate, 0.5);
    assert.deepEqual(report.summary.judge_errors, {
      evaluations: 3,
      criteria: 5,
    });
    assert.deepEqual(
      report.cases[0]!.judge_errors,
      report.summary.judge_errors,
    );
    assert.deepEqual(report.summary.judging_score, {
      mean: 2 / 3,
      evaluations: 3,
    });
    assert.deepEqual(
      report.runs.map((run) => run.evaluation!.judging_criteria_errored),
      [0, 1, 2, 0],
    );
    assert.deepEqual(
      report.runs.map(
        (run) => run.evaluation!.judging_criteria_excluded_errored,
      ),
      [1, 0, 1, 0],
    );
    assert.deepEqual(
      report.runs.map((run) => run.evaluation!.score),
      [1, 1, null, 0],
    );
    const stored = await defaultForgeEngine.verifyCompletedRun(
      path.join(fixture.root, 'runs', report.runs[2]!.run_id!),
    );
    assert.equal(stored.result.evaluation.status, 'judge_error');
    assert.deepEqual(stored.result.evaluation.judging_criteria[0]!.error, {
      type: 'request_error',
      attempts: 3,
      message: 'Service unavailable for [REDACTED]',
    });
    const malformed = await defaultForgeEngine.verifyCompletedRun(
      path.join(fixture.root, 'runs', report.runs[1]!.run_id!),
    );
    assert.deepEqual(malformed.result.evaluation.judging_criteria[1]!.error, {
      type: 'parse_error',
      attempts: 3,
      message:
        'Judge response did not match the required schema at response.results (invalid_type).',
    });
    assert.equal(stored.result.completion_calls.length, 9);
    assert.ok(
      stored.result.completion_calls.every((call) => call.status === 'failed'),
    );
    assert.doesNotMatch(JSON.stringify(stored.result), /scripted-token/);
    const resumed = await runExperiment({
      ...fixture.options,
      resume: true,
      execute: async () => {
        throw new Error(
          'Committed judge errors must not rerun the coding agent.',
        );
      },
    });
    assert.equal(resumed.executed, 0);
    assert.deepEqual((await readReport(resumed.report)).runs, report.runs);
  });

  it('writes a cancellation report after cleanup, including cases that never started', async () => {
    const fixture = await experimentRunFixture();
    fixture.options.plans = [
      ...fixture.options.plans,
      createTestResolvedRunPlan({ caseId: 'testing/third' }),
    ];
    const controller = new AbortController();
    fixture.options.signal = controller.signal;
    let cleaned = false;
    fixture.options.execute = async (input) => {
      if (input.plan.selection.case_id === 'testing/first') {
        return defaultForgeEngine.executeEval({
          ...input,
          composition: composition(fixture.root),
        });
      }
      controller.abort(new Error('cancelled by test'));
      try {
        input.signal!.throwIfAborted();
        throw new Error('unreachable');
      } finally {
        cleaned = true;
      }
    };
    await assert.rejects(runExperiment(fixture.options), /cancelled by test/);
    assert.equal(cleaned, true);
    const report = await readReport(path.join(fixture.root, 'report.json'));
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.errored, 1);
    assert.equal(report.summary.pending, 1);
    assert.equal(report.runs[1]!.error_code, 'aborted');
    assert.equal(report.runs[2]!.run_id, null);
    await assert.rejects(fs.stat(path.join(fixture.root, '.experiment.lock')), {
      code: 'ENOENT',
    });
  });

  it('atomically preserves the previous report on write failure and retains completed evals', async () => {
    const fixture = await experimentRunFixture();
    const first = await runExperiment(fixture.options);
    const previous = await fs.readFile(first.report);
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof rename>) => {
        if (args[1] === first.report)
          throw new Error('private filesystem detail');
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runExperiment({ ...fixture.options, resume: true }),
        (error) => {
          assert.ok(error instanceof ExperimentRunReportError);
          assert.equal(error.report, first.report);
          assert.equal(
            error.message.includes('private filesystem detail'),
            false,
          );
          return true;
        },
      );
      assert.deepEqual(await fs.readFile(first.report), previous);
      assert.equal(
        (await fs.readdir(fixture.root)).some((name) => name.endsWith('.tmp')),
        false,
      );
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    const resumed = await runExperiment({ ...fixture.options, resume: true });
    assert.equal(resumed.executed, 0);
  });

  it('holds the experiment run lock through report persistence and rejects late cancellation', async () => {
    const fixture = await experimentRunFixture();
    const controller = new AbortController();
    fixture.options.signal = controller.signal;
    const rename = fsPromises.rename;
    const reportPath = path.join(fixture.root, 'report.json');
    let blocked = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof rename>) => {
        if (args[1] === reportPath) {
          await assert.rejects(
            runExperiment({
              ...fixture.options,
              resume: true,
              signal: new AbortController().signal,
            }),
            /Another experiment run process/,
          );
          blocked = true;
          controller.abort(new Error('cancelled while writing report'));
        }
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runExperiment(fixture.options),
        /cancelled while writing report/,
      );
      assert.equal(blocked, true);
      assert.equal((await readReport(reportPath)).summary.completed, 2);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it('preserves a coordinator failure even when writing its partial report also fails', async () => {
    const fixture = await experimentRunFixture();
    const original = new Error('primary callback failure');
    fixture.options.progress = (event) => {
      if (event.state === 'started') throw original;
    };
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof rename>) => {
        if (args[1] === path.join(fixture.root, 'report.json'))
          throw new Error('secondary report failure');
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runExperiment(fixture.options),
        (error) => error === original,
      );
      await assert.rejects(
        fs.stat(path.join(fixture.root, '.experiment.lock')),
        { code: 'ENOENT' },
      );
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
});

function evaluation(
  passed: number,
  total: number,
  status: 'passed' | 'partial' | 'failed',
) {
  return {
    status,
    score: total === 0 ? 0 : passed / total,
    judging_criteria_passed: passed,
    judging_criteria_total: total,
    criterion_scores: {
      required: { strict: null, avg: null },
      recommended: {
        strict: total === 0 ? null : passed === total ? 1 : 0,
        avg: total === 0 ? null : passed / total,
      },
      blend: { score: total === 0 ? null : passed / total },
    },
    criteria_by_requirement: {
      MUST: { passed: 0, total: 0, errored: 0 },
      SHOULD: { passed, total, errored: 0 },
      OPTIONAL: { passed: 0, total: 0, errored: 0 },
    },

    judging_criteria_errored: 0,
    judging_criteria_excluded_errored: 0,
    checks_passed: status === 'failed' ? 0 : 1,
    checks_total: 1,
  };
}
function judgment(
  requirement_level: 'MUST' | 'SHOULD' | 'OPTIONAL' = 'SHOULD',
  passed: boolean | null,
) {
  if (passed === null) {
    return parseCriterionJudgment('{}', {
      value: 'The answer MUST be complete.',
      requirement_level,
    });
  }
  return {
    criterion: 'The answer MUST be complete.',
    requirement_level,
    passed,
    explanation: '',
  };
}
function row(index: number): ExperimentRunReportRunV1 {
  const selection = structuredClone(
    createTestResolvedRunPlan({ caseId: 'testing/first' }).selection,
  );
  selection.repetition = index;
  return {
    selection_index: index,
    selection,
    run_id: `run-${index}`,
    state: 'completed',
    error_code: null,
    attempt_count: 1,
    result_path: `runs/run-${index}/result.json`,
    evaluation: evaluation(0, 0, 'passed'),
  };
}
function build(runs: ExperimentRunReportRunV1[]) {
  return buildExperimentRunReport({
    experimentRunId: 'test-report',
    generatedAt: '2026-10-02T00:00:00.000Z',
    checkpointBody: '{}\n',
    runs,
  });
}
async function readReport(location: string) {
  return parseExperimentRunReport(
    JSON.parse(await fs.readFile(location, 'utf8')),
  );
}
function composition(root: string) {
  const agent = createScriptedAgentAdapter().adapter;
  return {
    runtime: createFakeRuntimeAdapter().adapter,
    agents: new Map([[agent.id, agent]]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({ root }),
  };
}
async function experimentRunFixture() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-scorecards-'),
  );
  temporaryDirectories.push(temporary);
  const root = path.join(temporary, 'experiment');
  let nextId = 0;
  const options: MutableExperimentRunOptions = {
    root,
    plans: ['first', 'second'].map((id) =>
      createTestResolvedRunPlan({ caseId: `testing/${id}` }),
    ),
    composition: composition(root),
    engine: defaultForgeEngine,
    resume: false,
    signal: new AbortController().signal,
    progress: () => undefined,
    runIdFactory: () => `attempt-${++nextId}`,
    execute: (input) =>
      defaultForgeEngine.executeEval({
        ...input,
        composition: composition(root),
      }),
  };
  return { root, options };
}
