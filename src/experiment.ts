import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentTokenUsage } from './contracts/agent.ts';
import type { AttemptDiagnosticsStore } from './contracts/attemptDiagnostics.ts';
import type { ForgeComposition } from './contracts/composition.ts';
import type { AgentPluginInstallationReceipt } from './contracts/plugin.ts';
import { createAttemptDiagnosticsStore } from './diagnostics/localStore.ts';
import {
  type AttemptDiagnosticsIdentity,
  AttemptDiagnosticsIdentityError,
  assertAttemptDiagnosticsIdentity,
  attemptDiagnosticsIdentity,
  parseAttemptDiagnostics,
} from './diagnostics/model.ts';
import { createAttemptRecorder } from './diagnostics/recorder.ts';
import type { ForgeEngine } from './engine.ts';
import {
  ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS,
  createAttemptDiagnosticsWriter,
} from './execution/diagnosticsIO.ts';
import { ForgeExecutionError } from './execution/errors.ts';
import type { ExecuteEvalInput } from './execution/execute.ts';
import type { ExperimentLogGap } from './experimentEvents.ts';
import {
  type ExperimentRunAttempt as Attempt,
  EXPERIMENT_LOCK_OWNER_NAME,
  type ExperimentRunCheckpoint,
  experimentRunLockOwnerSchema,
  MAX_EXPERIMENT_LOCK_OWNER_BYTES,
  MAX_EXPERIMENT_RUN_BYTES,
  parseExperimentRunCheckpoint,
  experimentRunIdSchema as runIdSchema,
  type SettledExperimentRunAttempt as SettledAttempt,
} from './experimentModel.ts';
import { createExperimentProgress } from './experimentProgress.ts';
import {
  buildExperimentRunReport,
  type ExperimentRunReportEvaluationV1,
  type ExperimentRunReportRunV1,
  serializeExperimentRunReport,
  summarizeReportEvaluation,
} from './experimentReport.ts';
import { mcpToolRefusalWarnings } from './mcpToolRefusals.ts';
import type { ResolvedRunPlanV1, RunSelection } from './model/types.ts';
import { resolvedRunPlanSha256 } from './planning/planner.ts';
import type { CompletedRunV1, EvalStatus } from './results/types.ts';
import { serializeCanonicalJson } from './serialization.ts';
import { FORGE_BUILD_IDENTITY } from './version.ts';

export {
  type ExperimentRunReportCaseV1,
  type ExperimentRunReportEvaluationV1,
  type ExperimentRunReportRunV1,
  type ExperimentRunReportStatisticsV1,
  type ExperimentRunReportV1,
  parseExperimentRunReport,
} from './experimentReport.ts';

/** A report failure does not invalidate committed evaluations or their checkpoint. */
export class ExperimentRunReportError extends Error {
  readonly report: string;
  constructor(report: string, cause: unknown) {
    super(
      `Could not write experiment run report at ${report}. Saved evaluations can be resumed without rerunning completed entries.`,
      { cause },
    );
    this.name = 'ExperimentRunReportError';
    this.report = report;
  }
}

/** Bounded metadata from a verified local commit, independent of publication. */
export interface ExperimentRunArtifact {
  readonly warnings?: ExperimentRunReportRunV1['warnings'];
  readonly location: string;
  readonly evaluation: {
    readonly status: EvalStatus;
    readonly score: number | null;
  };
  readonly failure: 'role_player_error' | null;
  readonly plugin_installations?: readonly AgentPluginInstallationReceipt[];
}

/** The effective latest attempt for one selection, in saved selection order. */
export interface ExperimentRunOutcome {
  readonly selection: RunSelection;
  readonly plan_sha256: string;
  readonly run_id: string | null;
  readonly state: 'pending' | 'completed' | 'errored';
  readonly error_code:
    | Extract<Attempt, { state: 'errored' }>['error_code']
    | null;
  readonly diagnostic?: Extract<Attempt, { state: 'errored' }>['diagnostic'];
  readonly artifact: ExperimentRunArtifact | null;
}

export interface ExperimentRunInspection {
  readonly experiment_run_id: string;
  readonly location: string;
  readonly checkpoint: string;
  readonly outcomes: readonly ExperimentRunOutcome[];
}

