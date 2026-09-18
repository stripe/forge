import {
  isSafeActionIdentifier,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from '../model/paths.js';
import {isSha256Digest} from '../model/hashes.js';
import type {
  JsonObject,
  SetupActionBundleReferenceV1,
  SetupStepV1,
} from '../model/types.js';
import {builtInSetupActions} from './builtins.js';
import type {
  SetupPreflightContext,
  PreparedSetupStep,
} from './types.js';

const RESERVED_NAMESPACES = new Set(['forge', 'stripe']);
const MAX_ACTION_BUNDLES = 100;
const MAX_ACTIONS_PER_BUNDLE = 1_000;

/** One versioned setup action supplied by Forge or an explicitly imported bundle. */
export interface SetupActionDefinition<
  TWith extends JsonObject = JsonObject,
> {
  readonly uses: string;
  /** Purely normalize `with` to a canonical fixed point accepted unchanged. */
  parseWith(input: unknown): TWith;
  /** Purely declare requirements and bind the later apply operation. */
  preflight(
    step: SetupStepV1<TWith>,
    context: SetupPreflightContext,
  ): PreparedSetupStep;
}

/** Trusted host code owning one non-reserved setup-action namespace. */
export interface SetupActionBundle {
  readonly manifest: SetupActionBundleReferenceV1;
  readonly actions: readonly SetupActionDefinition[];
}

export interface SetupActionRegistry {
  /** Registered extension manifests in stable namespace order. */
  readonly actionBundles: readonly SetupActionBundleReferenceV1[];
  /** Registered action IDs in stable lexical order. */
  readonly actionIds: readonly string[];
  action(uses: string): SetupActionDefinition | undefined;
  actionBundle(uses: string): SetupActionBundleReferenceV1 | undefined;
  requiredActionBundles(
    steps: readonly SetupStepV1[],
  ): readonly SetupActionBundleReferenceV1[];
  assertReferencesMatch(
    references: readonly SetupActionBundleReferenceV1[],
  ): void;
  assertStepsDeclared(
    steps: readonly SetupStepV1[],
    references: readonly SetupActionBundleReferenceV1[],
  ): void;
  assertExactReferences(
    steps: readonly SetupStepV1[],
    references: readonly SetupActionBundleReferenceV1[],
  ): void;
}

/** Validate and snapshot one bundle before it enters an engine registry. */
export function defineSetupActionBundle(
  input: SetupActionBundle,
): SetupActionBundle {
  if (!isPlainRecord(input)) {
    throw new TypeError('Setup action bundle must be an object.');
  }
  assertExactKeys(input, ['manifest', 'actions'], 'Setup action bundle');
  const manifest = normalizeBundleReference(input.manifest);
  if (RESERVED_NAMESPACES.has(manifest.namespace)) {
    throw new TypeError(
      `Setup action bundle cannot own reserved namespace ${JSON.stringify(manifest.namespace)}.`,
    );
  }
  if (
    !Array.isArray(input.actions) ||
    input.actions.length === 0 ||
    input.actions.length > MAX_ACTIONS_PER_BUNDLE
  ) {
    throw new TypeError('Setup action bundle must contain a bounded non-empty action list.');
  }
  const seen = new Set<string>();
  const actions = Array.from(input.actions, (action) => {
    const normalized = normalizeActionDefinition(action);
    if (actionNamespace(normalized.uses) !== manifest.namespace) {
      throw new TypeError(
        `Setup action ${JSON.stringify(normalized.uses)} is outside bundle namespace ${JSON.stringify(manifest.namespace)}.`,
      );
    }
    if (seen.has(normalized.uses)) {
      throw new TypeError(`Duplicate setup action: ${JSON.stringify(normalized.uses)}.`);
    }
    seen.add(normalized.uses);
    return normalized;
  });
  return Object.freeze({manifest, actions: Object.freeze(actions)});
}

/** Build the immutable built-in registry plus explicitly imported host bundles. */
export function createSetupActionRegistry(
  actionBundles: readonly SetupActionBundle[] = [],
): SetupActionRegistry {
  if (!Array.isArray(actionBundles) || actionBundles.length > MAX_ACTION_BUNDLES) {
    throw new TypeError('Setup action bundles must be a bounded array.');
  }

  const actions = new Map<
    string,
    Readonly<{
      definition: SetupActionDefinition;
      bundle?: SetupActionBundleReferenceV1;
    }>
  >();
  for (const action of builtInSetupActions) {
    const definition = normalizeActionDefinition(action);
    if (!RESERVED_NAMESPACES.has(actionNamespace(definition.uses))) {
      throw new TypeError(
        `Built-in setup action must use a reserved namespace: ${JSON.stringify(definition.uses)}.`,
      );
    }
    if (actions.has(definition.uses)) {
      throw new TypeError(
        `Duplicate built-in setup action: ${JSON.stringify(definition.uses)}.`,
      );
    }
    actions.set(definition.uses, Object.freeze({definition}));
  }

  const bundles = new Map<string, SetupActionBundleReferenceV1>();
  for (const input of actionBundles) {
    const bundle = defineSetupActionBundle(input);
    const namespace = bundle.manifest.namespace;
    if (bundles.has(namespace)) {
      throw new TypeError(
        `Duplicate setup action bundle namespace: ${JSON.stringify(namespace)}.`,
      );
    }
    bundles.set(namespace, bundle.manifest);
    for (const definition of bundle.actions) {
      if (actions.has(definition.uses)) {
        throw new TypeError(`Duplicate setup action: ${JSON.stringify(definition.uses)}.`);
      }
      actions.set(
        definition.uses,
        Object.freeze({definition, bundle: bundle.manifest}),
      );
    }
  }

  const manifests = Object.freeze(
    [...bundles.values()].sort((left, right) =>
      compareCodeUnits(left.namespace, right.namespace),
    ),
  );
  const actionIds = Object.freeze([...actions.keys()].sort(compareCodeUnits));
  const registry: SetupActionRegistry = {
    actionBundles: manifests,
    actionIds,
    action(uses) {
      return actions.get(uses)?.definition;
    },
    actionBundle(uses) {
      return actions.get(uses)?.bundle;
    },
    requiredActionBundles(steps) {
      const required = new Map<string, SetupActionBundleReferenceV1>();
      for (const step of steps) {
        const registered = actions.get(step.uses);
        if (!registered) {
          throw new TypeError(
            `Unknown setup action: ${JSON.stringify(step.uses)}.`,
          );
        }
        const bundle = registered.bundle;
        if (bundle) required.set(bundle.namespace, bundle);
      }
      return Object.freeze(
        [...required.values()].sort((left, right) =>
          compareCodeUnits(left.namespace, right.namespace),
        ),
      );
    },
    assertReferencesMatch(references) {
      const normalized = normalizeBundleReferences(references);
      for (const reference of normalized) {
        const registered = bundles.get(reference.namespace);
        if (!registered || !bundleReferencesEqual(reference, registered)) {
          throw new TypeError(
            `Setup action bundle ${JSON.stringify(reference.namespace)} does not match the registered implementation.`,
          );
        }
      }
    },
    assertStepsDeclared(steps, references) {
      const declared = referenceMap(references);
      registry.assertReferencesMatch(references);
      for (const reference of registry.requiredActionBundles(steps)) {
        const pinned = declared.get(reference.namespace);
        if (!pinned || !bundleReferencesEqual(reference, pinned)) {
          throw new TypeError(
            `Setup action namespace ${JSON.stringify(reference.namespace)} is not pinned by the experiment.`,
          );
        }
      }
    },
    assertExactReferences(steps, references) {
      const normalized = normalizeBundleReferences(references);
      if (
        references.some(
          (reference, index) =>
            !bundleReferencesEqual(reference, normalized[index]),
        )
      ) {
        throw new TypeError(
          'Resolved plan action bundle references must be in canonical namespace order.',
        );
      }
      registry.assertReferencesMatch(normalized);
      const required = registry.requiredActionBundles(steps);
      if (
        normalized.length !== required.length ||
        normalized.some(
          (reference, index) =>
            required[index] === undefined ||
            !bundleReferencesEqual(reference, required[index]),
        )
      ) {
        throw new TypeError(
          'Resolved plan action bundle references do not exactly match its setup actions.',
        );
      }
    },
  };
  return Object.freeze(registry);
}

export const defaultSetupActionRegistry = createSetupActionRegistry();

export function actionNamespace(uses: string): string {
  if (!isSafeActionIdentifier(uses)) {
    throw new TypeError('Setup action ID must be namespaced and positively versioned.');
  }
  return uses.slice(0, uses.indexOf('/'));
}

function normalizeActionDefinition(input: unknown): SetupActionDefinition {
  if (!isPlainRecord(input)) {
    throw new TypeError('Setup action definition must be an object.');
  }
  assertExactKeys(
    input,
    ['uses', 'parseWith', 'preflight'],
    'Setup action definition',
  );
  if (
    typeof input.uses !== 'string' ||
    !isSafeActionIdentifier(input.uses) ||
    typeof input.parseWith !== 'function' ||
    typeof input.preflight !== 'function'
  ) {
    throw new TypeError('Setup action definition is invalid.');
  }
  return Object.freeze({
    uses: input.uses,
    parseWith: input.parseWith as SetupActionDefinition['parseWith'],
    preflight: input.preflight as SetupActionDefinition['preflight'],
  });
}

function normalizeBundleReferences(
  input: readonly SetupActionBundleReferenceV1[],
): readonly SetupActionBundleReferenceV1[] {
  if (!Array.isArray(input) || input.length > MAX_ACTION_BUNDLES) {
    throw new TypeError('Setup action bundle references must be a bounded array.');
  }
  const seen = new Set<string>();
  const output = Array.from(input, (reference) => {
    const normalized = normalizeBundleReference(reference);
    if (seen.has(normalized.namespace)) {
      throw new TypeError(
        `Duplicate setup action bundle namespace: ${JSON.stringify(normalized.namespace)}.`,
      );
    }
    seen.add(normalized.namespace);
    return normalized;
  });
  return Object.freeze(
    output.sort((left, right) => compareCodeUnits(left.namespace, right.namespace)),
  );
}

function normalizeBundleReference(input: unknown): SetupActionBundleReferenceV1 {
  if (!isPlainRecord(input)) {
    throw new TypeError('Setup action bundle manifest must be an object.');
  }
  assertExactKeys(
    input,
    ['namespace', 'version', 'sha256'],
    'Setup action bundle manifest',
  );
  if (
    typeof input.namespace !== 'string' ||
    !isSafeSimpleIdentifier(input.namespace) ||
    typeof input.version !== 'string' ||
    !isSafeVersion(input.version) ||
    typeof input.sha256 !== 'string' ||
    !isSha256Digest(input.sha256)
  ) {
    throw new TypeError('Setup action bundle manifest is invalid.');
  }
  return Object.freeze({
    namespace: input.namespace,
    version: input.version,
    sha256: input.sha256,
  });
}

function referenceMap(
  references: readonly SetupActionBundleReferenceV1[],
): ReadonlyMap<string, SetupActionBundleReferenceV1> {
  return new Map(
    normalizeBundleReferences(references).map((reference) => [
      reference.namespace,
      reference,
    ]),
  );
}

function bundleReferencesEqual(
  left: SetupActionBundleReferenceV1,
  right: SetupActionBundleReferenceV1 | undefined,
): boolean {
  return (
    right !== undefined &&
    left.namespace === right.namespace &&
    left.version === right.version &&
    left.sha256 === right.sha256
  );
}

function assertExactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  if (
    Reflect.ownKeys(input).some(
      (key) => typeof key !== 'string' || !allowed.has(key),
    )
  ) {
    throw new TypeError(`${label} contains an unknown field.`);
  }
  if (expected.some((key) => !Object.hasOwn(input, key))) {
    throw new TypeError(`${label} is missing a required field.`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
