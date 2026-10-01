# Setup action bundles

## Purpose

A setup action bundle lets an embedding host add trusted setup semantics
without adding host-specific names or implementations to the public Forge
package.

Bundles are explicit host dependencies, not plugins discovered at runtime. Host
code imports a bundle and supplies it when constructing an immutable
`ForgeEngine`. Benchmark YAML names only the setup action; it never names a
JavaScript package to download or import.

Use a bundle when an action belongs to an embedding environment rather than to
portable Forge. Built-in actions such as `forge/write`, `forge/command`, and
`forge/plugin` continue to ship with the installed Forge version.

## Defining and registering a bundle

```js check
import {
  createForgeEngine,
  defineSetupActionBundle,
} from '@stripe/forge';

const tools = defineSetupActionBundle({
  manifest: {
    namespace: 'acme-evals',
    version: '1.0.0',
    sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  actions: [{
    uses: 'acme-evals/tool',
    parseWith(input) {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        typeof input.name !== 'string'
      ) {
        throw new TypeError('invalid tool');
      }
      return {name: input.name};
    },
    preflight(step) {
      return {
        requirements: {executables: ['install-tool']},
        async apply(context) {
          const result = await context.commands.run([
            'install-tool',
            step.with.name,
          ], {signal: context.signal});
          if (result.exitCode !== 0) throw new Error('tool installation failed');
        },
      };
    },
  }],
});

const engine = createForgeEngine({setupActionBundles: [tools]});
```

The manifest identifies the bundle's semantic owner and exact implementation:

- `namespace` owns every action in the bundle;
- `version` identifies the implementation release; and
- `sha256` is an implementation digest supplied by the host's build or
  packaging system.

Forge cannot derive a trustworthy digest from an already-running JavaScript
function. The embedding host is responsible for generating the digest from an
immutable action artifact and pinning that artifact in its dependency graph.

The `forge` and `stripe` namespaces are currently reserved by the installed
package. Extension bundles must use another namespace, and no bundle can
replace a built-in action or another bundle's action.

## Action contract

Each action contains:

- a namespaced, unversioned `uses` identifier such as `acme-evals/tool`;
- `parseWith(input)`, which strictly validates and normalizes the JSON-shaped
  `with` payload; and
- `preflight(step, context)`, which declares requirements and binds the exact
  operation that will later run.

The action ID has no `@version` suffix. The bundle manifest's version and
digest identify its implementation; incompatible action changes require an
updated bundle pin and affected benchmark inputs.

`parseWith` must produce a canonical fixed point: parsing its output again must
return the same JSON value. Forge proves that property for authored input. At
resolved-plan, execution, and verification boundaries, Forge rejects a payload
that the parser would transform instead of silently changing it.

`preflight` is pure. It must not resolve credentials, inspect ambient state,
allocate resources, run commands, or mutate a workspace. Its prepared `apply`
operation runs later with lifecycle-scoped capabilities.

An `apply` operation may return bounded, non-sensitive JSON describing a value
resolved during execution. Forge records that resolution under the action's
ordered entry in `setup.json`.

## Experiment and plan provenance

An experiment that may select a bundled action pins the matching manifest:

```yaml
forge:
  action_bundles:
    - namespace: acme-evals
      version: 1.0.0
      sha256: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The `forge` block is omitted when no host action bundle is used. A configured
reference must exactly match the bundle registered on the engine. Missing
bundles, digest mismatches, undeclared namespaces, unknown actions, and
noncanonical payloads fail before credentials are resolved or a runtime is
allocated.

A resolved plan records only the extension bundles used by that selection.
`result.json` repeats those identities, while canonical `plan.json` remains the
authoritative execution input.

The same engine registry is used for parsing, planning, preflight, execution,
and completed-result verification. This prevents a plan from being interpreted
with one action implementation and executed or verified with another.

## Authority and security

Bundle implementations are trusted host code executing in the Forge process;
Forge does not sandbox their JavaScript. It validates their declared
integration boundaries, but bundle authors remain responsible for keeping the
implementation within them:

- YAML cannot select code to import.
- Bundle identity is explicit, pinned, and plan-visible.
- Bundle definitions are snapshotted when the engine is constructed; normalized
  action inputs are cloned and frozen at their parsing boundaries.
- Forge cannot freeze mutable state captured inside action functions; keeping
  those closures stable is the embedding host's responsibility.
- Requirements pass through Forge's conflict and credential-scope validation.
- Each operation receives only its declared state directories and setup
  credentials; credential-free operations receive an uncredentialed command
  runner.
- Dataset access, workspace paths, command execution, and returned resolutions
  remain subject to the same bounds as built-in actions.
- Bundle authors must turn local resources into immutable, digestible inputs
  before execution and must not select an ambient host path or service silently
  during `apply`; Forge cannot enforce this inside arbitrary trusted JavaScript.

The stock CLI uses the built-in-only engine and rejects bundled actions. An
embedding CLI must provide the same extended engine consistently for parsing,
planning, execution, and verification.
