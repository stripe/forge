import type {
  ForgeDockerRuntimeV1,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  ResolvedRunPlanV1,
  RunSelection,
} from '../../model/types.ts';

export interface PlanRunInput {
  readonly dataset: LoadedDatasetV1;
  readonly experiment: LoadedExperimentConfigV1;
  readonly selection: RunSelection;
  readonly runtimePlatform?: ForgeDockerRuntimeV1['platform'];
}

/** Resolve one experiment selection into a validated run plan. */
export interface PlanRun {
  plan(input: PlanRunInput): ResolvedRunPlanV1;
}
