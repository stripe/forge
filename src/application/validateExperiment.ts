import type { ForgeComposition } from '../contracts/composition.ts';
import type { RuntimePlatform } from '../contracts/runtime.ts';
import type { PreflightEvalInput } from '../execution/execute.ts';
import type {
  DatasetIdentityV1,
  ExperimentConfigV1,
  ForgeRuntimeV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  ResolvedRunPlanV1,
} from '../model/types.ts';
import { expandExperiment } from '../planning/planner.ts';
import type { PlanRunInput } from './planRun.ts';

/** Builds the composition for plans that share one resolved runtime. */
export type ComposeForRuntime = (
  runtime: ForgeRuntimeV1 | undefined,
) => Promise<ForgeComposition>;

export interface ValidateExperimentInput {
  readonly experiment: LoadedExperimentConfigV1;
  readonly dataset: LoadedDatasetV1;
  /** Validate each plan once per platform; empty uses the experiment's own runtime. */
  readonly runtimePlatforms: readonly RuntimePlatform[];
  readonly compose: ComposeForRuntime;
}

export type ExperimentIdentity = Pick<ExperimentConfigV1, 'id' | 'version'>;

export interface ExperimentValidation {
  readonly dataset: DatasetIdentityV1;
  readonly experiment: ExperimentIdentity;
  readonly run_count: number;
  readonly valid: true;
}

/** The engine operations every selection's plan goes through. */
export interface PlanValidationOperations {
  resolveRunPlan(input: PlanRunInput): ResolvedRunPlanV1;
  preflightEval(request: PreflightEvalInput): void;
}

const platformsToResolve = (
  platforms: readonly RuntimePlatform[],
): readonly (RuntimePlatform | undefined)[] =>
  platforms.length === 0 ? [undefined] : platforms;

/** Plans and preflights every selection without credentials, providers or a runtime. */
export const validateExperiment = async (
  input: ValidateExperimentInput,
  operations: PlanValidationOperations,
): Promise<ExperimentValidation> => {
  const selections = expandExperiment(input.experiment, input.dataset);
  for (const runtimePlatform of platformsToResolve(input.runtimePlatforms)) {
    const plans = selections.map((selection) =>
      operations.resolveRunPlan({
        dataset: input.dataset,
        experiment: input.experiment,
        selection,
        ...(runtimePlatform === undefined ? {} : { runtimePlatform }),
      }),
    );
    const composition = await input.compose(plans[0]?.runtime);
    for (const plan of plans) operations.preflightEval({ plan, composition });
  }
  return {
    dataset: input.dataset.manifest.dataset,
    experiment: {
      id: input.experiment.config.id,
      version: input.experiment.config.version,
    },
    run_count: selections.length,
    valid: true,
  };
};
