import { createPlanRun } from './application/planRun/createPlanRun.ts';
import type {
  EvalCredentialUse,
  ExecuteEvalInput,
  PreflightEvalInput,
} from './execution/execute.ts';
import {
  executeEvalWithSetupActions,
  inspectEvalCredentialsWithSetupActions,
  preflightEvalWithSetupActions,
} from './execution/execute.ts';
import {
  loadDatasetWithSetupActions,
  loadExperimentConfigWithSetupActions,
} from './model/loaders.ts';
import {
  parseEvalCaseWithSetupActions,
  parseEvalCaseYamlWithSetupActions,
  parseExperimentConfigWithSetupActions,
  parseExperimentConfigYamlWithSetupActions,
  parseResolvedRunPlanWithSetupActions,
  parseSetupStepWithSetupActions,
} from './model/parse.ts';
import type {
  EvalCaseV1,
  ExperimentConfigV1,
  ForgeDockerRuntimeV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  ResolvedRunPlanV1,
  RunSelection,
  SetupActionBundleReferenceV1,
  SetupStepV1,
} from './model/types.ts';
import { verifyCompletedRunWithPlanParser } from './results/localStore.ts';
import type { CompletedRun, CompletedRunV1 } from './results/types.ts';
import {
  createSetupActionRegistry,
  type SetupActionBundle,
} from './setup/registry.ts';

export interface ForgeEngineOptions {
  /** Trusted, build-time action implementations imported by the embedding host. */
  readonly setupActionBundles?: readonly SetupActionBundle[];
}

/** One immutable action registry shared across every model and execution boundary. */
export interface ForgeEngine {
  readonly setupActionBundles: readonly SetupActionBundleReferenceV1[];
  readonly setupActionIds: readonly string[];
  parseEvalCase(value: unknown): EvalCaseV1;
  parseEvalCaseYaml(source: string): EvalCaseV1;
  parseExperimentConfig(value: unknown): ExperimentConfigV1;
  parseExperimentConfigYaml(source: string): ExperimentConfigV1;
  parseResolvedRunPlan(value: unknown): ResolvedRunPlanV1;
  parseSetupStep(value: unknown): SetupStepV1;
  loadDataset(datasetRoot: string): Promise<LoadedDatasetV1>;
  loadExperimentConfig(
    experimentPath: string,
  ): Promise<LoadedExperimentConfigV1>;
  resolveRunPlan(input: {
    readonly dataset: LoadedDatasetV1;
    readonly experiment: LoadedExperimentConfigV1;
    readonly selection: RunSelection;
    readonly runtimePlatform?: ForgeDockerRuntimeV1['platform'];
  }): ResolvedRunPlanV1;
  preflightEval(request: PreflightEvalInput): void;
  /** Pure selected-consumer inventory; defers only credential-source proof. */
  inspectEvalCredentials?(
    request: PreflightEvalInput,
  ): readonly EvalCredentialUse[];
  executeEval(request: ExecuteEvalInput): Promise<CompletedRunV1>;
  verifyCompletedRun(location: string): Promise<CompletedRun>;
}

/**
 * Construct an engine which snapshots setup semantics once for its full lifecycle.
 * YAML never identifies code to import; callers supply trusted bundles directly.
 */
export function createForgeEngine(
  options: ForgeEngineOptions = {},
): ForgeEngine {
  const setupActions = createSetupActionRegistry(
    options.setupActionBundles ?? [],
  );
  const planRun = createPlanRun({ setupActions });
  const engine: ForgeEngine = {
    setupActionBundles: setupActions.actionBundles,
    setupActionIds: setupActions.actionIds,
    parseEvalCase(value) {
      return parseEvalCaseWithSetupActions(value, setupActions);
    },
    parseEvalCaseYaml(source) {
      return parseEvalCaseYamlWithSetupActions(source, setupActions);
    },
    parseExperimentConfig(value) {
      return parseExperimentConfigWithSetupActions(value, setupActions);
    },
    parseExperimentConfigYaml(source) {
      return parseExperimentConfigYamlWithSetupActions(source, setupActions);
    },
    parseResolvedRunPlan(value) {
      return parseResolvedRunPlanWithSetupActions(value, setupActions);
    },
    parseSetupStep(value) {
      return parseSetupStepWithSetupActions(value, setupActions);
    },
    loadDataset(datasetRoot) {
      return loadDatasetWithSetupActions(datasetRoot, setupActions);
    },
    loadExperimentConfig(experimentPath) {
      return loadExperimentConfigWithSetupActions(experimentPath, setupActions);
    },
    resolveRunPlan: (input) => planRun.plan(input),
    preflightEval(request) {
      preflightEvalWithSetupActions(request, setupActions);
    },
    inspectEvalCredentials(request) {
      return inspectEvalCredentialsWithSetupActions(request, setupActions);
    },
    executeEval(request) {
      return executeEvalWithSetupActions(request, setupActions);
    },
    verifyCompletedRun(location) {
      return verifyCompletedRunWithPlanParser(location, (value) =>
        parseResolvedRunPlanWithSetupActions(value, setupActions),
      );
    },
  };
  return Object.freeze(engine);
}

/** Built-in-only engine used by the public CLI and top-level convenience APIs. */
export const defaultForgeEngine: ForgeEngine = createForgeEngine();