export type ExperimentRunProgressEvent =
  | { readonly state: 'started' | 'resuming'; readonly location: string }
  | {
      readonly state: 'agent_usage';
      readonly selection: RunSelection;
      readonly run_id: string;
      readonly turn: number;
      readonly usage: AgentTokenUsage;
    }
  | {
      readonly state: 'running' | 'completed' | 'skipped';
      readonly selection: RunSelection;
      readonly run_id: string;
    }
  | {
      readonly state: 'errored';
      readonly selection: RunSelection;
      readonly run_id: string;
      readonly error_code: Extract<Attempt, { state: 'errored' }>['error_code'];
      readonly diagnostic?: Extract<
        Attempt,
        { state: 'errored' }
      >['diagnostic'];
    };

export interface ExperimentRunSummary {
  /** Optional recording gaps; evaluation outcomes remain authoritative. */
  readonly progress_log?: ExperimentLogGap;
  readonly checkpoint: string;
  readonly report: string;
  readonly total: number;
  readonly executed: number;
  readonly skipped: number;
  readonly completed: number;
  readonly errored: number;
}

/** Resume the original selection even when the new invocation has no filters. */
export async function readExperimentRunSelections(
  root: string,
): Promise<RunSelection[]> {
  root = path.resolve(root);
  const experimentRun = await requireExperimentRun(root);
  return experimentRun.entries.map(({ selection }) => selection);
}

/** Verify latest committed attempts without loading inputs or changing state. */
export async function inspectExperimentRun(options: {
  readonly root: string;
  readonly engine: ForgeEngine;
  readonly signal?: AbortSignal;
}): Promise<ExperimentRunInspection> {
  const root = path.resolve(options.root);
  options.signal?.throwIfAborted();
  const experimentRun = await requireExperimentRun(root);
  const outcomes: ExperimentRunOutcome[] = [];
  for (const entry of experimentRun.entries) {
    options.signal?.throwIfAborted();
    const last = entry.attempts.at(-1);
    if (last === undefined) {
      outcomes.push({
        selection: entry.selection,
        plan_sha256: entry.plan_sha256,
        run_id: null,
        state: 'pending',
        error_code: null,
        artifact: null,
      });
      continue;
    }
    const inspected = await inspectAttempt(
      options.engine,
      root,
      entry.plan_sha256,
      last.run_id,
      entry.selection,
    );
    const attempt =
      inspected.artifact === null && last.state === 'errored'
        ? last
        : inspected.attempt;
    outcomes.push(experimentRunOutcome(entry, attempt, inspected.artifact));
  }
  options.signal?.throwIfAborted();
  return {
    experiment_run_id: experimentRun.experiment_run_id,
    location: root,
    checkpoint: path.join(root, 'experiment.json'),
    outcomes,
  };
}

async function requireExperimentRun(
  root: string,
): Promise<ExperimentRunCheckpoint> {
  const experimentRun = await readExperimentRunCheckpoint(
    path.join(root, 'experiment.json'),
  );
  if (experimentRun === undefined) {
    throw new Error(
      'No experiment run with this ID exists in the output directory.',
    );
  }
  if (experimentRun.experiment_run_id !== path.basename(root)) {
    throw new Error('Experiment run ID does not match its checkpoint.');
  }
  return experimentRun;
}

/** Local experiment run checkpoint and scheduling, separate from eval semantics. */
export interface ExperimentRunOptions {
  readonly root: string;
  readonly plans: readonly ResolvedRunPlanV1[];
  /** Pure preflight composition; execute may supply per-run capabilities. */
  readonly composition: ForgeComposition;
  readonly engine: ForgeEngine;
  readonly resume: boolean;
  /** Maximum simultaneous eval runs; defaults to one. Not plan semantics. */
  readonly jobs?: number;
  readonly signal: AbortSignal;
  /**
   * Execute with the supplied engine and local artifact root. May compose
   * per-run host resources; must honor signal and finish cleanup before settling.
   */
  readonly execute: (input: ExecuteEvalInput) => Promise<CompletedRunV1>;
  readonly runIdFactory: () => string;
  readonly progress: (event: ExperimentRunProgressEvent) => void;
  /** Synchronous result collection, including verified selections skipped on resume. */
  readonly onOutcome?: (
    outcome: ExperimentRunOutcome,
    selectionIndex: number,
  ) => void;
}

