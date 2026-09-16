#!/usr/bin/env node

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

import {createClaudeCodeAdapter} from './agents/claude-code/index.js';
import type {ForgeComposition} from './contracts/composition.js';
import {createEnvironmentCredentialResolver} from './contracts/credentials.js';
import {createDirectoryRunInputProvider} from './contracts/inputs.js';
import {executeEval, FORGE_VERSION, preflightEval} from './execution/index.js';
import {
  loadBenchmarkProfile,
  loadDataset,
  parseRunSelection,
  type BenchmarkProfileV1,
  type RunSelection,
} from './model/index.js';
import {
  expandExperiment,
  ManifestCaseFileError,
  resolveManifestCaseIdFromFile,
  resolveRunPlan,
  serializeResolvedRunPlan,
} from './planning/index.js';
import {createArtifactStore} from './results/index.js';
import {createDockerRuntimeAdapter} from './runtime/docker/index.js';
import {createAnthropicCompletionProvider} from './providers/anthropic/index.js';
import {serializeCanonicalJson} from './serialization.js';
import {forgeSetupHandlers} from './setup/index.js';

const DEFAULT_RESULTS_DIRECTORY = 'results';
const ANTHROPIC_API_KEY_REFERENCE = 'anthropic.api-key';
const ANTHROPIC_API_KEY_ENVIRONMENT = 'ANTHROPIC_API_KEY';
const ANTHROPIC_AUTH_TOKEN_REFERENCE = 'anthropic.auth-token';
const ANTHROPIC_AUTH_TOKEN_ENVIRONMENT = 'ANTHROPIC_AUTH_TOKEN';
const ANTHROPIC_BASE_URL_ENVIRONMENT = 'ANTHROPIC_BASE_URL';

const CLI_OPTIONS = {
  profile: {type: 'string', short: 'p'},
  dataset: {type: 'string', short: 'd'},
  case: {type: 'string'},
  'case-file': {type: 'string'},
  treatment: {type: 'string'},
  agent: {type: 'string'},
  provider: {type: 'string'},
  model: {type: 'string'},
  repetition: {type: 'string'},
  output: {type: 'string', short: 'o'},
  'run-id': {type: 'string'},
  help: {type: 'boolean', short: 'h'},
  version: {type: 'boolean'},
} as const;

type CliOptionName = keyof typeof CLI_OPTIONS;

const SELECTOR_OPTIONS: readonly CliOptionName[] = [
  'case',
  'case-file',
  'treatment',
  'agent',
  'provider',
  'model',
  'repetition',
];

const USAGE = `Usage:
  forge validate --profile <file> --dataset <directory>
  forge plan --profile <file> --dataset <directory> [selection options]
  forge plan --profile <file> --case-file <file> [selection options]
  forge run --profile <file> --dataset <directory> [selection options] [--output <directory>] [--run-id <id>]
  forge run --profile <file> --case-file <file> [selection options] [--output <directory>] [--run-id <id>]

Selection options:
  --case <id>          Select an eval case
  --case-file <file>   Select a manifest-listed case by file; discovers its dataset when --dataset is omitted
  --treatment <id>     Select a treatment
  --agent <adapter>    Select an agent adapter
  --provider <id>      Select a model provider
  --model <id>         Select a model
  --repetition <index> Select a zero-based repetition

If selection options match more than one matrix entry, narrow the selection.
The run command writes atomic results below ./results by default.
`;

export interface DefaultCliCompositionOptions {
  readonly datasetRoot: string;
  readonly resultsRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface RunCliOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** Test/embedding seams; the executable uses the public defaults. */
  readonly compositionFactory?: (
    options: DefaultCliCompositionOptions,
  ) => Promise<ForgeComposition>;
  readonly execute?: typeof executeEval;
  readonly runIdFactory?: () => string;
}

