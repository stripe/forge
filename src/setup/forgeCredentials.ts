import { credentialReference } from '../contracts/credentials.ts';
import type { CredentialsSetupStepV1, SetupStepV1 } from '../model/types.ts';
import type { PreparedSetupStep, SetupStepHandler } from './types.ts';

/** Declare agent secrets without reading host values or mutating the workspace. */
export const credentialsSetupHandler: SetupStepHandler = Object.freeze({
  uses: 'forge/credentials',
  preflight(step: SetupStepV1): PreparedSetupStep {
    if (step.uses !== 'forge/credentials') {
      throw new TypeError(
        `forge/credentials cannot handle ${JSON.stringify(step.uses)}.`,
      );
    }
    const credentialsStep = step as CredentialsSetupStepV1;
    return Object.freeze({
      requirements: Object.freeze({
        credentials: {
          agent: Object.fromEntries(
            credentialsStep.with.env.map((name) => [
              name,
              { reference: credentialReference(`env:${name}`) },
            ]),
          ),
        },
      }),
      // Credential resolution happens before runtime preparation, not in setup.
      async apply() {},
    });
  },
});
