#!/usr/bin/env node

import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

import {createClaudeCodeAdapter} from './agents/claude-code/index.js';
import {createCodexAdapter} from './agents/codex/index.js';
import {readCampaignSelections, runCampaign} from './campaign.js';
import type {ForgeComposition} from './contracts/composition.js';
import type {RuntimePlatform} from './contracts/runtime.js';
import {createEnvironmentCredentialResolver} from './contracts/credentials.js';
import {createDirectoryRunInputProvider} from './contracts/inputs.js';
import {executeEval, FORGE_VERSION} from './execution/index.js';
import {defaultForgeEngine, type ForgeEngine} from './engine.js';
import {
  parseRunSelection,
  type DatasetManifestV1,
  type ExperimentConfigV1,
  type ForgeRuntimeV1,
  type RunSelection,
} from './model/index.js';
import {
  expandExperiment,
  ManifestCaseFileError,
  resolveManifestCaseIdFromFile,
  serializeResolvedRunPlan,
} from './planning/index.js';
import {createArtifactStore} from './results/index.js';
import {
  createDockerRuntimeAdapter,
  detectDockerRuntimePlatform,
  validateDockerRuntimeHost,
} from './runtime/docker/index.js';
import {createAnthropicCompletionProvider} from './providers/anthropic/index.js';
import {serializeCanonicalJson} from './serialization.js';

const DEFAULT_RESULTS_DIRECTORY = 'results';
const ANTHROPIC_API_KEY_REFERENCE = 'anthropic.api-key';
const ANTHROPIC_API_KEY_ENVIRONMENT = 'ANTHROPIC_API_KEY';
const ANTHROPIC_AUTH_TOKEN_REFERENCE = 'anthropic.auth-token';
const ANTHROPIC_AUTH_TOKEN_ENVIRONMENT = 'ANTHROPIC_AUTH_TOKEN';
const ANTHROPIC_BASE_URL_ENVIRONMENT = 'ANTHROPIC_BASE_URL';
const OPENAI_API_KEY_REFERENCE = 'openai.api-key';
const CODEX_API_KEY_ENVIRONMENT = 'CODEX_API_KEY';
const OPENAI_BASE_URL_ENVIRONMENT = 'OPENAI_BASE_URL';