/** Execute each pending selection once, retaining all earlier attempt IDs. */
export async function runExperiment(
  options: ExperimentRunOptions,
): Promise<ExperimentRunSummary> {
  const jobs = options.jobs ?? 1;
  if (!Number.isSafeInteger(jobs) || jobs < 1) {
    throw new Error('Experiment run jobs must be a positive safe integer.');
  }
  const root = path.resolve(options.root);
  if (root === path.parse(root).root) {
    throw new Error('Experiment run output must not be a filesystem root.');
  }
  const identities = options.plans.map((plan) => ({
    selection: plan.selection,
    plan_sha256: resolvedRunPlanSha256(plan),
  }));
  // Validate the whole experiment run before checkpoint writes or any execution.
  parseExperimentRunCheckpoint({
    forge: FORGE_BUILD_IDENTITY,
    experiment_run_id: path.basename(root),
    entries: identities.map((identity) => ({ ...identity, attempts: [] })),
  });
  for (const plan of options.plans) {
    options.engine.preflightEval({ plan, composition: options.composition });
  }
  options.signal.throwIfAborted();
  if (options.resume) {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid experiment run directory.');
  } else {
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.mkdir(root);
  }
  const release = await acquireExperimentRunLock(root);
  const diagnosticsStore =
    options.composition.attemptDiagnosticsStore ??
    createAttemptDiagnosticsStore({ root });
  const checkpoint = path.join(root, 'experiment.json');
  const reportPath = path.join(root, 'report.json');
  const inspections = new Map<string, CachedInspection>();
  const inspect = async (
    entry: ExperimentRunCheckpoint['entries'][number],
    runId: string,
  ): Promise<AttemptInspection> => {
    const identity = serializeCanonicalJson({
      selection: entry.selection,
      plan_sha256: entry.plan_sha256,
    });
    const cached = inspections.get(runId);
    if (cached?.identity === identity) return cached.inspected;
    const inspected = await inspectAttempt(
      options.engine,
      root,
      entry.plan_sha256,
      runId,
      entry.selection,
    );
    inspections.set(runId, { identity, inspected });
    return inspected;
  };
  const recording = createExperimentProgress({
    root,
    progress(event) {
      if (event.state !== 'agent_usage') {
        options.progress(event);
        return;
      }
      try {
        options.progress(event);
      } catch {
        // A usage callback failure must not drop the saved observation.
      }
    },
  });
  const progress = recording.record;
  let historyWarningSent = false;
  let reportReady = false;
  let succeeded = false;
  try {
    let experimentRun = await readExperimentRunCheckpoint(checkpoint);
    if (experimentRun === undefined) {
      if (options.resume)
        throw new Error(
          'No experiment.json to resume in the output directory.',
        );
      experimentRun = parseExperimentRunCheckpoint({
        forge: FORGE_BUILD_IDENTITY,
        experiment_run_id: path.basename(root),
        entries: identities.map((identity) => ({ ...identity, attempts: [] })),
      });
    } else {
      if (!options.resume) {
        throw new Error(
          'This experiment run already exists; resume it with its ID.',
        );
      }
      if (experimentRun.experiment_run_id !== path.basename(root)) {
        throw new Error('Experiment run ID does not match its checkpoint.');
      }
      const storedIdentities = experimentRun.entries.map(
        ({ selection, plan_sha256 }) => ({
          selection,
          plan_sha256,
        }),
      );
      if (
        serializeCanonicalJson(storedIdentities) !==
        serializeCanonicalJson(identities)
      ) {
        throw new Error(
          'Cannot resume: the selected resolved plans differ from the saved experiment run.',
        );
      }
    }
    const runIds = new Set<string>();
    const historyTimeout = new AbortController();
    const historyTimer = setTimeout(
      () =>
        historyTimeout.abort(
          new Error('Attempt diagnostic history deadline exhausted.'),
        ),
      ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS,
    );
    try {
      for (const [index, entry] of experimentRun.entries.entries()) {
        for (const [attemptIndex, attempt] of entry.attempts.entries()) {
          options.signal.throwIfAborted();
          if (runIds.has(attempt.run_id))
            throw new Error('Experiment run contains duplicate run IDs.');
          runIds.add(attempt.run_id);
          const saved = await readAttemptHistory(
            diagnosticsStore,
            attemptDiagnosticsIdentity(
              attempt.run_id,
              options.plans[index]!,
              experimentRun.experiment_run_id,
            ),
            options.signal,
            historyTimeout.signal,
          );
          Object.assign(attempt, saved ? timingFields(saved.timing) : {}, {
            diagnostics_status: saved ? 'available' : 'unavailable',
          });
          if (!saved && !historyWarningSent) {
            historyWarningSent = true;
            // Notification cannot hold the experiment lock, even for a stalled observer.
            void Promise.resolve()
              .then(() =>
                options.composition.observer?.observe({
                  runId: attempt.run_id,
                  sequence: 0,
                  timestamp: new Date().toISOString(),
                  type: 'warning',
                  phase: 'preflight',
                  message:
                    'Attempt diagnostic history is unavailable; continuing resume.',
                }),
              )
              .catch(() => undefined);
          }
          if (saved?.primary_failure && attempt.state === 'running') {
            const { error_code, ...diagnostic } = saved.primary_failure;
            entry.attempts[attemptIndex] = {
              ...attempt,
              state: 'errored',
              error_code,
              diagnostic,
            };
          }
        }
      }
    } finally {
      clearTimeout(historyTimer);
    }
    reportReady = true;

    // Inspect every prior result before running anything. This also recovers a
    // run committed just before the process died while updating its checkpoint.
    const pending: number[] = [];
    let skipped = 0;
    for (const [index, entry] of experimentRun.entries.entries()) {
      options.signal.throwIfAborted();
      const last = entry.attempts.at(-1);
      if (last !== undefined) {
        const inspected = await inspect(entry, last.run_id);
        const recovered = inspected.attempt;
        if (
          recovered.state !== 'errored' ||
          recovered.error_code !== 'invalid_artifacts' ||
          last.state !== 'errored'
        ) {
          entry.attempts[entry.attempts.length - 1] = {
            ...timingFields(last),
            ...(last.diagnostics_status === undefined
              ? {}
              : { diagnostics_status: last.diagnostics_status }),
            ...recovered,
          };
        }
        if (recovered.state === 'completed') {
          skipped += 1;
          options.onOutcome?.(
            experimentRunOutcome(entry, recovered, inspected.artifact),
            index,
          );
          progress({
            selection: entry.selection,
            run_id: last.run_id,
            state: 'skipped',
          });
          continue;
        }
      }
      pending.push(index);
    }
    await writeExperimentRunCheckpoint(checkpoint, experimentRun);
    progress({
      state: options.resume ? 'resuming' : 'started',
      location: root,
    });
    let completed = skipped;
    let errored = 0;
    let executed = 0;
    let nextPending = 0;
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let failed = false;
    let failure: unknown;
    function fail(error: unknown) {
      if (failed) return;
      failed = true;
      failure = error;
      controller.abort(error);
    }
    // Both mutation and persistence belong to one coordinator. Workers never
    // write snapshots independently or reserve the same pending selection.
    let updates = Promise.resolve();
    function update<T>(action: () => Promise<T>): Promise<T> {
      const operation = updates.then(async () => {
        try {
          return await action();
        } catch (error) {
          fail(error);
          throw error;
        }
      });
      updates = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    }
    async function worker() {
      try {
        while (!signal.aborted) {
          const task = await update(async () => {
            if (signal.aborted) return undefined;
            const index = pending[nextPending++];
            if (index === undefined) return undefined;
            const entry = experimentRun!.entries[index]!;
            const runId = runIdSchema.parse(options.runIdFactory());
            if (
              runIds.has(runId) ||
              (await exists(path.join(root, 'runs', runId))) ||
              (await exists(path.join(root, 'diagnostics', runId)))
            ) {
              throw new Error('Eval run ID already exists.');
            }
            runIds.add(runId);
            const reservedAt = new Date().toISOString();
            const recorder = createAttemptRecorder({
              identity: attemptDiagnosticsIdentity(
                runId,
                options.plans[index]!,
                experimentRun!.experiment_run_id,
              ),
              write: createAttemptDiagnosticsWriter(diagnosticsStore),
              reservedAt,
            });
            await recorder.reserve();
            entry.attempts.push({
              run_id: runId,
              state: 'running',
              reserved_at: reservedAt,
            });
            await writeExperimentRunCheckpoint(checkpoint, experimentRun!);
            progress({
              selection: entry.selection,
              run_id: runId,
              state: 'running',
            });
            return { index, runId, entry, reservedAt, recorder };
          });
          if (task === undefined) return;
          const { index, runId, entry, reservedAt, recorder } = task;
          let attempt: SettledAttempt;
          let artifact: ExperimentRunArtifact | null = null;
          try {
            signal.throwIfAborted();
            executed += 1;
            const result = await options.execute({
              runId,
              plan: options.plans[index]!,
              composition: options.composition,
              observer: {
                async observe(event) {
                  if (event.type !== 'agent_usage') return;
                  await update(async () => {
                    progress({
                      state: 'agent_usage',
                      selection: entry.selection,
                      run_id: runId,
                      turn: event.turn,
                      usage: event.usage,
                    });
                  });
                },
              },
              attemptDiagnostics: recorder,
              signal,
            });
            const [actualLocation, expectedLocation] = await Promise.all([
              fs.realpath(result.location),
              fs.realpath(path.join(root, 'runs', runId)),
            ]);
            if (actualLocation !== expectedLocation) {
              throw new Error(
                'Experiment runs require the local artifact store at the selected output directory.',
              );
            }
            const inspected = await inspect(entry, runId);
            attempt = inspected.attempt;
            artifact = inspected.artifact;
          } catch (error) {
            // Error messages and causes may carry host data or credentials.
            // Only execution-boundary diagnostics have been bounded and redacted.
            attempt = {
              run_id: runId,
              state: 'errored',
              error_code: signal.aborted
                ? 'aborted'
                : error instanceof ForgeExecutionError
                  ? error.code
                  : 'execution_error',
              ...(error instanceof ForgeExecutionError &&
              error.diagnostic !== undefined
                ? { diagnostic: { phase: error.phase, ...error.diagnostic } }
                : {}),
            };
            if (recorder.snapshot.state === 'reserved') {
              await recorder.failure({
                error_code: attempt.error_code,
                phase: attempt.diagnostic?.phase ?? 'preflight',
                reason: attempt.diagnostic?.reason ?? 'failure',
                message:
                  attempt.diagnostic?.message ??
                  'Host execution callback failed before execution entry was recorded.',
              });
              recorder.cleanupCompleted();
              await recorder.finish('errored');
            }
            // A callback can fail after its local commit (for example during
            // host cleanup). Keep the execution error while exposing verified
            // artifacts for independent publication.
            artifact = (await inspect(entry, runId)).artifact;
          }
          attempt = {
            ...attempt,
            reserved_at: reservedAt,
            ...timingFields(recorder.snapshot.timing),
            diagnostics_status: recorder.available
              ? 'available'
              : 'unavailable',
          };
          await update(async () => {
            entry.attempts[entry.attempts.length - 1] = attempt;
            await writeExperimentRunCheckpoint(checkpoint, experimentRun!);
            progress(
              attempt.state === 'errored'
                ? {
                    selection: entry.selection,
                    run_id: attempt.run_id,
                    state: attempt.state,
                    error_code: attempt.error_code,
                    ...(attempt.diagnostic === undefined
                      ? {}
                      : { diagnostic: attempt.diagnostic }),
                  }
                : {
                    selection: entry.selection,
                    run_id: attempt.run_id,
                    state: attempt.state,
                  },
            );
            if (attempt.state === 'completed') completed += 1;
            else errored += 1;
            options.onOutcome?.(
              experimentRunOutcome(entry, attempt, artifact),
              index,
            );
          });
        }
      } catch (error) {
        fail(error);
      }
    }
    // Retain the experiment run lock until every active callback has cleaned up,
    // including when cancellation or a coordinator failure stops new work.
    await Promise.all(
      Array.from({ length: Math.min(jobs, pending.length) }, () => worker()),
    );
    if (failed) throw failure;
    options.signal.throwIfAborted();
    const progressLog = await recording.finish();
    succeeded = true;
    return {
      ...(progressLog === undefined ? {} : { progress_log: progressLog }),
      checkpoint,
      report: reportPath,
      total: experimentRun.entries.length,
      executed,
      skipped,
      completed,
      errored,
    };
  } finally {
    try {
      if (reportReady) {
        try {
          // Read the last durable checkpoint, including after coordinator
          // failures. Workers have drained and this process still owns the lock.
          const source = await readExperimentRunSource(checkpoint);
          if (source === undefined) {
            // biome-ignore lint/correctness/noUnsafeFinally: The report catch below preserves any original execution failure.
            throw new Error('Experiment run checkpoint is missing.');
          }
          if (source.experimentRun.experiment_run_id !== path.basename(root)) {
            // biome-ignore lint/correctness/noUnsafeFinally: The report catch below preserves any original execution failure.
            throw new Error(
              'Experiment run checkpoint identity does not match its directory.',
            );
          }
          const runs: ExperimentRunReportRunV1[] = [];
          for (const [index, entry] of source.experimentRun.entries.entries()) {
            const last = entry.attempts.at(-1);
            if (last === undefined) {
              runs.push({
                selection_index: index,
                selection: entry.selection,
                run_id: null,
                state: 'pending',
                error_code: null,
                attempt_count: 0,
                result_path: null,
                evaluation: null,
              });
              continue;
            }
            const inspected = await inspect(entry, last.run_id);
            const effective =
              inspected.artifact === null && last.state === 'errored'
                ? last
                : inspected.attempt;
            runs.push({
              ...timingFields(last),
              ...(last.diagnostics_status === undefined
                ? {}
                : { diagnostics_status: last.diagnostics_status }),
              selection_index: index,
              selection: entry.selection,
              run_id: last.run_id,
              state: effective.state,
              error_code:
                effective.state === 'errored' ? effective.error_code : null,
              ...(effective.state === 'errored' &&
              effective.diagnostic !== undefined
                ? { diagnostic: effective.diagnostic }
                : {}),
              ...(inspected.artifact?.warnings?.length
                ? { warnings: inspected.artifact.warnings }
                : {}),
              ...(inspected.rateLimitWaitMs === undefined
                ? {}
                : { rate_limit_wait_ms: inspected.rateLimitWaitMs }),
              attempt_count: entry.attempts.length,
              result_path:
                inspected.artifact === null
                  ? null
                  : `runs/${last.run_id}/result.json`,
              ...(effective.state === 'completed' &&
              inspected.usage !== undefined
                ? { agent_usage: inspected.usage }
                : {}),
              ...(inspected.artifact?.plugin_installations === undefined
                ? {}
                : {
                    plugin_installations:
                      inspected.artifact.plugin_installations,
                  }),
              evaluation:
                effective.state === 'completed' ? inspected.evaluation : null,
            });
          }
          const report = buildExperimentRunReport({
            experimentRunId: source.experimentRun.experiment_run_id,
            generatedAt: new Date().toISOString(),
            checkpointBody: source.body,
            runs,
          });
          await writeAtomicDocument(
            reportPath,
            serializeExperimentRunReport(report),
          );
        } catch (error) {
          // Report generation is best effort after interruption. Preserve the
          // original failure, but surface reporting failure on normal completion.
          if (succeeded && !options.signal.aborted) {
            // biome-ignore lint/correctness/noUnsafeFinally: Report failure replaces only a successful result.
            throw new ExperimentRunReportError(reportPath, error);
          }
        }
      }
      if (succeeded) options.signal.throwIfAborted();
    } finally {
      try {
        await recording.finish();
      } finally {
        await release();
      }
    }
  }
}

