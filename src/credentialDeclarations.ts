import {
  type CredentialReference,
  type CredentialResolutionContext,
  type CredentialResolver,
  type CredentialScope,
  type CredentialSourceContext,
  createEnvironmentResolver,
  normalizeScopedEnvironmentSpecification,
  type ResolvedCredentialEnvironmentBinding,
  type ResolvedEnvironment,
  type ScopedEnvironmentSpecification,
} from './contracts/credentials.ts';

/** Internal, lossless record retained through setup and runtime aggregation. */
export interface RuntimeCredentialDeclaration {
  readonly environmentName: string;
  readonly reference: CredentialReference;
  readonly scope: CredentialScope;
  readonly source: string;
  readonly setupStepIndex?: number;
}

/** Validate every group before the first authority-bearing lookup. */
export function validateCredentialDeclarations(
  declarations: readonly RuntimeCredentialDeclaration[],
  resolver: CredentialResolver | undefined,
  phase: CredentialSourceContext['phase'],
  purpose = 'forge-eval',
): void {
  for (const [environmentName, references] of credentialGroups(declarations)) {
    if (references.size < 2) continue;
    let source: string | undefined;
    for (const reference of references) {
      const identity: unknown = resolver?.sourceIdentity?.(reference, {
        environmentName,
        purpose: `${purpose}:${environmentName}`,
        phase,
      });
      if (identity instanceof Promise) void identity.catch(() => undefined);
      if (
        typeof identity !== 'string' ||
        identity.length === 0 ||
        (source !== undefined && source !== identity)
      ) {
        throw new TypeError(
          `Credential binding ${environmentName} has conflicting references without a proven shared source.`,
        );
      }
      source = identity;
    }
  }
}

/** Resolve each distinct original reference once for its runtime purpose. */
export async function resolveCredentialDeclarations(
  specification: ScopedEnvironmentSpecification,
  declarations: readonly RuntimeCredentialDeclaration[],
  resolver: CredentialResolver,
  context: CredentialResolutionContext,
): Promise<ResolvedEnvironment> {
  const normalized = normalizeScopedEnvironmentSpecification(specification);
  validateCredentialDeclarations(
    declarations,
    resolver,
    'execution',
    context.purpose,
  );
  const environmentResolver = createEnvironmentResolver(resolver);
  const credentials: Record<string, ResolvedCredentialEnvironmentBinding> = {};
  for (const [name, references] of credentialGroups(declarations)) {
    const binding = normalized.credentials[name]!;
    let selected: ResolvedCredentialEnvironmentBinding | undefined;
    for (const reference of references) {
      const resolved = await environmentResolver.resolve(
        { credentials: { [name]: { reference, scopes: binding.scopes } } },
        context,
      );
      const current = resolved.credentials[name]!;
      if (selected !== undefined && selected.value !== current.value) {
        throw new TypeError(
          `Credential resolver returned inconsistent values for shared source ${name}.`,
        );
      }
      selected = current;
    }
    Object.defineProperty(credentials, name, {
      enumerable: true,
      value: selected,
    });
  }
  return Object.freeze({
    variables: normalized.variables,
    credentials: Object.freeze(credentials),
  });
}

function credentialGroups(
  declarations: readonly RuntimeCredentialDeclaration[],
): ReadonlyMap<string, ReadonlySet<CredentialReference>> {
  const groups = new Map<string, Set<CredentialReference>>();
  for (const { environmentName, reference } of declarations) {
    let references = groups.get(environmentName);
    if (references === undefined) {
      references = new Set();
      groups.set(environmentName, references);
    }
    references.add(reference);
  }
  return groups;
}
