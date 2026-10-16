import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type {
  ExperimentRunArtifact,
  ExperimentRunInspection,
  ExperimentRunOptions,
  ExperimentRunOutcome,
  ExperimentRunProgressEvent,
  ExperimentRunReportCaseV1,
  ExperimentRunReportEvaluationV1,
  ExperimentRunReportRunV1,
  ExperimentRunReportStatisticsV1,
  ExperimentRunReportV1,
  ExperimentRunSummary,
} from '../src/experiment.ts';
import * as experiment from '../src/experiment.ts';
import type {
  ExperimentArgumentOptions,
  ExperimentArguments,
  ExperimentCommandOptions,
  ExperimentCommandReference,
  ExperimentCommandResult,
  ExperimentLoadContext,
  ExperimentValues,
  LoadedExperimentRun,
} from '../src/experimentCli.ts';
import * as experimentCli from '../src/experimentCli.ts';
import * as root from '../src/index.ts';

describe('experiment public entry points', () => {
  it('exports dataset case entries as file paths', () => {
    const manifest: root.DatasetManifestV1 = {
      dataset: { id: 'public-api', version: '1.0.0' },
      cases: ['cases/first.case.yaml'],
      files: [
        { path: 'cases/first.case.yaml', size: 1, sha256: 'a'.repeat(64) },
      ],
    };
    const casePaths: root.DatasetRelativePath[] = manifest.cases;
    assert.deepEqual(casePaths, ['cases/first.case.yaml']);
    assert.deepEqual(root.parseDatasetManifest(manifest), manifest);
  });

  it('exports criterion judging contracts without former aliases', () => {
    for (const name of [
      'judgeGuidelines',
      'buildGuidelineJudgePrompt',
      'parseGuidelineJudgment',
    ]) {
      assert.equal(name in root, false);
    }
    assert.equal(typeof root.judgeCriteria, 'function');
    assert.equal(typeof root.buildCriterionJudgePrompt, 'function');
    assert.equal(typeof root.parseCriterionJudgment, 'function');
    const criterion: root.CriterionResultV1 = root.parseCriterionJudgment(
      JSON.stringify({
        results: [{ index: 0, passed: true, explanation: 'Done.' }],
      }),
      'The task is complete.',
    );
    const evaluation: root.EvaluationResultV1 = root.scoreEvaluation(
      [criterion],
      [],
    );
    assert.equal(evaluation.judging_criteria_passed, 1);
    assert.equal(evaluation.judging_criteria_total, 1);
    assert.deepEqual(evaluation.judging_criteria, [criterion]);
    assert.equal(evaluation.score, 1);
    const judge = (
      input: root.CriterionJudgeInput,
      invoke: root.CriterionCompletionInvoker,
      options: root.CriterionJudgeExecutionOptions,
    ): Promise<root.CriterionResultV1[]> =>
      root.judgeCriteria(input, invoke, options);
    assert.equal(typeof judge, 'function');
  });

  it('exports flat and grouped matrix types and their shared axes helper', () => {
    const group: root.ExperimentMatrixGroupV1 = {
      cases: ['cases/examples/first.case.yaml'],
      treatments: ['baseline'],
      agents: [
        {
          adapter: 'claude-code',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      ],
    };
    const flat: root.FlatExperimentMatrixV1 = {
      ...group,
      repetitions: 1,
      retries: 0,
    };
    const grouped: root.GroupedExperimentMatrixV1 = {
      groups: [group],
      repetitions: 1,
      retries: 0,
    };
    const matrices: root.ExperimentMatrixV1[] = [flat, grouped];
    assert.equal(typeof root.getMatrixGroups, 'function');
    for (const matrix of matrices) {
      const groups: readonly root.ExperimentMatrixGroupV1[] =
        root.getMatrixGroups(matrix);
      assert.equal(groups.length, 1);
      assert.deepEqual(groups[0]!.cases, ['cases/examples/first.case.yaml']);
    }
  });

  it('keeps experiment orchestration on its dedicated entry points', () => {
    for (const name of [
      'runExperiment',
      'readExperimentRunSelections',
      'inspectExperimentRun',
      'parseExperimentRunReport',
      'runExperimentCommand',
    ]) {
      assert.equal(name in root, false);
    }
    assert.equal(typeof experiment.runExperiment, 'function');
    assert.equal(typeof experiment.inspectExperimentRun, 'function');
    assert.equal(typeof experiment.parseExperimentRunReport, 'function');
    assert.equal(typeof experimentCli.runExperimentCommand, 'function');
  });

  it('exports public result types and precise host argument types', () => {
    const hostOptions = {
      tag: { type: 'string' },
      upload: { type: 'boolean' },
      labels: { type: 'string', multiple: true },
    } as const;
    const options: ExperimentArgumentOptions<typeof hostOptions> = {
      hostOptions,
    };
    const parsed: ExperimentArguments<typeof hostOptions> =
      experimentCli.parseExperimentArgs(
        [
          '--tag',
          'smoke',
          '--upload',
          '--labels',
          'first',
          '--labels',
          'second',
          '-j2',
        ],
        options,
      );
    const values: ExperimentValues<typeof hostOptions> = parsed.values;
    const tag: string | undefined = values.tag;
    const upload: boolean | undefined = values.upload;
    const labels: readonly string[] | undefined = values.labels;
    assert.equal(tag, 'smoke');
    assert.equal(upload, true);
    assert.deepEqual(labels, ['first', 'second']);
    assert.equal(parsed.jobs, 2);
    assert.equal(Object.isFrozen(experimentCli.EXPERIMENT_CLI_OPTIONS), true);

    // These assignments exercise the public declarations as well as runtime parsing.
    const acceptsCoreTypes = (
      options: ExperimentRunOptions,
      artifact: ExperimentRunArtifact,
      outcome: ExperimentRunOutcome,
      progress: ExperimentRunProgressEvent,
    ): {
      execute: ExperimentRunOptions['execute'];
      artifact: ExperimentRunOutcome['artifact'];
      selection: ExperimentRunOutcome['selection'];
      progress: Parameters<ExperimentRunOptions['progress']>[0];
    } => ({
      execute: options.execute,
      artifact,
      selection: outcome.selection,
      progress,
    });
    const acceptsReportTypes = (
      report: ExperimentRunReportV1,
    ): {
      cases: readonly ExperimentRunReportCaseV1[];
      runs: readonly ExperimentRunReportRunV1[];
      summary: ExperimentRunReportStatisticsV1;
      evaluation: ExperimentRunReportEvaluationV1 | null;
    } => ({
      cases: report.cases,
      runs: report.runs,
      summary: report.summary,
      evaluation: report.runs[0]?.evaluation ?? null,
    });
    const acceptsReferences = (
      summary: ExperimentRunSummary,
      inspection: ExperimentRunInspection,
      reference: ExperimentCommandReference,
      result: ExperimentCommandResult<typeof hostOptions>,
    ): readonly string[] => [
      summary.checkpoint,
      inspection.checkpoint,
      reference.checkpoint,
      result.checkpoint,
    ];
    const acceptsCommandLoader = (
      loadExperiment: (
        context: ExperimentLoadContext<typeof hostOptions>,
      ) => Promise<LoadedExperimentRun>,
      engine: ExperimentRunOptions['engine'],
    ): ExperimentCommandOptions<typeof hostOptions> => ({
      hostOptions,
      engine,
      loadExperiment,
    });
    assert.equal(typeof acceptsCoreTypes, 'function');
    assert.equal(typeof acceptsReportTypes, 'function');
    assert.equal(typeof acceptsReferences, 'function');
    assert.equal(typeof acceptsCommandLoader, 'function');
  });

  it('exposes usage and execution errors with experiment run references', () => {
    assert.throws(
      () =>
        experimentCli.parseExperimentArgs(['--jobs', '0'], { hostOptions: {} }),
      (error) =>
        error instanceof experimentCli.ExperimentUsageError &&
        error.name === 'ExperimentUsageError',
    );
    assert.throws(
      () =>
        experimentCli.createExperimentCliOptions({
          output: { type: 'string' },
        }),
      (error) =>
        error instanceof experimentCli.ExperimentUsageError &&
        error.name === 'ExperimentUsageError',
    );
    const report = new experiment.ExperimentRunReportError(
      'report.json',
      new Error('report failure'),
    );
    assert.equal(report.name, 'ExperimentRunReportError');
    assert.ok(report instanceof experiment.ExperimentRunReportError);
    const reference: ExperimentCommandReference = {
      experiment_run_id: 'example',
      location: '/results/example',
      checkpoint: '/results/example/experiment.json',
    };
    const command = new experimentCli.ExperimentCommandError(
      reference,
      new Error('command failure'),
    );
    assert.equal(command.name, 'ExperimentCommandError');
    assert.equal(command.reference.checkpoint, reference.checkpoint);
    assert.ok(command instanceof experimentCli.ExperimentCommandError);
  });
});
