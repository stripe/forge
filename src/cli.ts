#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createClaudeCodeAdapter } from './agents/claude-code/index.ts';
import { createCodexAdapter } from './agents/codex/index.ts';
import { createOpenCodeAdapter } from './agents/opencode/index.ts';
import type { ForgeComposition } from './contracts/composition.ts';
import {
  type CredentialResolver,
  createEnvironmentCredentialResolver,
} from './contracts/credentials.ts';
import { createDirectoryRunInputProvider } from './contracts/inputs.ts';
import type { RuntimePlatform } from './contracts/runtime.ts';
import { CredentialReferenceConflictError } from './credentialDeclarations.ts';
import { defaultForgeEngine, type ForgeEngine } from './engine.ts';
import type { EvalCredentialUse } from './execution/execute.ts';
import {
  type executeEval,
  FORGE_VERSION,
  ForgeExecutionError,
} from './execution/index.ts';
import {
  createExperimentCliOptions,
  EXPERIMENT_CLI_OPTIONS,
  ExperimentCommandError,
  ExperimentUsageError,
  runExperimentCommand,
} from './experimentCli.ts';
import {
  type ExperimentConfigV1,
  type ForgeRuntimeV1,
  getMatrixGroups,
  type LoadedDatasetV1,
  parseRunSelection,
  type RunSelection,
} from './model/index.ts';
import {
  expandExperiment,
  ManifestCaseFileError,
  resolveManifestCaseIdFromFile,
  serializeResolvedRunPlan,
} from './planning/index.ts';
import { validateExperimentDataset } from './planning/planner.ts';
import {
  AnthropicCompletionError,
  createAnthropicCompletionProvider,
} from './providers/anthropic/index.ts';
import { createOpenAICompletionProvider } from './providers/openai/index.ts';
import type { RegradeDiff } from './regrade/diff.ts';
import { regradeExperimentRun } from './regrade/experiment.ts';
import { diffRegradeExperimentRun } from './regrade/loadDiff.ts';
import { createArtifactStore } from './results/index.ts';
import {
  createDockerRuntimeAdapter,
  detectDockerRuntimePlatform,
  validateDockerRuntimeHost,
} from './runtime/docker/index.ts';
import { serializeCanonicalJson } from './serialization.ts';

const DEFAULT_RESULTS_DIRECTORY = 'results';
const ANTHROPIC_API_KEY_REFERENCE = 'anthropic.api-key';
const ANTHROPIC_API_KEY_ENVIRONMENT = 'ANTHROPIC_API_KEY';
const ANTHROPIC_AUTH_TOKEN_REFERENCE = 'anthropic.auth-token';
const ANTHROPIC_AUTH_TOKEN_ENVIRONMENT = 'ANTHROPIC_AUTH_TOKEN';
const ANTHROPIC_COMPLETION_API_KEY_REFERENCE = 'anthropic.completion-api-key';
const ANTHROPIC_COMPLETION_AUTH_TOKEN_REFERENCE =
  'anthropic.completion-auth-token';
const ANTHROPIC_BASE_URL_ENVIRONMENT = 'ANTHROPIC_BASE_URL';
const OPENAI_API_KEY_REFERENCE = 'openai.api-key';
const OPENAI_COMPLETION_API_KEY_REFERENCE = 'openai.completion-api-key';
const OPENAI_API_KEY_ENVIRONMENT = 'OPENAI_API_KEY';
const OPENAI_BASE_URL_ENVIRONMENT = 'OPENAI_BASE_URL';
// Names used by the public host's shorthand and diagnostics, never automatic grants.
const CLI_CREDENTIAL_ENVIRONMENTS: ReadonlyMap<string, string> = new Map([
  [ANTHROPIC_API_KEY_REFERENCE, ANTHROPIC_API_KEY_ENVIRONMENT],
  [ANTHROPIC_AUTH_TOKEN_REFERENCE, ANTHROPIC_AUTH_TOKEN_ENVIRONMENT],
  [ANTHROPIC_COMPLETION_API_KEY_REFERENCE, ANTHROPIC_API_KEY_ENVIRONMENT],
  [ANTHROPIC_COMPLETION_AUTH_TOKEN_REFERENCE, ANTHROPIC_AUTH_TOKEN_ENVIRONMENT],
  [OPENAI_API_KEY_REFERENCE, OPENAI_API_KEY_ENVIRONMENT],
  [OPENAI_COMPLETION_API_KEY_REFERENCE, OPENAI_API_KEY_ENVIRONMENT],
  ['opencode.api-key', 'OPENCODE_API_KEY'],
]);

