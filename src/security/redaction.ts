export const REDACTED_SECRET = '[REDACTED]';

export interface RedactionResult<T> {
  readonly value: T;
  readonly replacements: number;
}

/** Replace exact resolved credential values throughout a JSON-compatible value. */
export function redactSecrets<T>(
  value: T,
  secrets: readonly string[],
): RedactionResult<T> {
  const normalizedSecrets = normalizeSecrets(secrets);
  let replacements = 0;

  const redactString = (input: string): string => {
    let output = input;
    for (const secret of normalizedSecrets) {
      if (!output.includes(secret)) continue;
      const pieces = output.split(secret);
      replacements += pieces.length - 1;
      output = pieces.join(REDACTED_SECRET);
    }
    return output;
  };

  const visit = (input: unknown, seen: Set<object>): unknown => {
    if (typeof input === 'string') return redactString(input);
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'number'
    ) {
      return input;
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new TypeError('Cannot redact a cyclic value.');
      seen.add(input);
      const output = input.map((item) => visit(item, seen));
      seen.delete(input);
      return output;
    }
    if (typeof input === 'object' && input !== null) {
      if (seen.has(input)) throw new TypeError('Cannot redact a cyclic value.');
      seen.add(input);
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(input)) {
        const redactedKey = redactString(key);
        if (Object.hasOwn(output, redactedKey)) {
          throw new TypeError(
            'Secret redaction produced duplicate object keys.',
          );
        }
        Object.defineProperty(output, redactedKey, {
          configurable: true,
          enumerable: true,
          value: visit(child, seen),
          writable: true,
        });
      }
      seen.delete(input);
      return output;
    }
    throw new TypeError(
      'Secret redaction accepts only JSON-compatible values.',
    );
  };

  return { value: visit(value, new Set()) as T, replacements };
}

/** Fail closed when a logical JSON value contains a resolved credential. */
export function assertNoSecretsInJsonValue(
  value: unknown,
  secrets: readonly string[],
  label: string,
): void {
  if (redactSecrets(value, secrets).replacements > 0) {
    throw new SecretLeakError(label);
  }
}

/** Fail closed before canonical bytes containing a resolved credential are staged. */
export function assertNoSecrets(
  body: string | Uint8Array,
  secrets: readonly string[],
  label: string,
): void {
  const text =
    typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  if (normalizeSecrets(secrets).some((secret) => text.includes(secret))) {
    throw new SecretLeakError(label);
  }
}

export class SecretLeakError extends Error {
  readonly code = 'secret_leak_detected' as const;

  constructor(readonly artifact: string) {
    super(
      `Refusing to persist ${artifact} because it contains a resolved credential.`,
    );
    this.name = 'SecretLeakError';
  }
}

function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}
