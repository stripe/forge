import { inspectEvalCredentialsWithSetupActions } from '../../execution/execute.ts';
import type { SetupActionRegistry } from '../../setup/registry.ts';
import type { InspectRunCredentials } from './inspectRunCredentials.ts';

export interface InspectRunCredentialsDependencies {
  readonly setupActions: SetupActionRegistry;
}

export const createInspectRunCredentials = ({
  setupActions,
}: InspectRunCredentialsDependencies): InspectRunCredentials => ({
  inspect: (input) =>
    inspectEvalCredentialsWithSetupActions(input, setupActions),
});
