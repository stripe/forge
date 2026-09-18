const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CREDENTIAL_REFERENCE_BYTES = 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type CredentialReference = string & {
  readonly __credentialReference: unique symbol;
};

export type CredentialScope = 'setup' | 'agent';

export interface CredentialResolutionContext {
  readonly runId: string;
  readonly purpose: string;
  readonly signal: AbortSignal;
}

/** A host-owned secret lookup. References are opaque to Forge. */
export interface CredentialResolver {
  resolve(
    reference: CredentialReference,
    context: CredentialResolutionContext,
  ): Promise<string>;
}

/** An opaque secret requirement declared by an agent or setup handler. */
export interface CredentialRequirement {
  readonly reference: CredentialReference;
}

/** A requirement after Forge assigns authority from its declaration source. */
export interface CredentialEnvironmentBinding extends CredentialRequirement {
  /** Secrets are exposed only to commands in these runtime scopes. */
  readonly scopes: readonly CredentialScope[];
}

/** Environment requirements declared by one runtime capability. */
export interface EnvironmentSpecification {
  readonly variables?: Readonly<Record<string, string>>;
  readonly credentials?: Readonly<Record<string, CredentialRequirement>>;
}

export interface NormalizedEnvironmentSpecification {
  readonly variables: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, CredentialRequirement>>;
}

/** Environment requirements after Forge assigns setup or agent scope. */
export interface ScopedEnvironmentSpecification {
  readonly variables?: Readonly<Record<string, string>>;
  readonly credentials?: Readonly<Record<string, CredentialEnvironmentBinding>>;
}

export interface NormalizedScopedEnvironmentSpecification {
  readonly variables: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, CredentialEnvironmentBinding>>;
}

export interface ResolvedCredentialEnvironmentBinding {
  readonly value: string;
  readonly scopes: readonly CredentialScope[];
}

/** Plain and secret values remain separated all the way into a runtime. */
export interface ResolvedEnvironment {
  readonly variables: Readonly<Record<string, string>>;
  readonly credentials: Readonly<
    Record<string, ResolvedCredentialEnvironmentBinding>
  >;
}

export interface EnvironmentResolver {
  resolve(
    specification: ScopedEnvironmentSpecification,
    context: CredentialResolutionContext,
  ): Promise<ResolvedEnvironment>;
}

/** Purely validate, clone, and freeze one capability's raw declaration. */
export function normalizeEnvironmentSpecification(
  specification: unknown,
): NormalizedEnvironmentSpecification {
  assertPlainRecord(specification, 'Environment specification');
  assertExactKeys(
    specification,
    ['variables', 'credentials'],
    'Environment specification',
  );
  const variables = Object.freeze(
    validatePlainVariables(
      Object.hasOwn(specification, 'variables')
        ? specification.variables
        : {},
    ),
  );
  const credentialEntries = validateCredentialRequirements(
    Object.hasOwn(specification, 'credentials')
      ? specification.credentials
      : {},
    variables,
  );
  const credentials: Record<string, CredentialRequirement> = {};
  for (const {name, reference} of credentialEntries) {
    defineRecordValue(
      credentials,
      name,
      Object.freeze({reference}),
    );
  }
  return Object.freeze({
    variables,
    credentials: Object.freeze(credentials),
  });
}

/**
 * Resolves only explicitly declared credential bindings. Forge never copies
 * the ambient process environment into a sandbox.
 */
export function createEnvironmentResolver(
  credentialResolver: CredentialResolver,
): EnvironmentResolver {
  return {
    async resolve(specification, context) {
      const normalized = normalizeScopedEnvironmentSpecification(specification);
      const credentials: Record<string, ResolvedCredentialEnvironmentBinding> =
        {};

      // Every binding is validated above before the first authority-bearing
      // credential lookup occurs.
      for (const [name, {reference, scopes}] of Object.entries(
        normalized.credentials,
      )) {
        throwIfAborted(context.signal);
        const value = await credentialResolver.resolve(reference, {
          ...context,
          purpose: `${context.purpose}:${name}`,
        });
        throwIfAborted(context.signal);
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          /[\0\r\n]/.test(value)
        ) {
          throw new TypeError(`Credential resolver returned an invalid value for ${name}.`);
        }
        defineRecordValue(credentials, name, Object.freeze({value, scopes}));
      }

      return Object.freeze({
        variables: normalized.variables,
        credentials: Object.freeze(credentials),
      });
    },
  };
}

/**
 * Purely validate, clone, and freeze a scoped environment before any
 * credential lookup or runtime allocation.
 */
export function normalizeScopedEnvironmentSpecification(
  specification: unknown,
): NormalizedScopedEnvironmentSpecification {
  assertPlainRecord(specification, 'Scoped environment specification');
  assertExactKeys(
    specification,
    ['variables', 'credentials'],
    'Scoped environment specification',
  );
  const variables = Object.freeze(
    validatePlainVariables(
      Object.hasOwn(specification, 'variables')
        ? specification.variables
        : {},
    ),
  );
  const credentialEntries = validateCredentialBindings(
    Object.hasOwn(specification, 'credentials')
      ? specification.credentials
      : {},
    variables,
  );
  const credentials: Record<string, CredentialEnvironmentBinding> = {};
  for (const {name, reference, scopes} of credentialEntries) {
    defineRecordValue(
      credentials,
      name,
      Object.freeze({reference, scopes}),
    );
  }
  return Object.freeze({
    variables,
    credentials: Object.freeze(credentials),
  });
}

