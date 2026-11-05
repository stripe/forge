import type {
  ForgeDockerRuntimeV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  RunSelection,
} from '../model/types.ts';

/** One matrix selection of a loaded experiment, to resolve into a run plan. */
export interface PlanRunInput {
  readonly dataset: LoadedDatasetV1;
  readonly experiment: LoadedExperimentConfigV1;
  readonly selection: RunSelection;
  readonly runtimePlatform?: ForgeDockerRuntimeV1['platform'];
}
