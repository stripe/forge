import { redactSecrets } from './redaction.ts';

export const MAX_ERROR_MESSAGE_CHARACTERS = 4096;

/** Retain only a bounded Error.message, never arbitrary thrown data or a stack. */
export function boundedErrorMessage(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): string {
  const message =
    error instanceof Error && typeof error.message === 'string'
      ? error.message
      : fallback;
  // Redact before truncating: a credential may cross the truncation boundary.
  const safe = redactSecrets(message, secrets).value.trim();
  if (safe.length === 0) return fallback;
  return safe.length <= MAX_ERROR_MESSAGE_CHARACTERS
    ? safe
    : `${safe.slice(0, MAX_ERROR_MESSAGE_CHARACTERS - 1)}…`;
}
