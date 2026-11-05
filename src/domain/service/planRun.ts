import { parseResolvedRunPlanWithSetupActions } from '../../model/parse.ts';
import { resolveRunPlanWithSetupActions } from '../../planning/planner.ts';
import type { SetupActionRegistry } from '../../setup/registry.ts';
import type { PlanRun } from '../contract/usecase/planRun.ts';

export interface PlanRunDependencies {
  readonly setupActions: SetupActionRegistry;
}

export const createPlanRun = ({
  setupActions,
}: PlanRunDependencies): PlanRun => ({
  plan: (input) =>
    parseResolvedRunPlanWithSetupActions(
      resolveRunPlanWithSetupActions(input, setupActions),
      setupActions,
    ),
});