export interface EnvironmentCredentialResolverOptions {
  /** Opaque Forge reference to host variable name. No implicit fallback. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Injectable for tests and non-process hosts. Defaults to process.env. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Public CLI resolver for credentials explicitly mapped to environment names. */
export function createEnvironmentCredentialResolver(
  options: EnvironmentCredentialResolverOptions,
): CredentialResolver {
  const environment = options.environment ?? process.env;
  const bindings = new Map<string, string>();
  for (const [reference, name] of Object.entries(options.bindings)) {
    credentialReference(reference);
    assertEnvironmentName(name);
    bindings.set(reference, name);
  }

  return {
    async resolve(reference, context) {
      throwIfAborted(context.signal);
      const name = bindings.get(reference);
      if (!name) {
        throw new Error(
          `No environment binding exists for credential reference ${JSON.stringify(reference)}.`,
        );
      }
      const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        /[\0\r\n]/.test(value)
      ) {
        throw new Error(
          `No value is available for credential reference ${JSON.stringify(reference)}.`,
        );
      }
      return value;
    },
  };
}

export function credentialReference(reference: string): CredentialReference {
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    Buffer.byteLength(reference, 'utf8') > MAX_CREDENTIAL_REFERENCE_BYTES ||
    CONTROL_CHARACTER.test(reference)
  ) {
    throw new TypeError(
      `Credential references must be bounded non-empty strings without control characters.`,
    );
  }
  return reference as CredentialReference;
}

function validatePlainVariables(
  input: unknown,
): Record<string, string> {
  assertPlainRecord(input, 'Environment variables');
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    assertEnvironmentName(name);
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
      throw new TypeError(`Environment variable ${name} has an invalid value.`);
    }
    defineRecordValue(output, name, value);
  }
  return output;
}

function validateCredentialRequirements(
  input: unknown,
  variables: Readonly<Record<string, string>>,
): readonly Readonly<{
  name: string;
  reference: CredentialReference;
}>[] {
  assertPlainRecord(input, 'Credential requirements');
  const output: Array<{
    name: string;
    reference: CredentialReference;
  }> = [];
  for (const [name, binding] of Object.entries(input)) {
    assertEnvironmentName(name);
    if (Object.hasOwn(variables, name)) {
      throw new TypeError(
        `Environment variable ${name} cannot be both plain and credential-backed.`,
      );
    }
    assertPlainRecord(binding, `Credential requirement ${name}`);
    assertExactKeys(binding, ['reference'], `Credential requirement ${name}`);
    if (typeof binding.reference !== 'string') {
      throw new TypeError(`Credential requirement ${name} is invalid.`);
    }
    output.push(
      Object.freeze({
        name,
        reference: credentialReference(binding.reference),
      }),
    );
  }
  return Object.freeze(output);
}

function validateCredentialBindings(
  input: unknown,
  variables: Readonly<Record<string, string>>,
): readonly Readonly<{
  name: string;
  reference: CredentialReference;
  scopes: readonly CredentialScope[];
}>[] {
  assertPlainRecord(input, 'Credential bindings');
  const output: Array<{
    name: string;
    reference: CredentialReference;
    scopes: readonly CredentialScope[];
  }> = [];
  for (const [name, binding] of Object.entries(input)) {
    assertEnvironmentName(name);
    if (Object.hasOwn(variables, name)) {
      throw new TypeError(
        `Environment variable ${name} cannot be both plain and credential-backed.`,
      );
    }
    assertPlainRecord(binding, `Credential binding ${name}`);
    assertExactKeys(
      binding,
      ['reference', 'scopes'],
      `Credential binding ${name}`,
    );
    if (typeof binding.reference !== 'string') {
      throw new TypeError(`Credential binding ${name} is invalid.`);
    }
    const reference = credentialReference(binding.reference);
    output.push(
      Object.freeze({
        name,
        reference,
        scopes: normalizeScopes(binding.scopes, name),
      }),
    );
  }
  return Object.freeze(output);
}

function normalizeScopes(
  input: unknown,
  name: string,
): readonly CredentialScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(`Credential binding ${name} must declare at least one scope.`);
  }
  const scopes = [...new Set(input)];
  if (scopes.some((scope) => scope !== 'setup' && scope !== 'agent')) {
    throw new TypeError(`Credential binding ${name} contains an invalid scope.`);
  }
  return Object.freeze(
    (['setup', 'agent'] as const).filter((scope) => scopes.includes(scope)),
  );
}

function assertPlainRecord(
  input: unknown,
  label: string,
): asserts input is Record<PropertyKey, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function assertExactKeys(
  input: Record<PropertyKey, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (
    Reflect.ownKeys(input).some(
      (key) => typeof key !== 'string' || !allowedKeys.has(key),
    )
  ) {
    throw new TypeError(`${label} contains unknown fields.`);
  }
}

function defineRecordValue<T>(
  record: Record<string, T>,
  name: string,
  value: T,
): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function assertEnvironmentName(name: string): void {
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new TypeError(`Invalid environment variable name: ${name}`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
}