const CLI_OPTIONS = {
  experiment: {type: 'string', short: 'e'},
  case: {type: 'string'},
  'case-file': {type: 'string'},
  treatment: {type: 'string'},
  agent: {type: 'string'},
  provider: {type: 'string'},
  model: {type: 'string'},
  repetition: {type: 'string'},
  output: {type: 'string', short: 'o'},
  'run-id': {type: 'string'},
  resume: {type: 'string'},
  'credential-env': {type: 'string', multiple: true},
  host: {type: 'boolean'},
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
  forge validate --experiment <file> [--host]
  forge plan --experiment <file> [selection options]
  forge run --experiment <file> [selection options] [run options]
  forge run --experiment <file> --resume <experiment-run-id> [run options]

Selection options:
  --case <id>          Select an eval case
  --case-file <file>   Select a manifest-listed case within the configured dataset
  --treatment <id>     Select a treatment
  --agent <adapter>    Select an agent adapter
  --provider <id>      Select a model provider
  --model <id>         Select a model
  --repetition <index> Select a zero-based repetition

Run options:
  --output <directory> Write experiment executions below this directory (default: ./results)
  --run-id <id>        Use an explicit eval ID when exactly one combination is selected
  --resume <id>        Resume this experiment execution; an ID is required
  --credential-env <reference>=<environment-name>
                        Bind an opaque credential reference for this run

Validation options:
  --host                Build and inspect the selected Docker runtime image

The experiment's dataset.path locates the dataset relative to the experiment file.
The run command executes every matching matrix entry sequentially.
Each new invocation creates results/experiments/<experiment-run-id>/.
The plan command requires exactly one matching matrix entry.
`;

export interface DefaultCliCompositionOptions {
  readonly datasetRoot: string;
  /** Verified inventory supplied by runCli for consumption-time input checks. */
  readonly datasetManifest?: DatasetManifestV1;
  readonly resultsRoot: string;
  /** Resolved runtime selection supplied by runCli to embedding hosts. */
  readonly runtime?: ForgeRuntimeV1;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly credentialBindings?: Readonly<Record<string, string>>;
}

export interface RunCliOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** Immutable model/execution semantics; defaults to public built-ins only. */
  readonly engine?: ForgeEngine;
  /** Test/embedding seams; the executable uses the public defaults. */
  readonly compositionFactory?: (
    options: DefaultCliCompositionOptions,
  ) => Promise<ForgeComposition>;
  readonly execute?: typeof executeEval;
  readonly runIdFactory?: () => string;
  readonly experimentRunIdFactory?: () => string;
  /** Concrete target for authored `platform: native`; defaults to Docker detection. */
  readonly runtimePlatform?: RuntimePlatform;
  readonly detectDockerPlatform?: typeof detectDockerRuntimePlatform;
  readonly validateDockerHost?: typeof validateDockerRuntimeHost;
}

/** The portable composition used by the public executable. */
export async function createDefaultCliComposition(
  options: DefaultCliCompositionOptions,
): Promise<ForgeComposition> {
  if (options.runtime && 'config' in options.runtime) {
    throw new CliUsageError('External runtimes require a host-supplied compositionFactory.');
  }
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
  const codexBaseUrl = environment[OPENAI_BASE_URL_ENVIRONMENT];
  const codex = createCodexAdapter({
    credential: OPENAI_API_KEY_REFERENCE,
    ...(codexBaseUrl === undefined ? {} : {baseUrl: codexBaseUrl}),
  });
  const bindings = new Map<string, string>([
    [credential, credentialEnvironmentName],
    [OPENAI_API_KEY_REFERENCE, CODEX_API_KEY_ENVIRONMENT],
    ...Object.entries(options.credentialBindings ?? {}),
  ]);
  const credentialResolver = createEnvironmentCredentialResolver({
    bindings: Object.fromEntries(bindings),
    environment,
  });

  return Object.freeze({
    runtime: createDockerRuntimeAdapter(),
    agents: new Map([[claude.id, claude], [codex.id, codex]]),
    completionProviders: new Map([
      [completionProvider.id, completionProvider],
    ]),
    credentialResolver,
    inputProvider: await createDirectoryRunInputProvider(options.datasetRoot, {
      ...(options.datasetManifest === undefined ? {} : {manifest: options.datasetManifest}),
    }),
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
  const engine = options.engine ?? defaultForgeEngine;

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
      'experiment',
      ...(command === 'validate' ? (['host'] as const) : SELECTOR_OPTIONS),
      ...(command === 'run'
        ? (['output', 'run-id', 'credential-env', 'resume'] as const)
        : []),
    ];
    assertAllowedOptions(parsed.values, allowed);
    if (parsed.values.resume !== undefined) {
      assertRunId(parsed.values.resume, '--resume');
      if (parsed.values['run-id'] !== undefined || SELECTOR_OPTIONS.some((name) => parsed.values[name] !== undefined)) {
        throw new CliUsageError('--resume uses the saved selections and fresh eval IDs; omit selection options and --run-id.');
      }
    }

    const cwd = path.resolve(options.cwd ?? process.cwd());
    const experimentPath = resolveRequiredPath(
      parsed.values.experiment,
      'experiment',
      cwd,
    );
    if (parsed.values.case !== undefined && parsed.values['case-file'] !== undefined) {
      throw new CliUsageError('--case and --case-file cannot be combined.');
    }
    const caseFilePath = resolveOptionalPath(
      parsed.values['case-file'],
      'case-file',
      cwd,
    );
    const experiment = await engine.loadExperimentConfig(experimentPath);
    if (experiment.config.dataset.path === undefined) {
      throw new CliUsageError('The experiment must declare dataset.path, relative to the experiment file.');
    }
    const dataset = await engine.loadDataset(path.resolve(experiment.root, experiment.config.dataset.path));
    const nativeDocker =
      experiment.config.runtime.adapter === 'docker' &&
      experiment.config.runtime.platform === 'native';

    if (command === 'validate') {
      const selections = expandExperiment(experiment);
      const compositionFactory =
        options.compositionFactory ?? createDefaultCliComposition;
      let hostSelection:
        | {
            docker_platform: RuntimePlatform;
            runtime_platform: RuntimePlatform;
          }
        | undefined;
      if (parsed.values.host === true) {
        if (experiment.config.runtime.adapter !== 'docker') {
          throw new CliUsageError(
            '--host supports only the built-in Docker runtime.',
          );
        }
        const dockerPlatform = await (
          options.detectDockerPlatform ?? detectDockerRuntimePlatform
        )(
          options.signal === undefined ? {} : {signal: options.signal},
        );
        const runtimePlatform =
          experiment.config.runtime.platform === 'native'
            ? dockerPlatform
            : experiment.config.runtime.platform;
        hostSelection = {
          docker_platform: dockerPlatform,
          runtime_platform: runtimePlatform,
        };
      }
      const validationPlatforms: readonly (RuntimePlatform | undefined)[] =
        nativeDocker
          ? hostSelection === undefined
            ? ['linux/amd64', 'linux/arm64']
            : [hostSelection.runtime_platform]
          : [undefined];
      for (const runtimePlatform of validationPlatforms) {
        const plans = selections.map((selection) =>
          engine.resolveRunPlan({
            dataset,
            experiment,
            selection,
            ...(runtimePlatform === undefined ? {} : {runtimePlatform}),
          }),
        );
        const composition = await compositionFactory({
          datasetRoot: dataset.root,
          datasetManifest: dataset.manifest,
          ...(plans[0] === undefined ? {} : {runtime: plans[0].runtime}),
          resultsRoot: path.resolve(cwd, DEFAULT_RESULTS_DIRECTORY),
          ...(options.environment === undefined
            ? {}
            : {environment: options.environment}),
        });
        for (const plan of plans) {
          engine.preflightEval({plan, composition});
        }
      }
      const host =
        hostSelection === undefined
          ? undefined
          : await (async () => {
              const validated = await (
                options.validateDockerHost ?? validateDockerRuntimeHost
              )({
                platform: hostSelection.runtime_platform,
                ...(options.signal === undefined
                  ? {}
                  : {signal: options.signal}),
              });
              return {
                ...hostSelection,
                image_id: validated.imageId,
              };
            })();
      stdout(
        serializeCanonicalJson({
          dataset: dataset.manifest.dataset,
          experiment: {
            id: experiment.config.id,
            version: experiment.config.version,
          },
          ...(host === undefined ? {} : {host}),
          run_count: selections.length,
          valid: true,
        }),
      );
      return 0;
    }

    const runtimePlatform = nativeDocker
      ? (options.runtimePlatform ??
        (await (
          options.detectDockerPlatform ?? detectDockerRuntimePlatform
        )(
          options.signal === undefined ? {} : {signal: options.signal},
        )))
      : undefined;

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
    const filters: SelectionFilters = {
      caseId,
      treatment: parsed.values.treatment,
      adapter: parsed.values.agent,
      provider: parsed.values.provider,
      model: parsed.values.model,
      repetition: parseRepetition(parsed.values.repetition),
    };
    const outputRoot = path.resolve(cwd, parsed.values.output ?? DEFAULT_RESULTS_DIRECTORY);
    const experimentRunId = command === 'run'
      ? parsed.values.resume ?? (options.experimentRunIdFactory ?? randomUUID)()
      : undefined;
    if (experimentRunId !== undefined) assertRunId(experimentRunId, 'Experiment execution ID');
    const resultsRoot = experimentRunId === undefined
      ? outputRoot
      : path.join(outputRoot, 'experiments', experimentRunId);
    const selections = parsed.values.resume !== undefined
      ? await readCampaignSelections(resultsRoot)
      : command === 'run'
        ? selectMatching(experiment.config, filters)
        : [selectOne(experiment.config, filters)];
    const plans = selections.map((selection) => engine.resolveRunPlan({
      dataset,
      experiment,
      selection,
      ...(runtimePlatform === undefined ? {} : {runtimePlatform}),
    }));
    const plan = plans[0]!;

    if (command === 'plan') {
      stdout(serializeResolvedRunPlan(plan));
      return 0;
    }

    const explicitRunId = parsed.values['run-id'];
    if (explicitRunId !== undefined) {
      assertRunId(explicitRunId, '--run-id');
      if (plans.length !== 1) throw new CliUsageError('--run-id requires exactly one selected eval combination.');
    }
    const credentialBindings = parseCredentialEnvironmentBindings(
      parsed.values['credential-env'],
    );
    const compositionFactory =
      options.compositionFactory ?? createDefaultCliComposition;
    const composition = await compositionFactory({
      datasetRoot: dataset.root,
      datasetManifest: dataset.manifest,
      runtime: plan.runtime,
      resultsRoot,
      ...(options.environment === undefined
        ? {}
        : {environment: options.environment}),
      ...(Object.keys(credentialBindings).length === 0
        ? {}
        : {credentialBindings}),
    });
    const summary = await runCampaign({
      root: resultsRoot,
      plans,
      composition,
      engine,
      resume: parsed.values.resume !== undefined,
      signal: options.signal ?? new AbortController().signal,
      execute: options.execute ?? engine.executeEval,
      runIdFactory: explicitRunId === undefined ? options.runIdFactory ?? randomUUID : () => explicitRunId,
      progress: (event) => stderr(serializeCanonicalJson({experiment_run_id: experimentRunId, ...event})),
    });
    stdout(serializeCanonicalJson({experiment_run_id: experimentRunId, location: resultsRoot, ...summary}));
    return summary.errored === 0 ? 0 : 1;
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
  experiment: ExperimentConfigV1,
  filters: SelectionFilters,
): RunSelection {
  const matches = selectMatching(experiment, filters);
  if (matches.length > 1) {
    throw new CliUsageError(
      `Selection matches ${matches.length} matrix entries; add selection options.`,
    );
  }
  return matches[0]!;
}

function selectMatching(
  experiment: ExperimentConfigV1,
  filters: SelectionFilters,
): RunSelection[] {
  const matches = expandExperiment(experiment).filter((selection) =>
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
  return matches.map(parseRunSelection);
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

function assertAllowedOptions(
  values: Readonly<
    Record<string, string | readonly string[] | boolean | undefined>
  >,
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

function parseCredentialEnvironmentBindings(
  values: readonly string[] | undefined,
): Readonly<Record<string, string>> {
  const bindings = new Map<string, string>();
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    const reference = separator < 1 ? '' : value.slice(0, separator);
    const environmentName = separator < 0 ? '' : value.slice(separator + 1);
    if (
      reference.length === 0 ||
      Buffer.byteLength(reference, 'utf8') > 1024 ||
      /[\u0000-\u001f\u007f]/.test(reference) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)
    ) {
      throw new CliUsageError(
        '--credential-env must be an opaque reference followed by a valid environment variable name.',
      );
    }
    const previous = bindings.get(reference);
    if (previous !== undefined && previous !== environmentName) {
      throw new CliUsageError(
        `Credential reference ${JSON.stringify(reference)} has conflicting environment bindings.`,
      );
    }
    bindings.set(reference, environmentName);
  }
  return Object.freeze(Object.fromEntries(bindings));
}

function assertRunId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new CliUsageError(`${label} must be a safe identifier.`);
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
