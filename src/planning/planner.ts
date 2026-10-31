import { sha256Digest } from '../model/hashes.ts';
import {
  DEFAULT_DECISION_JUDGE_MODE,
  judgeMethodOf,
} from '../model/judgeMethod.ts';
import {
  ancestorDirectories,
  assertDatasetSetupInputs,
  indexLoadedDatasetCases,
} from '../model/loaders.ts';
import { agentSelectionKey, getMatrixGroups } from '../model/matrix.ts';
import {
  type AgentSelectionV1,
  type CaseId,
  type DatasetRelativePath,
  DEFAULT_EVALUATION_TIMEOUT_MS,
  DEFAULT_MAX_TURNS,
  type ExperimentConfigV1,
  type ExperimentMatrixGroupV1,
  type ForgeDockerRuntimeV1,
  type JudgeModelRefV1,
  type LoadedDatasetV1,
  type LoadedExperimentConfigV1,
  type ModelRefV1,
  type ResolvedRunPlanV1,
  type RunSelection,
} from '../model/types.ts';
import {
  defaultSetupActionRegistry,
  type SetupActionRegistry,
} from '../setup/registry.ts';
import { FORGE_BUILD_IDENTITY } from '../version.ts';

const DEFAULT_HOST_MODEL: Readonly<ModelRefV1> = Object.freeze({
  provider: 'openai',
  model: 'gpt-6.1-sol',
});

export type PlanningErrorCode =
  | 'dataset_experiment_mismatch'
  | 'unknown_case'
  | 'unknown_treatment'
  | 'unknown_agent'
  | 'invalid_selection'
  | 'invalid_repetition'
  | 'missing_role_player'
  | 'missing_judge'
  | 'invalid_loaded_dataset'
  | 'invalid_dataset_input'
  | 'action_bundle_mismatch'
  | 'missing_runtime_platform';

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;

  constructor(
    code: PlanningErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlanningError';
    this.code = code;
  }
}

/** @internal Validate the complete authored inventory without expanding selections. */
export function validateExperimentDataset(
  input: ExperimentConfigV1 | LoadedExperimentConfigV1,
  dataset: LoadedDatasetV1,
): void {
  assertDatasetCompatibility(dataset, 'config' in input ? input.config : input);
}

/**
 * Expand in stable authored order: group, case, treatment, agent, repetition.
 * Manifest-listed case paths resolve to their stable case IDs in selections.
 * Retries deliberately do not create new semantic selections.
 */
export function expandExperiment(
  input: ExperimentConfigV1 | LoadedExperimentConfigV1,
  dataset: LoadedDatasetV1,
): RunSelection[] {
  const config = 'config' in input ? input.config : input;
  const caseIdsByPath = assertDatasetCompatibility(dataset, config);
  const selections: RunSelection[] = [];
  for (const group of getMatrixGroups(config.matrix)) {
    for (const casePath of group.cases) {
      const caseId = caseIdsByPath.get(casePath)!;
      for (const treatment of group.treatments) {
        for (const agent of group.agents) {
          for (
            let repetition = 0;
            repetition < config.matrix.repetitions;
            repetition += 1
          ) {
            selections.push({
              ...(group.id === undefined ? {} : { group_id: group.id }),
              case_id: caseId,
              treatment,
              agent: resolveAgentSelection(agent),
              repetition,
            });
          }
        }
      }
    }
  }
  return selections;
}