interface AttemptInspection {
  attempt: SettledAttempt;
  artifact: ExperimentRunArtifact | null;
  evaluation: ExperimentRunReportEvaluationV1 | null;
  usage?: AgentTokenUsage;
  rateLimitWaitMs?: number;
}
interface CachedInspection {
  identity: string;
  inspected: AttemptInspection;
}

async function inspectAttempt(
  engine: ForgeEngine,
  root: string,
  planDigest: string,
  runId: string,
  selection: RunSelection,
): Promise<AttemptInspection> {
  try {
    const location = path.join(root, 'runs', runId);
    const completed = await engine.verifyCompletedRun(location);
    const descriptor = completed.result.artifacts.find(
      (artifact) => artifact.path === 'plan.json',
    );
    if (descriptor?.sha256 !== planDigest)
      throw new Error('Run belongs to a different plan.');
    if (
      serializeCanonicalJson(completed.result.selection) !==
      serializeCanonicalJson(selection)
    ) {
      throw new Error('Run belongs to a different selection.');
    }
    const attempt: SettledAttempt =
      completed.result.failure === null
        ? { run_id: runId, state: 'completed' }
        : {
            run_id: runId,
            state: 'errored',
            error_code: 'role_player_error',
            diagnostic: {
              phase: 'interaction',
              reason: 'failure',
              message:
                completed.result.failure.message ??
                completed.result.failure.explanation.slice(0, 4096),
            },
          };
    const evaluation = completed.result.evaluation;
    const warnings = mcpToolRefusalWarnings(
      completed.result.warnings.find(
        (warning) => warning.mcp_tool_refusals !== undefined,
      )?.mcp_tool_refusals,
    );
    return {
      attempt,
      evaluation: summarizeReportEvaluation(evaluation),
      ...(completed.result.agent.usage === undefined
        ? {}
        : { usage: completed.result.agent.usage }),
      ...(completed.result.completion_call_totals === undefined
        ? {}
        : {
            rateLimitWaitMs:
              completed.result.completion_call_totals.rate_limit_wait_ms,
          }),
      artifact: {
        ...(warnings.length ? { warnings } : {}),
        location,
        ...(completed.result.plugin_installations === undefined
          ? {}
          : { plugin_installations: completed.result.plugin_installations }),
        evaluation: {
          status: completed.result.evaluation.status,
          score: completed.result.evaluation.score,
        },
        failure: completed.result.failure === null ? null : 'role_player_error',
      },
    };
  } catch {
    return {
      attempt: {
        run_id: runId,
        state: 'errored',
        error_code: 'invalid_artifacts',
      },
      artifact: null,
      evaluation: null,
    };
  }
}

