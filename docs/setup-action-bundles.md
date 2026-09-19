# Setup action bundles

## Summary

Forge supports public built-in setup actions and explicitly supplied action
bundles. A bundle lets an embedding host define setup semantics without adding
host names or implementations to the public Forge package.

Bundles are build-time dependencies. A benchmark document never tells Forge to
download or discover executable code. The host imports trusted bundle code,
constructs one immutable `ForgeEngine`, and uses that engine for parsing,
planning, validation, execution, and result verification.

A bundle is a JavaScript object, not a required package boundary. Its module may
be colocated with an embedding CLI or eval runner, or it may live in a separate
package when ownership and reuse justify one. That organization is invisible to
benchmark YAML and to public Forge.

The standard Forge engine contains only actions shipped by the installed
`@stripe/forge` version. It rejects every extension action.

## Goals

- Let an embedding host define several long-lived setup actions through public
  contracts.
- Keep private action names, schemas, and implementations out of this
  repository and its default CLI.
- Bind every selected extension implementation into the resolved plan and run
  result.
- Preserve pure preflight, credential scoping, setup ordering, immutable plan
  inputs, and validation before authority.
- Ensure a plan cannot be parsed with one action implementation and executed
  silently with another.
- Keep published benchmarks portable by making extension dependencies explicit
  and mechanically rejectable by a release pipeline.

## Non-goals

- Dynamic package installation or discovery from YAML.
- Sandboxing action implementation code inside the Forge process. Bundles are
  trusted code selected by the embedding host.
- Allowing a bundle to replace a built-in action.
- Making a plan that depends on a private bundle executable by the stock public
  CLI.
- Treating source resolution, network routing, or ambient host paths as hidden
  action inputs.

## Namespaces and ownership

An extension bundle owns exactly one action namespace. For example, a bundle
whose namespace is `acme-evals` may define `acme-evals/skill@1` and
`acme-evals/tool@1`.

The `forge` and `stripe` namespaces are reserved for actions shipped by the
public Forge package. Extension bundles cannot register them. Two bundles
cannot own the same namespace, and no action ID can be registered twice.

The planned `stripe/cli@1` action will be a first-party public action implemented
in this repository. It is reserved here but is not executable yet. Private
hosts must use their own namespace for any interim CLI-specific action.

The `@N` suffix versions an action's wire semantics. The bundle version and
digest independently identify the exact implementation selected by the host.

## Bundle contract

A setup action bundle contains:

- a safe namespace;
- an implementation version;
- a `sha256:` implementation digest supplied by the host's build or packaging
  system; and
- one or more action definitions.

Each action definition contains:

- its exact versioned `uses` identifier;
- a pure `parseWith()` function which strictly validates and normalizes the
  JSON-shaped `with` payload, accepts its own canonical output, and returns that
  output unchanged on subsequent calls; and
- the existing pure `preflight()` and constrained `apply()` behavior.

After success, `apply()` may return a bounded JSON object describing values it
resolved only at execution time, such as an artifact commit or service binding.
Forge snapshots that non-sensitive object under the action's ordered entry in
`setup.json`. Returning no value records only the action index and `uses` ID.
The bundle owns the resolution object's semantics, while its pinned bundle
version and digest identify the implementation which produced it.

Forge snapshots and freezes the bundle registry when the engine is created.
Mutating a supplied manifest, action list, or definition property later cannot
change that registry. Action functions are trusted code, so their captured
state must also be treated as immutable by the embedding host.

Forge validates the digest's format and requires exact equality across the
registered bundle, experiment, plan, and result. It cannot derive a digest from
an already-running JavaScript function. The embedding build must generate or
verify this value from the immutable action artifact and pin that artifact in
its normal dependency graph.

## Configuration and plan provenance

An experiment config which may select extension actions pins their bundle
implementations:

```yaml
forge:
  version: 0.1.0
  action_bundles:
    - namespace: acme-evals
      version: 2026.9.0
      sha256: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The configured reference must exactly match the bundle registered on the
engine. Treatment actions must belong to a pinned bundle. Case actions receive
the same check when a selected case and treatment are resolved together.

The resolved plan records only extension bundles used by that run. A baseline
selection therefore does not inherit unrelated extension provenance merely
because another treatment in the experiment uses it. Selected references are
ordered lexically by namespace and omitted, rather than emitted as an empty
array, when the run uses no bundle.

`result.json` repeats the selected bundle identities under `forge`, while the
canonical `plan.json` and its digest remain authoritative.

## Engine lifecycle

`createForgeEngine({setupActionBundles})` constructs the only registry used by
that engine. Its methods cover:

1. case and experiment parsing and loading;
2. run-plan resolution and parsing;
3. authority-free composition preflight;
4. execution; and
5. completed-result verification.

Existing package-level functions remain built-in-only convenience APIs. The
public executable uses the built-in-only engine. An embedding CLI may pass an
extended engine explicitly; a composition supplies environment authority but
does not define action semantics.

## Parsing and validation

For an authored case or experiment, Forge first validates the common setup
envelope and bounded JSON payload. It then looks up the exact action and invokes
its pure parser. The parser output is validated again as bounded JSON, cloned,
and frozen. Forge reparses that output immediately and requires the same JSON
value, proving that normalization reached a stable canonical fixed point before
planning.

At a resolved-plan boundary, Forge invokes the parser only to validate the
stored canonical payload. If the returned value differs, the plan is rejected
as noncanonical; execution and result verification never accept a transformed
replacement. The plan displayed, hashed, executed, persisted, and verified
therefore has identical setup semantics.

Unknown actions, undeclared bundle namespaces, bundle reference mismatches,
malformed parser output, and unsupported implementations fail before
credential resolution or runtime allocation. The executor binds the already
selected action definition during preflight and never performs a second
registry lookup during apply.

## Security model

Action bundles execute trusted host code in the Forge process. Consequently:

- YAML cannot name a package to import.
- The host must import each bundle explicitly.
- Bundle implementations cannot use reserved namespaces or replace built-ins.
- Bundle identity is plan-visible and verified against the engine registry.
- `parseWith()` and `preflight()` must remain ambient-free and authority-free.
- `apply()` receives the same least-privileged workspace, input, and command
  projections as built-in actions.
- Credential declarations pass through Forge's strict normalization and scope
  assignment.
- Private or local resource bytes must become immutable, digestible plan inputs
  before execution; a bundle does not gain ambient filesystem authority.

## Public release boundary

A public release should project its source experiment into a new public
experiment, then parse and plan it with the stock built-in-only engine. It must
not redact an already-resolved private plan. Successful built-in-only planning
proves that no extension action or bundle provenance survived projection.

## Verification

Tests must prove:

- built-in behavior and the stock CLI remain unchanged;
- extension actions are rejected by the default engine;
- an extended engine parses, plans, preflights, and applies its actions;
- reserved namespaces, duplicate namespaces/actions, and malformed bundles are
  rejected at engine construction;
- configuration references must exactly match registered manifests;
- selected plans contain exactly their used bundle references;
- mismatched or missing bundles fail before credential resolution and runtime
  allocation;
- action payload parser output is cloned, frozen, bounded JSON;
- action normalization reaches a fixed point before planning;
- a noncanonical resolved-plan payload is rejected rather than rewritten;
- mutations to source bundle objects cannot affect a constructed engine;
- setup credentials retain per-action least-privilege projection; and
- action resolutions are bounded, immutable, ordered, and secret-scanned; and
- completed-result verification uses the same engine registry.

## Rollout

1. Add the generic bundle, registry, engine, and provenance contracts.
2. Move built-in actions behind the same internal registry representation.
3. Extend the implemented public plugin action and add `stripe/cli@1` as a
   built-in when its portable contract is ready.
4. Let embedding repositories define private action bundles alongside their
   existing integration code.
5. Require public release projection to succeed with the built-in-only engine.