/** Resolve one validated selection into the complete, ambient-free run plan. */
export function resolveRunPlan(input: {
  dataset: LoadedDatasetV1;
  experiment: LoadedExperimentConfigV1;
  selection: RunSelection;
  runtimePlatform?: ForgeDockerRuntimeV1['platform'];
}): ResolvedRunPlanV1 {
  return resolveRunPlanWithSetupActions(input, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function resolveRunPlanWithSetupActions(
  input: {
    dataset: LoadedDatasetV1;
    experiment: LoadedExperimentConfigV1;
    selection: RunSelection;
    runtimePlatform?: ForgeDockerRuntimeV1['platform'];
  },
  setupActions: SetupActionRegistry,
): ResolvedRunPlanV1 {
  const { dataset, selection } = input;
  const config = input.experiment.config;
  const caseIdsByPath = assertDatasetCompatibility(dataset, config);
  const casePath = [...caseIdsByPath].find(
    ([, id]) => id === selection.case_id,
  )?.[0];
  const group = assertSelection(config, selection, casePath);

  const loadedCase = dataset.cases.get(selection.case_id);
  if (!loadedCase) {
    throw new PlanningError(
      'unknown_case',
      'Run selection references a case absent from the loaded dataset.',
    );
  }
  if (casePath === undefined) {
    throw new PlanningError(
      'unknown_case',
      'Run selection references a case absent from the dataset manifest.',
    );
  }

  const treatment =
    config.treatments[selection.treatment] ??
    (selection.treatment === 'baseline' ? { setup: [] } : undefined);
  if (!treatment) {
    throw new PlanningError(
      'unknown_treatment',
      'Run selection references an undefined treatment.',
    );
  }
  const definition = loadedCase.definition;

  const setup = [...cloneJson(definition.setup), ...cloneJson(treatment.setup)];
  try {
    assertDatasetSetupInputs(
      setup,
      ancestorDirectories(dataset.manifest.cases.map(({ path }) => path)),
      dataset.inputPaths,
      'Selected setup',
    );
  } catch (error) {
    throw new PlanningError(
      'invalid_dataset_input',
      error instanceof Error ? error.message : 'Invalid setup dataset source.',
      { cause: error },
    );
  }
  const configuredActionBundles = config.forge?.action_bundles ?? [];
  try {
    setupActions.assertStepsDeclared(setup, configuredActionBundles);
  } catch (error) {
    throw new PlanningError(
      'action_bundle_mismatch',
      'Selected setup actions do not match the experiment action bundle pins.',
      { cause: error },
    );
  }
  const requiredActionBundles = setupActions.requiredActionBundles(setup);

  const initialPromptSource =
    definition.initial_prompt === undefined
      ? ('case.task' as const)
      : ('case.initial_prompt' as const);
  const effectivePrompt = definition.initial_prompt ?? definition.task;
  if (effectivePrompt === undefined) {
    // Public parsers prevent this; retain a defensive execution boundary.
    throw new PlanningError(
      'unknown_case',
      'Selected case has no effective prompt.',
    );
  }

  const plan: ResolvedRunPlanV1 = {
    selection: {
      ...cloneJson(selection),
      ...(group.id === undefined ? {} : { group_id: group.id }),
      agent: resolveAgentSelection(selection.agent),
    },
    provenance: {
      dataset: cloneJson(dataset.manifest.dataset),
      experiment: {
        id: config.id,
        version: config.version,
      },
      case: {
        id: definition.id,
        path: casePath,
      },
      forge: {
        ...FORGE_BUILD_IDENTITY,
        ...(requiredActionBundles.length === 0
          ? {}
          : { action_bundles: cloneJson([...requiredActionBundles]) }),
      },
    },
    case: cloneJson(definition),
    treatment: {
      id: selection.treatment,
      setup: cloneJson(treatment.setup),
    },
    setup,
    interaction: {
      mode: definition.execution_mode,
      ...(definition.task === undefined ? {} : { task: definition.task }),
      ...(definition.context === undefined
        ? {}
        : { context: definition.context }),
      ...(definition.initial_prompt === undefined
        ? {}
        : { initial_prompt: definition.initial_prompt }),
      initial_prompt_source: initialPromptSource,
      effective_prompt: effectivePrompt,
      max_turns:
        definition.execution_mode === 'one_shot'
          ? 1
          : (definition.max_turns ?? DEFAULT_MAX_TURNS),
    },
    evaluation: {
      judging_criteria: cloneJson(definition.judging_criteria),
      ...(definition.checks === undefined
        ? {}
        : { checks: cloneJson(definition.checks) }),
      ...(definition.example_answer === undefined
        ? {}
        : { example_answer: definition.example_answer }),
      ...(definition.judging_criteria.length === 0
        ? {}
        : { judge: planJudge(config.models.judge ?? DEFAULT_HOST_MODEL) }),
    },
    ...(definition.execution_mode !== 'multi_turn'
      ? {}
      : {
          role_player: cloneJson(
            config.models.role_player ?? DEFAULT_HOST_MODEL,
          ),
        }),
    agent: resolveAgentSelection(selection.agent),
    runtime: resolveRuntime(config.runtime, input.runtimePlatform),
    limits: {
      ...cloneJson(config.limits),
      evaluation_timeout_ms:
        config.limits.evaluation_timeout_ms ?? DEFAULT_EVALUATION_TIMEOUT_MS,
    },
  };
  return deepFreeze(plan);
}

function resolveRuntime(
  runtime: ExperimentConfigV1['runtime'],
  runtimePlatform: ForgeDockerRuntimeV1['platform'] | undefined,
): ResolvedRunPlanV1['runtime'] {
  if (runtime.adapter !== 'docker' || runtime.platform !== 'native') {
    return cloneJson(runtime) as ResolvedRunPlanV1['runtime'];
  }
  if (runtimePlatform === undefined) {
    throw new PlanningError(
      'missing_runtime_platform',
      'A native Docker experiment requires a concrete runtimePlatform during plan resolution.',
    );
  }
  if (runtimePlatform !== 'linux/amd64' && runtimePlatform !== 'linux/arm64') {
    throw new PlanningError(
      'missing_runtime_platform',
      'runtimePlatform must be linux/amd64 or linux/arm64.',
    );
  }
  return cloneJson({ ...runtime, platform: runtimePlatform });
}

/** Canonical JSON used when a caller needs a stable resolved-plan digest. */
export function serializeResolvedRunPlan(plan: ResolvedRunPlanV1): string {
  return `${JSON.stringify(sortJson(plan))}\n`;
}

export function resolvedRunPlanSha256(
  plan: ResolvedRunPlanV1,
): `sha256:${string}` {
  return sha256Digest(serializeResolvedRunPlan(plan));
}

function assertDatasetCompatibility(
  dataset: LoadedDatasetV1,
  config: ExperimentConfigV1,
): ReadonlyMap<DatasetRelativePath, CaseId> {
  let caseIdsByPath: ReadonlyMap<DatasetRelativePath, CaseId>;
  try {
    caseIdsByPath = new Map(
      [...indexLoadedDatasetCases(dataset)].map(([casePath, loadedCase]) => [
        casePath,
        loadedCase.definition.id,
      ]),
    );
  } catch (error) {
    throw new PlanningError(
      'invalid_loaded_dataset',
      'The loaded dataset case index does not match its authored definitions and manifest.',
      { cause: error },
    );
  }
  if (
    dataset.manifest.dataset.id !== config.dataset.id ||
    dataset.manifest.dataset.version !== config.dataset.version
  ) {
    throw new PlanningError(
      'dataset_experiment_mismatch',
      'Loaded dataset does not match the experiment config pin.',
    );
  }
  for (const group of getMatrixGroups(config.matrix)) {
    for (const casePath of group.cases) {
      const caseId = caseIdsByPath.get(casePath);
      if (caseId === undefined) {
        throw new PlanningError(
          'unknown_case',
          'Experiment config references a case file absent from the loaded dataset manifest.',
        );
      }
    }
  }
  return caseIdsByPath;
}

function assertSelection(
  config: ExperimentConfigV1,
  selection: RunSelection,
  casePath: DatasetRelativePath | undefined,
): ExperimentMatrixGroupV1 {
  const groups = getMatrixGroups(config.matrix);
  if (
    casePath === undefined ||
    !groups.some((group) => group.cases.includes(casePath))
  ) {
    throw new PlanningError(
      'unknown_case',
      'Run selection case is not in the benchmark matrix.',
    );
  }
  if (!groups.some((group) => group.treatments.includes(selection.treatment))) {
    throw new PlanningError(
      'unknown_treatment',
      'Run selection treatment is not in the benchmark matrix.',
    );
  }
  if (
    !groups.some((group) =>
      group.agents.some((agent) => agentsEqual(agent, selection.agent)),
    )
  ) {
    throw new PlanningError(
      'unknown_agent',
      'Run selection agent is not in the benchmark matrix.',
    );
  }
  if (
    !Number.isSafeInteger(selection.repetition) ||
    selection.repetition < 0 ||
    selection.repetition >= config.matrix.repetitions
  ) {
    throw new PlanningError(
      'invalid_repetition',
      'Run selection repetition is outside the benchmark matrix.',
    );
  }
  const group = groups.find(
    (group) =>
      group.cases.includes(casePath) &&
      group.treatments.includes(selection.treatment) &&
      group.agents.some((agent) => agentsEqual(agent, selection.agent)),
  );
  if (group === undefined) {
    throw new PlanningError(
      'invalid_selection',
      'Run selection does not belong to a single benchmark matrix group.',
    );
  }
  if (selection.group_id !== undefined && selection.group_id !== group.id) {
    throw new PlanningError(
      'invalid_selection',
      'Run selection group ID does not match its benchmark matrix group.',
    );
  }
  return group;
}

function agentsEqual(left: AgentSelectionV1, right: AgentSelectionV1): boolean {
  return agentSelectionKey(left) === agentSelectionKey(right);
}

function resolveAgentSelection(agent: AgentSelectionV1): AgentSelectionV1 {
  return {
    ...cloneJson(agent),
    ...(agent.adapter === 'codex'
      ? { hook_trust: agent.hook_trust ?? 'native' }
      : {}),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The planned judge. The default method is omitted so plans that do not set
 * one keep their identity; verbalized sampling records its candidate count.
 */
function planJudge(judge: JudgeModelRefV1): JudgeModelRefV1 {
  const method = judgeMethodOf(judge);
  return {
    provider: judge.provider,
    model: judge.model,
    ...(method.mode === DEFAULT_DECISION_JUDGE_MODE
      ? {}
      : { mode: method.mode }),
    ...(method.candidates === undefined
      ? {}
      : { candidates: method.candidates }),
  };
}