/** The portable composition used by the public executable. */
export async function createDefaultCliComposition(
  options: DefaultCliCompositionOptions,
): Promise<ForgeComposition> {
  const environment = options.environment ?? process.env;
  const baseUrl = environment[ANTHROPIC_BASE_URL_ENVIRONMENT];
  const gatewaySelected = baseUrl !== undefined;
  const credential = gatewaySelected
    ? ANTHROPIC_AUTH_TOKEN_REFERENCE
    : ANTHROPIC_API_KEY_REFERENCE;
  const credentialEnvironmentName = gatewaySelected
    ? ANTHROPIC_AUTH_TOKEN_ENVIRONMENT
    : ANTHROPIC_API_KEY_ENVIRONMENT;
  const claude = createClaudeCodeAdapter({
    credential,
    credentialEnvironmentName,
    ...(baseUrl === undefined ? {} : {baseUrl}),
  });
  const completionProvider = createAnthropicCompletionProvider({
    credential,
    auth: gatewaySelected ? 'bearer' : 'api-key',
    ...(baseUrl === undefined ? {} : {baseUrl}),
  });
  const credentialResolver = createEnvironmentCredentialResolver({
    bindings: {
      [credential]: credentialEnvironmentName,
    },
    environment,
  });

  return Object.freeze({
    runtime: createDockerRuntimeAdapter(),
    agents: new Map([[claude.id, claude]]),
    setupHandlers: forgeSetupHandlers,
    completionProviders: new Map([
      [completionProvider.id, completionProvider],
    ]),
    credentialResolver,
    inputProvider: await createDirectoryRunInputProvider(options.datasetRoot),
    artifactStore: createArtifactStore({root: options.resultsRoot}),
  });
}

/** Run one CLI invocation without mutating process.exitCode. */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (parsed.values.version) {
      stdout(`${FORGE_VERSION}\n`);
      return 0;
    }

    const command = parsed.positionals[0];
    if (parsed.values.help || command === 'help') {
      stdout(USAGE);
      return 0;
    }
    if (parsed.positionals.length !== 1 || !isCommand(command)) {
      throw new CliUsageError('Expected one command: validate, plan, or run.');
    }

    const allowed: CliOptionName[] = [
      'profile',
      'dataset',
      ...(command === 'validate' ? [] : SELECTOR_OPTIONS),
      ...(command === 'run' ? (['output', 'run-id'] as const) : []),
    ];
    assertAllowedOptions(parsed.values, allowed);

    const cwd = path.resolve(options.cwd ?? process.cwd());
    const profilePath = resolveRequiredPath(parsed.values.profile, 'profile', cwd);
    if (parsed.values.case !== undefined && parsed.values['case-file'] !== undefined) {
      throw new CliUsageError('--case and --case-file cannot be combined.');
    }
    const caseFilePath = resolveOptionalPath(
      parsed.values['case-file'],
      'case-file',
      cwd,
    );
    const datasetPath = parsed.values.dataset === undefined
      ? caseFilePath === undefined
        ? resolveRequiredPath(undefined, 'dataset', cwd)
        : await discoverDatasetRoot(caseFilePath)
      : resolveRequiredPath(parsed.values.dataset, 'dataset', cwd);
    const [dataset, profile] = await Promise.all([
      loadDataset(datasetPath),
      loadBenchmarkProfile(profilePath),
    ]);

    if (command === 'validate') {
      const selections = expandExperiment(profile);
      const plans = selections.map((selection) =>
        resolveRunPlan({dataset, profile, selection}),
      );
      const compositionFactory =
        options.compositionFactory ?? createDefaultCliComposition;
      const composition = await compositionFactory({
        datasetRoot: dataset.root,
        resultsRoot: path.resolve(cwd, DEFAULT_RESULTS_DIRECTORY),
        ...(options.environment === undefined
          ? {}
          : {environment: options.environment}),
      });
      for (const plan of plans) {
        preflightEval({plan, composition});
      }
      stdout(
        serializeCanonicalJson({
          dataset: dataset.manifest.dataset,
          profile: {
            id: profile.profile.id,
            version: profile.profile.version,
          },
          run_count: selections.length,
          valid: true,
        }),
      );
      return 0;
    }

    let caseId = parsed.values.case;
    if (caseFilePath !== undefined) {
      try {
        caseId = await resolveManifestCaseIdFromFile(dataset, caseFilePath);
      } catch (error) {
        if (error instanceof ManifestCaseFileError) {
          throw new CliUsageError(error.message);
        }
        throw error;
      }
    }
    const selection = selectOne(profile.profile, {
      caseId,
      treatment: parsed.values.treatment,
      adapter: parsed.values.agent,
      provider: parsed.values.provider,
      model: parsed.values.model,
      repetition: parseRepetition(parsed.values.repetition),
    });
    const plan = resolveRunPlan({dataset, profile, selection});

    if (command === 'plan') {
      stdout(serializeResolvedRunPlan(plan));
      return 0;
    }

    const resultsRoot = path.resolve(
      cwd,
      parsed.values.output ?? DEFAULT_RESULTS_DIRECTORY,
    );
    const runId = parsed.values['run-id'] ??
      (options.runIdFactory ?? randomUUID)();
    assertRunId(runId);
    const compositionFactory =
      options.compositionFactory ?? createDefaultCliComposition;
    const composition = await compositionFactory({
      datasetRoot: dataset.root,
      resultsRoot,
      ...(options.environment === undefined
        ? {}
        : {environment: options.environment}),
    });
    const completed = await (options.execute ?? executeEval)({
      runId,
      plan,
      composition,
      signal: options.signal ?? new AbortController().signal,
    });
    stdout(
      serializeCanonicalJson({
        location: completed.location,
        result: completed.result,
        run_id: completed.runId,
      }),
    );
    return 0;
  } catch (error) {
    stderr(`forge: ${errorMessage(error)}\n`);
    if (isUsageError(error)) stderr(`Run forge --help for usage.\n`);
    return isUsageError(error) ? 2 : 1;
  }
}