const HOST_CLI_OPTIONS = {
  experiment: { type: 'string', short: 'e' },
  case: { type: 'string' },
  'case-file': { type: 'string' },
  treatment: { type: 'string' },
  group: { type: 'string' },
  agent: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  repetition: { type: 'string' },
  'credential-env': { type: 'string', multiple: true },
  'experiment-run': { type: 'string' },
  'judge-provider': { type: 'string' },
  'judge-model': { type: 'string' },
  regrade: { type: 'string' },
  json: { type: 'boolean' },
  host: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;
const CLI_OPTIONS = createExperimentCliOptions(HOST_CLI_OPTIONS);

type CliOptionName = keyof typeof CLI_OPTIONS;

const SELECTOR_OPTIONS: readonly (keyof typeof HOST_CLI_OPTIONS)[] = [
  'case',
  'case-file',
  'treatment',
  'group',
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
  forge regrade diff --experiment-run <directory> --regrade <directory> [--json]
  forge regrade --experiment-run <directory> --judge-provider <id> --judge-model <id> --output <directory> [--jobs <count>]

Selection options:
  --case <id>          Select an eval case
  --case-file <file>   Select a manifest-listed case within the configured dataset
  --treatment <id>     Select a treatment
  --group <id>         Select a named matrix group
  --agent <adapter>    Select an agent adapter
  --provider <id>      Select a model provider
  --model <id>         Select a model
  --repetition <index> Select a zero-based repetition

Run options:
  --output <directory> Write experiment runs below this directory (default: ./results)
  --run-id <id>        Use an explicit eval ID when exactly one combination is selected
  --resume <id>        Resume this experiment run; an ID is required
  --jobs <count>       Maximum simultaneous evals (default: 1)
  --credential-env <environment-name>
                        Authorize selected consumers of this host variable
  --credential-env <reference>=<environment-name>
                        Bind one credential reference for scoped access or separate keys

Validation options:
  --host                Build and inspect the selected Docker runtime image

Regrade options:
  --experiment-run <directory>  Saved experiment run (results/experiments/<id>), read only
  --judge-provider <id>         Completion provider for the new judge, such as anthropic
  --judge-model <id>            Judge model
  --output <directory>          New directory for regrades and report.json, outside the source
  --jobs <count>                Maximum simultaneous run regrades (default: 1)
  --credential-env <reference>=<environment-name>
                                 Bind an opaque credential reference for the judge

Regrade diff options:
  --regrade <directory>         Directory holding saved runs/<run-id>.json regrades
  --json                       Print the comparison as JSON instead of text

The experiment's dataset.path locates the dataset relative to the experiment file.
The run command executes every matching matrix entry with bounded concurrency.
Each new invocation creates results/experiments/<experiment-run-id>/.
The plan command requires exactly one matching matrix entry.
The regrade command judges completed runs again from their saved artifacts; it
re-runs no agent or Ava turn and keeps each run's original check results.
`;

export interface DefaultCliCompositionOptions {
  readonly datasetRoot: string;
  readonly resultsRoot: string;
  /** Resolved runtime selection supplied by runCli to embedding hosts. */
  readonly runtime?: ForgeRuntimeV1;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Explicit reference mappings; same-name grants are bound after discovery. */
  readonly credentialBindings?: Readonly<Record<string, string>>;
  /** Run-owned resolver handle; forwarding wrappers should preserve this option. */
  readonly credentialResolver?: CredentialResolver;
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
    throw new CliUsageError(
      'External runtimes require a host-supplied compositionFactory.',
    );
  }
  const environment = options.environment ?? process.env;
  const bindings = Object.freeze({ ...options.credentialBindings });
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
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const completionProvider = createAnthropicCompletionProvider({
    credential: gatewaySelected
      ? ANTHROPIC_COMPLETION_AUTH_TOKEN_REFERENCE
      : ANTHROPIC_COMPLETION_API_KEY_REFERENCE,
    auth: gatewaySelected ? 'bearer' : 'api-key',
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const codexBaseUrl = environment[OPENAI_BASE_URL_ENVIRONMENT];
  const openaiCompletionProvider = createOpenAICompletionProvider({
    credential: OPENAI_COMPLETION_API_KEY_REFERENCE,
    ...(codexBaseUrl === undefined ? {} : { baseUrl: codexBaseUrl }),
  });
  const codex = createCodexAdapter({
    credential: OPENAI_API_KEY_REFERENCE,
    credentialEnvironmentName: OPENAI_API_KEY_ENVIRONMENT,
    ...(codexBaseUrl === undefined ? {} : { baseUrl: codexBaseUrl }),
  });
  const opencodeBaseUrl = environment.OPENCODE_BASE_URL;
  const opencode = createOpenCodeAdapter({
    ...(opencodeBaseUrl === undefined ? {} : { baseUrl: opencodeBaseUrl }),
  });
  const credentialResolver =
    options.credentialResolver ??
    createCliCredentialResolver(bindings, environment);
  configureCliCredentialBindings.get(credentialResolver)?.(
    bindings,
    environment,
  );

  return Object.freeze({
    runtime: createDockerRuntimeAdapter(),
    agents: new Map([
      [claude.id, claude],
      [codex.id, codex],
      [opencode.id, opencode],
    ]),
    completionProviders: new Map([
      [completionProvider.id, completionProvider],
      [openaiCompletionProvider.id, openaiCompletionProvider],
    ]),
    credentialResolver,
    inputProvider: await createDirectoryRunInputProvider(options.datasetRoot),
    artifactStore: createArtifactStore({ root: options.resultsRoot }),
  });
}

/** Run one CLI invocation without mutating process.exitCode. */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const stdout =
    options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr =
    options.stderr ?? ((text: string) => void process.stderr.write(text));
  const engine = options.engine ?? defaultForgeEngine;
  let running = false;

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
    if (command === 'regrade' && parsed.positionals[1] === 'diff') {
      if (parsed.positionals.length !== 2)
        throw new CliUsageError(
          'Expected regrade diff with no extra arguments.',
        );
      assertAllowedOptions(parsed.values, [
        'experiment-run',
        'regrade',
        'json',
      ]);
      const required = (name: 'experiment-run' | 'regrade'): string => {
        const value = parsed.values[name];
        if (typeof value !== 'string' || value.length === 0)
          throw new CliUsageError(`regrade diff requires --${name}.`);
        return path.resolve(options.cwd ?? process.cwd(), value);
      };
      const diff = await diffRegradeExperimentRun({
        experimentRun: required('experiment-run'),
        regrade: required('regrade'),
        engine,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      stdout(
        parsed.values.json
          ? `${JSON.stringify(diff)}\n`
          : renderRegradeDiff(diff),
      );
      return diff.coverage === 'complete' ? 0 : 1;
    }
    if (parsed.positionals.length !== 1 || !isCommand(command)) {
      throw new CliUsageError(
        'Expected one command: validate, plan, run, or regrade.',
      );
    }
    if (command === 'regrade') {
      assertAllowedOptions(parsed.values, [
        'experiment-run',
        'judge-provider',
        'judge-model',
        'output',
        'jobs',
        'credential-env',
      ]);
      return await runRegradeCommand(
        parsed.values,
        options,
        engine,
        stdout,
        stderr,
      );
    }

    const allowed: CliOptionName[] = [
      'experiment',
      ...(command === 'validate' ? (['host'] as const) : SELECTOR_OPTIONS),
      ...(command === 'run'
        ? [
            ...(Object.keys(
              EXPERIMENT_CLI_OPTIONS,
            ) as (keyof typeof EXPERIMENT_CLI_OPTIONS)[]),
            'credential-env' as const,
          ]
        : []),
    ];
    assertAllowedOptions(parsed.values, allowed);
    if (command === 'run') {
      running = true;
      return await runPublicExperiment(argv, options, engine, stdout, stderr);
    }

    const cwd = path.resolve(options.cwd ?? process.cwd());
    const experimentPath = resolveRequiredPath(
      parsed.values.experiment,
      'experiment',
      cwd,
    );
    if (
      parsed.values.case !== undefined &&
      parsed.values['case-file'] !== undefined
    ) {
      throw new CliUsageError('--case and --case-file cannot be combined.');
    }
    const caseFilePath = resolveOptionalPath(
      parsed.values['case-file'],
      'case-file',
      cwd,
    );
    const experiment = await engine.loadExperimentConfig(experimentPath);
    if (experiment.config.dataset.path === undefined) {
      throw new CliUsageError(
        'The experiment must declare dataset.path, relative to the experiment file.',
      );
    }
    const dataset = await engine.loadDataset(
      path.resolve(experiment.root, experiment.config.dataset.path),
    );
    const nativeDocker =
      experiment.config.runtime.adapter === 'docker' &&
      experiment.config.runtime.platform === 'native';

    if (command === 'validate') {
      const selections = expandExperiment(experiment, dataset);
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
        )(options.signal === undefined ? {} : { signal: options.signal });
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
            ...(runtimePlatform === undefined ? {} : { runtimePlatform }),
          }),
        );
        const composition = await compositionFactory({
          datasetRoot: dataset.root,
          ...(plans[0] === undefined ? {} : { runtime: plans[0].runtime }),
          resultsRoot: path.resolve(cwd, DEFAULT_RESULTS_DIRECTORY),
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        });
        for (const plan of plans) {
          engine.preflightEval({ plan, composition });
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
                  : { signal: options.signal }),
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
          ...(host === undefined ? {} : { host }),
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
    const filters: SelectionFilters = {
      caseId,
      groupId: parsed.values.group,
      treatment: parsed.values.treatment,
      adapter: parsed.values.agent,
      provider: parsed.values.provider,
      model: parsed.values.model,
      repetition: parseRepetition(parsed.values.repetition),
    };
    const selection = selectOne(experiment.config, dataset, filters);
    const runtimePlatform = nativeDocker
      ? (options.runtimePlatform ??
        (await (options.detectDockerPlatform ?? detectDockerRuntimePlatform)(
          options.signal === undefined ? {} : { signal: options.signal },
        )))
      : undefined;
    const plan = engine.resolveRunPlan({
      dataset,
      experiment,
      selection,
      ...(runtimePlatform === undefined ? {} : { runtimePlatform }),
    });
    stdout(serializeResolvedRunPlan(plan));
    return 0;
  } catch (error) {
    stderr(`forge: ${errorMessage(error, running)}\n`);
    if (isUsageError(error)) stderr(`Run forge --help for usage.\n`);
    return isUsageError(error) ? 2 : 1;
  }
}

async function runPublicExperiment(
  argv: readonly string[],
  options: RunCliOptions,
  engine: ForgeEngine,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const result = await runExperimentCommand(argv, {
    hostOptions: HOST_CLI_OPTIONS,
    selectorOptions: SELECTOR_OPTIONS,
    allowPositionals: true,
    engine,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.runIdFactory === undefined
      ? {}
      : { runIdFactory: options.runIdFactory }),
    ...(options.experimentRunIdFactory === undefined
      ? {}
      : { experimentRunIdFactory: options.experimentRunIdFactory }),
    progress: (event) => stderr(serializeCanonicalJson(event)),
    validateHostArgs: ({ values }) => {
      resolveRequiredPath(
        values.experiment,
        'experiment',
        options.cwd ?? process.cwd(),
      );
      if (values.case !== undefined && values['case-file'] !== undefined) {
        throw new CliUsageError('--case and --case-file cannot be combined.');
      }
      parseRepetition(values.repetition);
      parseCredentialEnvironmentBindings(values['credential-env']);
    },
    loadExperiment: async ({ values, cwd, root, savedSelections, signal }) => {
      const experiment = await engine.loadExperimentConfig(
        resolveRequiredPath(values.experiment, 'experiment', cwd),
      );
      if (experiment.config.dataset.path === undefined) {
        throw new CliUsageError(
          'The experiment must declare dataset.path, relative to the experiment file.',
        );
      }
      const dataset = await engine.loadDataset(
        path.resolve(experiment.root, experiment.config.dataset.path),
      );
      let caseId = values.case;
      const caseFilePath = resolveOptionalPath(
        values['case-file'],
        'case-file',
        cwd,
      );
      if (caseFilePath !== undefined) {
        try {
          caseId = await resolveManifestCaseIdFromFile(dataset, caseFilePath);
        } catch (error) {
          if (error instanceof ManifestCaseFileError)
            throw new CliUsageError(error.message);
          throw error;
        }
      }
      if (savedSelections !== undefined)
        validateExperimentDataset(experiment, dataset);
      const selections =
        savedSelections ??
        selectMatching(experiment.config, dataset, {
          caseId,
          groupId: values.group,
          treatment: values.treatment,
          adapter: values.agent,
          provider: values.provider,
          model: values.model,
          repetition: parseRepetition(values.repetition),
        });
      const runtimePlatform =
        experiment.config.runtime.adapter === 'docker' &&
        experiment.config.runtime.platform === 'native'
          ? (options.runtimePlatform ??
            (await (
              options.detectDockerPlatform ?? detectDockerRuntimePlatform
            )({ signal })))
          : undefined;
      const plans = selections.map((selection) =>
        engine.resolveRunPlan({
          dataset,
          experiment,
          selection,
          ...(runtimePlatform === undefined ? {} : { runtimePlatform }),
        }),
      );
      const grants = parseCredentialEnvironmentBindings(
        values['credential-env'],
      );
      const credentials = createCliCredentialBindingSession(
        grants,
        options.environment ?? process.env,
      );
      const compositionOptions = {
        datasetRoot: dataset.root,
        runtime: plans[0]!.runtime,
        resultsRoot: root,
        credentialResolver: credentials.resolver,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
        ...(Object.keys(grants.references).length === 0
          ? {}
          : { credentialBindings: grants.references }),
      };
      const factory = options.compositionFactory ?? createDefaultCliComposition;
      const composition = await factory(compositionOptions);
      if (
        grants.environmentNames.length > 0 &&
        engine.inspectEvalCredentials === undefined
      ) {
        throw new CliUsageError(
          'Same-name credential grants require an engine with inspectEvalCredentials. Use explicit reference=HOST_VAR bindings with this engine.',
        );
      }
      credentials.finalize(
        plans.flatMap(
          (plan) =>
            engine.inspectEvalCredentials?.({ plan, composition }) ?? [],
        ),
      );
      const execute =
        options.execute ?? ((request) => engine.executeEval(request));
      return {
        plans,
        composition,
        execute: async (request) => {
          try {
            return await execute(request);
          } catch (error) {
            const diagnostic = credentialDiagnostic(error);
            if (diagnostic !== undefined) stderr(`forge: ${diagnostic}\n`);
            throw error;
          }
        },
      };
    },
  });
  const { outcomes: _outcomes, arguments: _arguments, ...summary } = result;
  stdout(serializeCanonicalJson(summary));
  return result.errored === 0 ? 0 : 1;
}

interface SelectionFilters {
  readonly groupId: string | undefined;
  readonly caseId: string | undefined;
  readonly treatment: string | undefined;
  readonly adapter: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly repetition: number | undefined;
}

function selectOne(
  experiment: ExperimentConfigV1,
  dataset: LoadedDatasetV1,
  filters: SelectionFilters,
): RunSelection {
  const matches = selectMatching(experiment, dataset, filters);
  if (matches.length > 1) {
    throw new CliUsageError(
      `Selection matches ${matches.length} matrix entries; add selection options.`,
    );
  }
  return matches[0]!;
}

function selectMatching(
  experiment: ExperimentConfigV1,
  dataset: LoadedDatasetV1,
  filters: SelectionFilters,
): RunSelection[] {
  if (
    filters.groupId !== undefined &&
    !getMatrixGroups(experiment.matrix).some(
      (group) => group.id === filters.groupId,
    )
  ) {
    throw new CliUsageError(`Unknown matrix group: ${filters.groupId}`);
  }
  const matches = expandExperiment(experiment, dataset).filter(
    (selection) =>
      (filters.groupId === undefined ||
        selection.group_id === filters.groupId) &&
      (filters.caseId === undefined || selection.case_id === filters.caseId) &&
      (filters.treatment === undefined ||
        selection.treatment === filters.treatment) &&
      (filters.adapter === undefined ||
        selection.agent.adapter === filters.adapter) &&
      (filters.provider === undefined ||
        selection.agent.provider === filters.provider) &&
      (filters.model === undefined ||
        selection.agent.model === filters.model) &&
      (filters.repetition === undefined ||
        selection.repetition === filters.repetition),
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
  const accepted = new Set<CliOptionName>([...allowed, 'help', 'version']);
  for (const option of Object.keys(values) as CliOptionName[]) {
    if (!accepted.has(option)) {
      throw new CliUsageError(`--${option} is not valid for this command.`);
    }
  }
}

interface CredentialEnvironmentGrants {
  readonly references: Readonly<Record<string, string>>;
  readonly environmentNames: readonly string[];
}

interface CredentialEnvironmentUseBinding extends EvalCredentialUse {
  readonly source: string;
}

function parseCredentialEnvironmentBindings(
  values: readonly string[] | undefined,
): CredentialEnvironmentGrants {
  const bindings = new Map<string, string>();
  const environmentNames = new Set<string>();
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    if (separator === -1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      environmentNames.add(value);
      continue;
    }
    const reference = separator < 1 ? '' : value.slice(0, separator);
    const environmentName = separator < 0 ? '' : value.slice(separator + 1);
    if (
      reference.length === 0 ||
      Buffer.byteLength(reference, 'utf8') > 1024 ||
      /[\u0000-\u001f\u007f]/.test(reference) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)
    ) {
      throw new CliUsageError(
        '--credential-env must be NAME or an opaque reference followed by =NAME, where NAME is a valid environment variable name.',
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
  return Object.freeze({
    references: Object.freeze(Object.fromEntries(bindings)),
    environmentNames: Object.freeze([...environmentNames]),
  });
}

function expandCredentialEnvironmentBindings(
  grants: CredentialEnvironmentGrants,
  uses: readonly EvalCredentialUse[],
): readonly CredentialEnvironmentUseBinding[] {
  const bindings: CredentialEnvironmentUseBinding[] = [];
  // Only actual selected declarations receive grants. Runtime uses include
  // custom setup actions; references reused by other purposes gain no access.
  for (const use of uses) {
    const name =
      use.environmentName ?? CLI_CREDENTIAL_ENVIRONMENTS.get(use.reference);
    if (name !== undefined && grants.environmentNames.includes(name)) {
      if (
        Object.hasOwn(grants.references, use.reference) &&
        grants.references[use.reference] !== name
      ) {
        throw new CliUsageError(
          `Credential reference ${JSON.stringify(use.reference)} has conflicting environment bindings.`,
        );
      }
      bindings.push(Object.freeze({ ...use, source: name }));
    }
  }
  return Object.freeze(bindings);
}

class CliCredentialError extends Error {}

// Only CLI-owned handles accept default-composition configuration. Keep the
// resolver identity stable for factories that capture it in execution closures.
const configureCliCredentialBindings = new WeakMap<
  CredentialResolver,
  (
    bindings: Readonly<Record<string, string>>,
    environment: Readonly<Record<string, string | undefined>>,
  ) => void
>();

function createCliCredentialBindingSession(
  grants: CredentialEnvironmentGrants,
  environment: Readonly<Record<string, string | undefined>>,
): {
  readonly resolver: CredentialResolver;
  finalize(uses: readonly EvalCredentialUse[]): void;
} {
  let references = grants.references;
  let selectedEnvironment = environment;
  let provisional = createCliCredentialResolver(
    references,
    selectedEnvironment,
  );
  let configured = false;
  let finalized: CredentialResolver | undefined;
  const resolver: CredentialResolver = Object.freeze({
    sourceIdentity(reference, context) {
      return (finalized ?? provisional).sourceIdentity?.(reference, context);
    },
    async resolve(reference, context) {
      context.signal.throwIfAborted();
      if (finalized === undefined) {
        throw new CliCredentialError(
          'Credential lookup is unavailable during composition construction. Forge binds selected requirements before execution.',
        );
      }
      return finalized.resolve(reference, context);
    },
  } satisfies CredentialResolver);
  configureCliCredentialBindings.set(resolver, (bindings, environment) => {
    if (configured) {
      if (
        environment !== selectedEnvironment ||
        Object.keys(bindings).length !== Object.keys(references).length ||
        Object.entries(bindings).some(
          ([reference, source]) =>
            !Object.hasOwn(references, reference) ||
            references[reference] !== source,
        )
      ) {
        throw new CliUsageError(
          'A CLI credential resolver cannot use conflicting composition configurations.',
        );
      }
      return;
    }
    if (finalized !== undefined) {
      throw new Error('Credential bindings have already been finalized.');
    }
    provisional = createCliCredentialResolver(bindings, environment);
    references = bindings;
    selectedEnvironment = environment;
    configured = true;
  });
  return {
    resolver,
    finalize(uses) {
      if (finalized !== undefined) {
        throw new Error('Credential bindings have already been finalized.');
      }
      finalized = createCliCredentialResolver(
        references,
        selectedEnvironment,
        expandCredentialEnvironmentBindings({ ...grants, references }, uses),
      );
    },
  };
}

function credentialEnvironmentName(reference: string): string | undefined {
  return (
    CLI_CREDENTIAL_ENVIRONMENTS.get(reference) ??
    (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)
      ? reference.slice(4)
      : undefined)
  );
}

function createCliCredentialResolver(
  bindings: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>,
  uses: readonly CredentialEnvironmentUseBinding[] = [],
): CredentialResolver {
  const resolver = createEnvironmentCredentialResolver({
    bindings,
    environment,
  });
  const scoped = new Map<
    string,
    Map<
      string,
      CredentialEnvironmentUseBinding & { resolver: CredentialResolver }
    >
  >();
  for (const use of uses) {
    let purposes = scoped.get(use.reference);
    if (purposes === undefined) {
      purposes = new Map();
      scoped.set(use.reference, purposes);
    }
    const previous = purposes.get(use.purpose);
    if (previous !== undefined) {
      if (
        previous.source !== use.source ||
        previous.environmentName !== use.environmentName
      ) {
        throw new CliUsageError(
          `Credential reference ${JSON.stringify(use.reference)} has conflicting environment bindings.`,
        );
      }
      continue;
    }
    purposes.set(use.purpose, {
      ...use,
      resolver: createEnvironmentCredentialResolver({
        bindings: { [use.reference]: use.source },
        environment,
      }),
    });
  }
  return {
    sourceIdentity(reference, context) {
      const source = resolver.sourceIdentity?.(reference, context);
      if (source !== undefined) return source;
      const use = scoped.get(reference)?.get(context.purpose);
      if (
        use !== undefined &&
        use.environmentName === context.environmentName
      ) {
        return use.source;
      }
      // Known aliases may be structurally compatible without granting access.
      // Execution always requires actual, explicitly authorized source IDs.
      if (
        context.phase === 'preflight' &&
        credentialEnvironmentName(reference) === context.environmentName
      ) {
        return context.environmentName;
      }
      return undefined;
    },
    async resolve(...args: Parameters<typeof resolver.resolve>) {
      const [reference, context] = args;
      context.signal.throwIfAborted();
      const shorthand =
        /^forge-eval:([A-Za-z_][A-Za-z0-9_]*)$/.exec(context.purpose)?.[1] ??
        CLI_CREDENTIAL_ENVIRONMENTS.get(reference);
      const name = shorthand ?? credentialEnvironmentName(reference);
      const binding = Object.hasOwn(bindings, reference)
        ? { source: bindings[reference]!, resolver }
        : scoped.get(reference)?.get(context.purpose);
      if (binding === undefined) {
        const grant = shorthand ?? `${reference}=${name ?? 'HOST_VARIABLE'}`;
        throw new CliCredentialError(
          `No environment binding exists for ${name ?? 'the requested credential'}. Add --credential-env ${grant}.`,
        );
      }
      try {
        return await binding.resolver.resolve(...args);
      } catch (error) {
        context.signal.throwIfAborted();
        // The environment resolver never includes values in its diagnostics.
        throw new CliCredentialError(
          `Set ${binding.source}: no value is available for ${name ?? 'the requested credential'}.`,
          { cause: error },
        );
      }
    },
  };
}

function credentialDiagnostic(
  error: unknown,
  running = true,
): string | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof CliCredentialError) return error.message;
    if (
      error instanceof ForgeExecutionError &&
      (error.code === 'invalid_plan' || error.code === 'credential_failed') &&
      error.phase === 'preflight' &&
      error.cause instanceof CredentialReferenceConflictError
    ) {
      const { environmentName } = error.cause;
      return running
        ? `Environment ${environmentName} has conflicting credential references. Authorize every declaration with the same host source, for example --credential-env ${environmentName}.`
        : `Environment ${environmentName} has conflicting credential references. Its declarations need a shared reference or host-supplied source compatibility metadata.`;
    }
    error = error.cause;
  }
  return undefined;
}

function isCommand(
  value: string | undefined,
): value is 'validate' | 'plan' | 'run' | 'regrade' {
  return (
    value === 'validate' ||
    value === 'plan' ||
    value === 'run' ||
    value === 'regrade'
  );
}

/** Judge a saved experiment run again into a separate output directory. */
async function runRegradeCommand(
  values: Readonly<
    Record<string, string | readonly string[] | boolean | undefined>
  >,
  options: RunCliOptions,
  engine: ForgeEngine,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0)
      throw new CliUsageError(`regrade requires --${name}.`);
    return value;
  };
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const experimentRun = path.resolve(cwd, required('experiment-run'));
  const output = path.resolve(cwd, required('output'));
  const judge = {
    provider: required('judge-provider'),
    model: required('judge-model'),
  };
  const jobsValue = values.jobs;
  const jobs = jobsValue === undefined ? 1 : Number(jobsValue);
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new CliUsageError('--jobs must be a positive safe integer.');
  const grants = parseCredentialEnvironmentBindings(
    values['credential-env'] as readonly string[] | undefined,
  );
  if (grants.environmentNames.length > 0) {
    throw new CliUsageError(
      'regrade accepts only --credential-env <reference>=<environment-name> bindings.',
    );
  }
  const compositionFactory =
    options.compositionFactory ?? createDefaultCliComposition;
  const composition = await compositionFactory({
    // Regrading reads only committed run artifacts; no dataset is loaded.
    datasetRoot: experimentRun,
    resultsRoot: output,
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    credentialBindings: grants.references,
  });
  if (composition.completionProviders === undefined)
    throw new CliUsageError('No completion providers are available to judge.');
  const summary = await regradeExperimentRun(
    {
      experimentRun,
      judge,
      output,
      jobs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      progress: (event) => stderr(`${JSON.stringify(event)}\n`),
    },
    {
      completionProviders: composition.completionProviders,
      credentialResolver: composition.credentialResolver,
      engine,
    },
  );
  stdout(`${JSON.stringify(summary)}\n`);
  return summary.failed.length === 0 ? 0 : 1;
}

function renderRegradeDiff(diff: RegradeDiff): string {
  const number = (value: number | null) =>
    value === null ? 'n/a' : String(value);
  const agreement = (value: RegradeDiff['agreement']) =>
    `${value.matched}/${value.total} (${value.rate === null ? 'n/a' : `${(100 * value.rate).toFixed(1)}%`})`;
  return [
    `Coverage: ${diff.coverage}`,
    `Verdict agreement: ${agreement(diff.agreement)}`,
    ...Object.entries(diff.agreement_by_requirement).map(
      ([level, value]) => `${level}: ${agreement(value)}`,
    ),
    `Mean score change (regrade - source): ${number(diff.mean_score_change)}`,
    ...diff.runs.map(
      (run) =>
        `${run.run_id}: ${number(run.source_score)} -> ${number(run.regrade_score)} (change ${number(run.score_change)}); status ${run.source_status} -> ${run.regrade_status}`,
    ),
    `Flipped criteria: ${diff.flipped_criteria.length}`,
    ...diff.flipped_criteria.map(
      (criterion) =>
        `${criterion.run_id} [${criterion.criterion_index}] ${criterion.requirement_level}: ${criterion.source_passed} -> ${criterion.regrade_passed}`,
    ),
    `Judge errors: ${diff.judge_errors.length}`,
    ...diff.judge_errors.map(
      (criterion) =>
        `${criterion.side} ${criterion.run_id} [${criterion.criterion_index}] ${criterion.requirement_level}: ${criterion.error.type} (${criterion.error.attempts} attempts)`,
    ),
    `Missing regrades: ${diff.missing_regrades.length}`,
    ...diff.missing_regrades,
    `Excluded records: ${diff.issues.length}`,
    ...diff.issues.map(
      (issue) =>
        `${issue.side} ${issue.run_id ?? `selection ${issue.selection_index ?? 'unknown'}`}: ${issue.state} (${issue.reason})`,
    ),
    `Runs without judging criteria: ${diff.not_judged.length}`,
    ...diff.not_judged,
    '',
  ].join('\n');
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function isUsageError(error: unknown): boolean {
  if (error instanceof ExperimentCommandError) return isUsageError(error.cause);
  return (
    error instanceof CliUsageError ||
    error instanceof ExperimentUsageError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('ERR_PARSE_ARGS'))
  );
}

function errorMessage(error: unknown, running: boolean): string {
  const diagnostic = credentialDiagnostic(error, running);
  if (diagnostic !== undefined) return diagnostic;
  const seen = new Set<unknown>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (
      cause instanceof AnthropicCompletionError &&
      cause.code === 'invalid_request' &&
      cause.message ===
        'Claude Fable is not supported yet as the judge or Ava model.'
    ) {
      return cause.message;
    }
    cause = cause.cause;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Unknown failure.';
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
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
  void runCli(process.argv.slice(2), { signal: controller.signal })
    .then(
      (exitCode) => {
        process.exitCode = exitCode;
      },
      () => {
        process.exitCode = 1;
      },
    )
    .finally(() => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    });
}