function experimentRunOutcome(
  entry: ExperimentRunCheckpoint['entries'][number],
  attempt: SettledAttempt,
  artifact: ExperimentRunArtifact | null,
): ExperimentRunOutcome {
  return {
    selection: entry.selection,
    plan_sha256: entry.plan_sha256,
    run_id: attempt.run_id,
    state: attempt.state,
    error_code: attempt.state === 'errored' ? attempt.error_code : null,
    ...(attempt.state === 'errored' && attempt.diagnostic !== undefined
      ? { diagnostic: attempt.diagnostic }
      : {}),
    artifact,
  };
}

async function readExperimentRunCheckpoint(
  checkpoint: string,
): Promise<ExperimentRunCheckpoint | undefined> {
  return (await readExperimentRunSource(checkpoint))?.experimentRun;
}

async function readExperimentRunSource(
  checkpoint: string,
): Promise<
  { experimentRun: ExperimentRunCheckpoint; body: string } | undefined
> {
  try {
    const stat = await fs.lstat(checkpoint);
    if (!stat.isFile() || stat.size > MAX_EXPERIMENT_RUN_BYTES)
      throw new Error('Invalid experiment run checkpoint.');
    const body = await fs.readFile(checkpoint, 'utf8');
    if (Buffer.byteLength(body) > MAX_EXPERIMENT_RUN_BYTES)
      throw new Error('Invalid experiment run checkpoint.');
    return {
      experimentRun: parseExperimentRunCheckpoint(JSON.parse(body)),
      body,
    };
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new Error('Cannot read a compatible Forge experiment.json.', {
      cause: error,
    });
  }
}

