import type {
  CredentialResolver,
  ResolvedEnvironment,
  ScopedEnvironmentSpecification,
} from '../../../contracts/credentials.ts';
import {
  type RuntimeCredentialDeclaration,
  resolveCredentialDeclarations,
} from '../../../credentialDeclarations.ts';
import { executionError } from '../../../execution/errors.ts';

export interface ResolveEnvironmentInput {
  readonly runId: string;
  readonly specification: ScopedEnvironmentSpecification;
  readonly declarations: readonly RuntimeCredentialDeclaration[];
  readonly credentialResolver: CredentialResolver;
  readonly signal: AbortSignal;
}

export const resolveEnvironment = async (
  input: ResolveEnvironmentInput,
): Promise<ResolvedEnvironment> => {
  try {
    return await resolveCredentialDeclarations(
      input.specification,
      input.declarations,
      input.credentialResolver,
      { runId: input.runId, purpose: 'forge-eval', signal: input.signal },
    );
  } catch (error) {
    throw executionError(
      'credential_failed',
      'preflight',
      'Forge could not resolve the credentials required by this run.',
      error,
    );
  }
};
