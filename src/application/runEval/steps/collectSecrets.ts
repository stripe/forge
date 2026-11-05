import type { ResolvedEnvironment } from '../../../contracts/credentials.ts';
import type { PreparedCompletionRuntime } from '../../../execution/completionRuntime.ts';

export const credentialValues = (environment: ResolvedEnvironment): string[] =>
  Object.values(environment.credentials).map(({ value }) => value);

/** Every secret the run holds, for redaction and secret checks. */
export const collectSecrets = (
  environment: ResolvedEnvironment,
  completions: Pick<PreparedCompletionRuntime, 'secrets'>,
): string[] => [
  ...new Set([...credentialValues(environment), ...completions.secrets]),
];