async function writeExperimentRunCheckpoint(
  checkpoint: string,
  experimentRun: ExperimentRunCheckpoint,
): Promise<void> {
  const body = serializeCanonicalJson(
    parseExperimentRunCheckpoint({
      ...experimentRun,
      forge: FORGE_BUILD_IDENTITY,
    }),
  );
  if (Buffer.byteLength(body) > MAX_EXPERIMENT_RUN_BYTES)
    throw new Error('Experiment run checkpoint exceeds its byte limit.');
  await writeAtomicDocument(checkpoint, body);
}

async function writeAtomicDocument(
  checkpoint: string,
  body: string,
): Promise<void> {
  const temporary = `${checkpoint}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, checkpoint);
    const directory = await fs.open(path.dirname(checkpoint), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** One writer per local output directory, with recovery after process death. */
async function acquireExperimentRunLock(
  root: string,
): Promise<() => Promise<void>> {
  const lock = path.join(root, '.experiment.lock');
  const temporary = `${lock}.${randomUUID()}`;
  const ownerName = `owner-${randomUUID()}.json`;
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    await fs.writeFile(
      path.join(temporary, ownerName),
      serializeCanonicalJson({ pid: process.pid }),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    while (true) {
      try {
        // Publish a nonempty directory atomically. A competing rename or rmdir
        // cannot replace it while its unique owner marker remains present.
        await fs.rename(temporary, lock);
        break;
      } catch (error) {
        if (hasCode(error, 'EPERM')) {
          // Windows reports EPERM for a directory collision. Only treat it as
          // contention when the destination is an existing real directory.
          const destination = await fs.lstat(lock).catch(() => undefined);
          if (!destination?.isDirectory() || destination.isSymbolicLink())
            throw error;
        } else if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) {
          throw error;
        }
        try {
          await reclaimExperimentRunLock(lock);
        } catch (lockError) {
          if (hasCode(lockError, 'ENOENT')) continue;
          throw lockError;
        }
      }
    }
    return async () => {
      await fs.unlink(path.join(lock, ownerName));
      await removeEmptyLockDirectory(lock);
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function reclaimExperimentRunLock(lock: string): Promise<void> {
  const stat = await fs.lstat(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Invalid experiment run lock.');
  const entries = await fs.readdir(lock);
  if (entries.length === 0) {
    // Recovery or release may have removed the marker before a process exit.
    await removeEmptyLockDirectory(lock);
    return;
  }
  const ownerName = entries[0]!;
  if (entries.length !== 1 || !EXPERIMENT_LOCK_OWNER_NAME.test(ownerName)) {
    throw new Error('Invalid experiment run lock owner.');
  }
  const ownerFile = path.join(lock, ownerName);
  const ownerStat = await fs.lstat(ownerFile);
  if (
    !ownerStat.isFile() ||
    ownerStat.isSymbolicLink() ||
    ownerStat.size > MAX_EXPERIMENT_LOCK_OWNER_BYTES
  ) {
    throw new Error('Invalid experiment run lock owner.');
  }
  const owner = experimentRunLockOwnerSchema.parse(
    JSON.parse(await fs.readFile(ownerFile, 'utf8')),
  );
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!hasCode(error, 'ESRCH')) throw error;
    // A delayed reclaimer can only remove the marker it inspected, never a
    // replacement owner's marker. Never recursively remove the published lock.
    await fs.unlink(ownerFile);
    await removeEmptyLockDirectory(lock);
    return;
  }
  throw new Error(
    'Another experiment run process is using this output directory.',
  );
}

async function removeEmptyLockDirectory(lock: string): Promise<void> {
  try {
    await fs.rmdir(lock);
  } catch (error) {
    // A contender may already have published its nonempty lock or removed the
    // empty directory. Neither outcome permits deleting a current owner.
    if (
      !hasCode(error, 'ENOENT') &&
      !hasCode(error, 'ENOTEMPTY') &&
      !hasCode(error, 'EEXIST')
    )
      throw error;
  }
}

async function exists(location: string): Promise<boolean> {
  try {
    await fs.lstat(location);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function timingFields(timing: {
  reserved_at?: string | undefined;
  started_at?: string | undefined;
  finished_at?: string | undefined;
}) {
  return {
    ...(timing.reserved_at === undefined
      ? {}
      : { reserved_at: timing.reserved_at }),
    ...(timing.started_at === undefined
      ? {}
      : { started_at: timing.started_at }),
    ...(timing.finished_at === undefined
      ? {}
      : { finished_at: timing.finished_at }),
  };
}

async function readAttemptHistory(
  store: AttemptDiagnosticsStore,
  identity: AttemptDiagnosticsIdentity,
  callerSignal: AbortSignal,
  historySignal: AbortSignal,
) {
  const signal = AbortSignal.any([callerSignal, historySignal]);
  let onAbort: () => void = () => undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const input = await Promise.race([store.read(identity, signal), aborted]);
    if (input === undefined) return undefined;
    const record = parseAttemptDiagnostics(input);
    assertAttemptDiagnosticsIdentity(record.identity, identity);
    return record;
  } catch (error) {
    callerSignal.throwIfAborted();
    if (error instanceof AttemptDiagnosticsIdentityError) throw error;
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
