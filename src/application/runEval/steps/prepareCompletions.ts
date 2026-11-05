import type {
  CredentialResolver,
  ResolvedEnvironment,
} from '../../../contracts/credentials.ts';
import {
  type CompletionBinding,
  type PreparedCompletionRuntime,
  prepareCompletionRuntime,
} from '../../../execution/completionRuntime.ts';
import { executionError } from '../../../execution/errors.ts';
import { credentialValues } from './collectSecrets.ts';

export interface PrepareCompletionsInput {
  readonly runId: string;
  readonly bindings: readonly CompletionBinding[];
  readonly credentialResolver: CredentialResolver;
  readonly environment: ResolvedEnvironment;
  readonly signal: AbortSignal;
}

export const prepareCompletions = async (
  input: PrepareCompletionsInput,
): Promise<PreparedCompletionRuntime> => {
  try {
    return await prepareCompletionRuntime({
      runId: input.runId,
      bindings: input.bindings,
      credentialResolver: input.credentialResolver,
      redactionSecrets: credentialValues(input.environment),
      signal: input.signal,
    });
  } catch (error) {
    throw executionError(
      'credential_failed',
      'preflight',
      'Forge could not prepare the completion providers required by this run.',
      error,
    );
  }
};
