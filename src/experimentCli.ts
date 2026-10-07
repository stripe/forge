import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {parseArgs, type ParseArgsOptionsConfig} from 'node:util';

import {
  readExperimentRunSelections,
  runExperiment,
  type ExperimentRunOptions,
  type ExperimentRunOutcome,
  type ExperimentRunProgressEvent,
  type ExperimentRunSummary,
} from './experiment.js';
import type {ForgeComposition} from './contracts/composition.js';
import type {ForgeEngine} from './engine.js';
import type {ResolvedRunPlanV1, RunSelection} from './model/types.js';

/** Operational flags shared by command hosts; input and selection flags are host-owned. */
export const EXPERIMENT_CLI_OPTIONS = Object.freeze({
  output: Object.freeze({type: 'string', short: 'o'} as const),
  'run-id': Object.freeze({type: 'string'} as const),
  resume: Object.freeze({type: 'string'} as const),
  jobs: Object.freeze({type: 'string', short: 'j'} as const),
});

export class ExperimentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentUsageError';
  }
}

/** Compose flag definitions for an outer router without silently overriding either host. */
export function createExperimentCliOptions<H extends ParseArgsOptionsConfig>(
  hostOptions: H,
): typeof EXPERIMENT_CLI_OPTIONS & H {
  for (const name of Object.keys(hostOptions)) {
    if (Object.hasOwn(EXPERIMENT_CLI_OPTIONS, name)) {
      throw new ExperimentUsageError(`Host option --${name} conflicts with a shared experiment run option.`);
    }
  }
  const combined = {...EXPERIMENT_CLI_OPTIONS, ...hostOptions};
  const names = new Set(Object.keys(combined));
  const aliases = new Set<string>();
  for (const [name, option] of Object.entries(combined)) {
    if (option.short === undefined) continue;
    if (names.has(option.short) || aliases.has(option.short)) {
      throw new ExperimentUsageError(`Alias -${option.short} for --${name} conflicts with another option.`);
    }
    aliases.add(option.short);
  }
  return combined;
}

export interface ExperimentArgumentOptions<H extends ParseArgsOptionsConfig> {
  readonly hostOptions: H;
  /** Explicitly supplied selectors are forbidden on resume; defaults are not selectors. */
  readonly selectorOptions?: readonly (keyof H & string)[];
  readonly allowPositionals?: boolean;
}

export interface ExperimentArguments<H extends ParseArgsOptionsConfig> {
  readonly values: ExperimentValues<H>;
  readonly positionals: readonly string[];
  /** Long names of options actually supplied, independent of configured defaults. */
  readonly suppliedOptions: readonly string[];
  readonly jobs: number;
}

type HostValue<O> = O extends {type: 'string'} ? string :
  O extends {type: 'boolean'} ? boolean : string | boolean;

type HostOptionValue<O extends ParseArgsOptionsConfig[string]> = 'multiple' extends keyof O
  ? O['multiple'] extends true ? readonly HostValue<O>[]
    : true extends O['multiple'] ? HostValue<O> | readonly HostValue<O>[] : HostValue<O>
  : HostValue<O>;

export type ExperimentValues<H extends ParseArgsOptionsConfig> = {
  readonly [K in keyof H]?: HostOptionValue<H[K]>;
} & {readonly output?: string; readonly 'run-id'?: string; readonly resume?: string; readonly jobs?: string};

/** Parse shared operational flags alongside a host's own argument definitions. */
export function parseExperimentArgs<H extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: ExperimentArgumentOptions<H>,
): ExperimentArguments<H> {
  for (const selector of options.selectorOptions ?? []) {
    if (!Object.hasOwn(options.hostOptions, selector)) {
      throw new ExperimentUsageError(`Unknown host selector --${selector}.`);
    }
  }
  const definitions: ParseArgsOptionsConfig = createExperimentCliOptions(options.hostOptions);
  const parsed = parseArgs({
    args: [...argv],
    options: definitions,
    strict: true,
    allowPositionals: options.allowPositionals ?? false,
    tokens: true,
  });
  const values = parsed.values as ExperimentValues<H>;
  const suppliedOptions = [...new Set(parsed.tokens
    .filter((token) => token.kind === 'option').map((token) => token.name))];
  const value = values.jobs;
  if (value !== undefined && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new ExperimentUsageError('--jobs must be a positive safe integer.');
  }
  if (values.output !== undefined &&
      (values.output.length === 0 || values.output.includes('\0'))) {
    throw new ExperimentUsageError('--output must be a safe path.');
  }
  if (values['run-id'] !== undefined) assertExperimentRunId(values['run-id'], '--run-id');
  if (values.resume !== undefined) {
    assertExperimentRunId(values.resume, '--resume');
    if (values['run-id'] !== undefined ||
        options.selectorOptions?.some((name) => suppliedOptions.includes(name))) {
      throw new ExperimentUsageError('--resume uses the saved selections and fresh eval IDs; omit selection options and --run-id.');
    }
  }
  return {values, positionals: parsed.positionals, suppliedOptions, jobs: value === undefined ? 1 : Number(value)};
}