interface SelectionFilters {
  readonly caseId: string | undefined;
  readonly treatment: string | undefined;
  readonly adapter: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly repetition: number | undefined;
}

function selectOne(
  profile: BenchmarkProfileV1,
  filters: SelectionFilters,
): RunSelection {
  const matches = expandExperiment(profile).filter((selection) =>
    (filters.caseId === undefined || selection.case_id === filters.caseId) &&
    (filters.treatment === undefined || selection.treatment === filters.treatment) &&
    (filters.adapter === undefined || selection.agent.adapter === filters.adapter) &&
    (filters.provider === undefined || selection.agent.provider === filters.provider) &&
    (filters.model === undefined || selection.agent.model === filters.model) &&
    (filters.repetition === undefined || selection.repetition === filters.repetition),
  );
  if (matches.length === 0) {
    throw new CliUsageError('Selection does not match the benchmark matrix.');
  }
  if (matches.length > 1) {
    throw new CliUsageError(
      `Selection matches ${matches.length} matrix entries; add selection options.`,
    );
  }
  return parseRunSelection(matches[0]);
}

function parseRepetition(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CliUsageError('repetition must be a zero-based integer.');
  }
  const repetition = Number(value);
  if (!Number.isSafeInteger(repetition)) {
    throw new CliUsageError('repetition must be a safe integer.');
  }
  return repetition;
}

function resolveRequiredPath(
  value: string | undefined,
  option: string,
  cwd: string,
): string {
  if (!value || value.includes('\0')) {
    throw new CliUsageError(`--${option} is required.`);
  }
  return path.resolve(cwd, value);
}

function resolveOptionalPath(
  value: string | undefined,
  option: string,
  cwd: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.includes('\0')) {
    throw new CliUsageError(`--${option} must be a safe path.`);
  }
  return path.resolve(cwd, value);
}

async function discoverDatasetRoot(caseFilePath: string): Promise<string> {
  let directory = path.dirname(caseFilePath);
  while (true) {
    const manifestPath = path.join(directory, 'manifest.json');
    try {
      await fs.lstat(manifestPath);
      return directory;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new CliUsageError(
    'Could not discover a dataset manifest from --case-file; pass --dataset explicitly.',
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function assertAllowedOptions(
  values: Readonly<Record<string, string | boolean | undefined>>,
  allowed: readonly CliOptionName[],
): void {
  const accepted = new Set<CliOptionName>([
    ...allowed,
    'help',
    'version',
  ]);
  for (const option of Object.keys(values) as CliOptionName[]) {
    if (!accepted.has(option)) {
      throw new CliUsageError(`--${option} is not valid for this command.`);
    }
  }
}

function assertRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new CliUsageError('--run-id must be a safe identifier.');
  }
}

function isCommand(value: string | undefined): value is 'validate' | 'plan' | 'run' {
  return value === 'validate' || value === 'plan' || value === 'run';
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function isUsageError(error: unknown): boolean {
  return (
    error instanceof CliUsageError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('ERR_PARSE_ARGS'))
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Unknown failure.';
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Forge received ${signal}.`));
    }
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  void runCli(process.argv.slice(2), {signal: controller.signal}).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.exitCode = 1;
    },
  ).finally(() => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  });
}
