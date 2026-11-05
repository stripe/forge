import { preflightEvalWithSetupActions } from '../../execution/execute.ts';
import type { SetupActionRegistry } from '../../setup/registry.ts';
import type { ValidateRun } from './validateRun.ts';

export interface ValidateRunDependencies {
  readonly setupActions: SetupActionRegistry;
}

export const createValidateRun = ({
  setupActions,
}: ValidateRunDependencies): ValidateRun => ({
  validate: (input) => preflightEvalWithSetupActions(input, setupActions),
});