export interface ExperimentCommandReference {
  readonly experiment_run_id: string;
  readonly location: string;
  readonly checkpoint: string;
}

export interface ExperimentLoadContext<H extends ParseArgsOptionsConfig> extends ExperimentArguments<H> {
  readonly cwd: string;
  readonly engine: ForgeEngine;
  readonly signal: AbortSignal;
  readonly root: string;
  readonly experimentRunId: string;
  readonly resume: boolean;
  /** Read before loading/materializing inputs. Reproduce this order and original plan identities. */
  readonly savedSelections: readonly RunSelection[] | undefined;
}

export interface LoadedExperimentRun {
  readonly plans: readonly ResolvedRunPlanV1[];
  /** Construct capability descriptors only; defer authority to execute after pure preflight. */
  readonly composition: ForgeComposition;
  readonly execute?: ExperimentRunOptions['execute'];
  /** Dispose prepared inputs after every execution callback has drained; do not use the aborted signal. */
  readonly dispose?: () => Promise<void>;
}

export interface ExperimentCommandOptions<H extends ParseArgsOptionsConfig> extends ExperimentArgumentOptions<H> {
  readonly engine: ForgeEngine;
  /** Validate host grammar and positional selectors before any input loading. */
  readonly validateHostArgs?: (args: ExperimentArguments<H>) => void | Promise<void>;
  /** Clean partial preparation on rejection; successful preparation is disposed by the wrapper. */
  readonly loadExperiment: (context: ExperimentLoadContext<H>) => Promise<LoadedExperimentRun>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly experimentRunIdFactory?: () => string;
  readonly runIdFactory?: () => string;
  readonly progress?: (event: ExperimentRunProgressEvent & {readonly experiment_run_id: string}) => void;
}

export interface ExperimentCommandResult<H extends ParseArgsOptionsConfig = ParseArgsOptionsConfig>
  extends ExperimentCommandReference, ExperimentRunSummary {
  /** Host arguments remain available to the caller's rendering and publication stages. */
  readonly arguments: ExperimentArguments<H>;
  /** Verified effective outcomes in selection order, including skipped results. */
  readonly outcomes: readonly ExperimentRunOutcome[];
}

/** Failure reference for later read-only inspection/publication; cause is caller-owned, never persisted. */
export class ExperimentCommandError extends Error {
  readonly reference: ExperimentCommandReference;
  constructor(reference: ExperimentCommandReference, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Experiment command failed.', {cause});
    this.name = 'ExperimentCommandError';
    this.reference = reference;
  }
}

/** Shared run/resume stage. Hosts retain routing, inputs, publication, rendering, and exit policy. */
export async function runExperimentCommand<H extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: ExperimentCommandOptions<H>,
): Promise<ExperimentCommandResult<H>> {
  const args = parseExperimentArgs(argv, options);
  await options.validateHostArgs?.(args);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const experimentRunId = args.values.resume ?? (options.experimentRunIdFactory ?? randomUUID)();
  assertExperimentRunId(experimentRunId, 'Experiment run ID');
  const root = path.resolve(cwd, args.values.output ?? 'results', 'experiments', experimentRunId);
  const reference = {experiment_run_id: experimentRunId, location: root, checkpoint: path.join(root, 'experiment.json')};
  const signal = options.signal ?? new AbortController().signal;
  let loaded: LoadedExperimentRun | undefined;
  let failed = false;
  try {
    signal.throwIfAborted();
    const resume = args.values.resume !== undefined;
    const savedSelections = resume ? await readExperimentRunSelections(root) : undefined;
    loaded = await options.loadExperiment({...args, cwd, engine: options.engine, signal,
      root, experimentRunId, resume, savedSelections});
    if (args.values['run-id'] !== undefined && loaded.plans.length !== 1) {
      throw new ExperimentUsageError('--run-id requires exactly one selected eval combination.');
    }
    const outcomes: ExperimentRunOutcome[] = [];
    const summary = await runExperiment({
      root, plans: loaded.plans, composition: loaded.composition, engine: options.engine,
      resume, jobs: args.jobs, signal,
      execute: loaded.execute ?? ((request) => options.engine.executeEval(request)),
      runIdFactory: args.values['run-id'] === undefined ? options.runIdFactory ?? randomUUID : () => args.values['run-id']!,
      progress: (event) => options.progress?.({...event, experiment_run_id: experimentRunId}),
      onOutcome: (outcome, index) => {outcomes[index] = outcome;},
    });
    return {...reference, ...summary, arguments: args, outcomes};
  } catch (error) {
    failed = true;
    // Usage failures stay distinguishable from execution/coordinator failures.
    if (error instanceof ExperimentUsageError) throw error;
    throw new ExperimentCommandError(reference, error);
  } finally {
    try {
      await loaded?.dispose?.();
      // Cleanup completes independently of cancellation, but callers must not
      // receive success and start publication after an interrupted command.
      if (!failed) signal.throwIfAborted();
    } catch (error) {
      if (!failed) throw new ExperimentCommandError(reference, error);
    }
  }
}

function assertExperimentRunId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ExperimentUsageError(`${label} must be a safe identifier.`);
  }
}
