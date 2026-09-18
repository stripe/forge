# Agent-aware setup and credential contracts

## Summary

Forge needs to support setup actions whose realization may depend on the
selected coding agent or embedding host. Public plugin installation is the
initial agent-aware built-in use case. A host may also supply explicitly
imported, manifest-backed action bundles for semantics which do not belong in
the public package.

This design makes setup a two-stage operation:

1. Pure preflight validates every step, binds it to one exact implementation,
   and declares all required setup and agent credentials.
2. After Forge resolves those declarations and prepares the runtime, it applies
   the already-preflighted operations in source order.

The foundation covers prepared setup, credential lifecycle declarations, pure
payload parsing, built-in actions, versioned host action bundles, and explicit
CLI credential bindings. Concrete public actions follow as separate vertical
slices. Typed resource inputs and bundle-owned schemas let a host represent
non-public setup behavior without changing the shared lifecycle. Network
proxying remains a separate runtime concern.

## Motivation

The original setup contract has two limitations:

- A handler is looked up during preflight and again during execution, and its
  domain-specific validation normally happens only when it mutates the runtime.
- Every credential declared by a setup handler is automatically setup-scoped.

The second limitation cannot safely represent an authenticated MCP server or
Stripe CLI. Those steps configure a capability during setup, but the credential
must remain available while the coding agent later invokes that capability.
Writing the resolved value into a native config file would persist a secret;
copying ambient host variables into the runtime would be non-reproducible and
overbroad.

Agent-aware setup does not mean putting an agent selector into every treatment.
One action expresses portable semantics once; a selected adapter or a
host-owned action can realize its typed request without changing lifecycle
ordering.

## Design principles

- Forge owns validation, ordering, and the portable semantics of every built-in
  action. A host bundle owns the schema and semantics of its namespace.
- Agent adapters provide narrow native realization mechanisms; they do not own
  arbitrary `forge/*` handlers.
- All built-in actions are implemented in this public repository and available
  through the standard Forge CLI and programmatic engine.
- The action namespace identifies semantic ownership. The `forge` and `stripe`
  namespaces are reserved for built-ins shipped by this package.
- A host may explicitly import an action bundle when constructing an engine,
  but cannot register or replace built-in handlers.
- Environment-specific service and source selection uses typed, action-specific
  resolver contracts rather than an arbitrary handler registry.
- Network routing and proxying belong to the runtime boundary rather than an
  MCP action or binding resolver.
- Preflight is pure and completes for every step before Forge resolves the
  first credential or allocates a runtime.
- Experiment configs and resolved plans contain opaque credential references,
  never values or host environment names.
- Forge assigns credential scopes from explicit lifecycle declarations. A
  handler cannot attach raw scope metadata.
- The existing case-setup-before-treatment-setup order does not change.

## Action ownership

| Category | Examples | Schema owner | Mechanism owner |
| --- | --- | --- | --- |
| Generic built-in | `forge/write@1`, `forge/command@1`, `forge/plugin@1` | Forge | Forge or the selected adapter |
| Product built-in | Future public `stripe/*` actions | Forge repository action owner | Forge repository action owner |
| Host bundle | `acme-evals/skill@1`, `acme-evals/tool@1` | Explicitly imported bundle | Bundle, runtime, or selected adapter |

The executable first-party actions are `forge/write@1`, `forge/command@1`, and
`forge/plugin@1`. Command remains argv-based and does not add implicit shell
parsing. Plugin uses a narrow selected-adapter capability and setup-sealed
runtime state; its complete contract is documented in [Marketplace plugin
treatments](plugin-action.md). Other agent-aware actions need a concrete public
use case before becoming built-ins.

The default engine installs only the built-in registry. `ForgeComposition`
exposes no setup-handler registry. An embedding host instead supplies bundles
to `createForgeEngine`; the engine snapshots that registry before parsing and
uses it through result verification. Unknown action IDs fail engine validation,
and a host cannot replace a registered built-in handler. The exported built-in
registry remains an introspection view.

Bundles are imported by trusted host code. YAML never causes dynamic package
loading or action discovery. See [Setup action bundles](setup-action-bundles.md).

## Prepared setup contract

Each `SetupStepHandler.preflight()` call receives only ambient-free selection
and runtime information. It returns a `PreparedSetupStep` containing validated
requirements and the exact operation that will later apply. The executor
preflights all steps, aggregates their requirements, and returns one
`PreparedSetup`.

The prepared object captures the selected handlers and deep-frozen clones of
their normalized inputs in memory. Resolved plans are also deep-frozen at their
parse boundary before any handler, runtime, or agent adapter receives them.
Execution does not repeat handler lookup or requirement derivation. This
prevents composition or input mutation from causing a second interpretation of
the same wire payload after credentials have been resolved.

An action parser must produce a canonical fixed point: parsing its normalized
output must return the same JSON value. Forge proves this while parsing authored
configuration. At resolved-plan, execution, and verification boundaries it
rejects any payload the parser would transform, so revalidation cannot silently
change the plan or its digest.

The public requirement shape has three explicit concepts:

- `variables`: non-secret values which retain the existing behavior of being
  available to all runtime command projections.
- `credentials.setup`: opaque references exposed only through the setup command
  runner.
- `credentials.agent`: opaque references exposed only through the coding-agent
  command runner.

The top-level apply context includes uncredentialed and setup-scoped command
projections. For each prepared step, Forge exposes the setup projection only
when that step declared at least one setup credential, and that projection
contains exactly the environment names declared by that step. Otherwise the
operation receives the uncredentialed projection. This prevents both
`forge/command@1` and one credentialed installer from observing credentials
required only by another setup action. The per-step context also includes the
selected agent coordinates, runtime selection, step index, logical runtime
paths, run-owned workspace, input provider, and abort signal. It does not
contain credential values, the agent command runner, runtime cleanup authority,
or ambient host state.

## Credential aggregation

Forge combines credentials from three sources:

| Declaration | Assigned scope |
| --- | --- |
| `AgentAdapter.requirements().environment.credentials` | `agent` |
| Prepared setup `credentials.setup` | `setup` |
| Prepared setup `credentials.agent` | `agent` |

Aggregation is completed and validated before resolution:

- The same environment name and reference declared for both phases receives
  both scopes.
- The same environment name with different references is rejected.
- A plain variable and credential cannot share a name.
- Environment declarations and their nested collections must be plain objects;
  arrays, explicit `null`, unknown fields, and extra binding fields are rejected.
- Environment names and references must be valid and bounded.
- A handler-supplied `scopes` field is rejected.
- Resolved runtime values containing NUL, CR, or LF are rejected before runtime
  allocation because Docker's environment-file transport cannot represent
  them safely.

The complete merged environment is normalized during the same authority-free
preflight used by `forge validate`. Execution repeats validation defensively,
but cannot discover a new structural environment error after validation has
succeeded.

The runtime continues exposing three projections:

1. Uncredentialed agent preparation receives explicit non-secret variables.
2. Each setup action receives those variables and exactly its declared
   setup-scoped credentials.
3. Agent interaction receives those variables and agent-scoped credentials.

Within setup, a credential-free prepared step receives projection 1. A step
which explicitly declares setup credentials receives a distinct projection 2
limited to those names.

Setup operations which declare an agent-only credential never receive its
value. They write a reference to a deterministic sandbox environment variable
into native configuration, and that variable is populated only when the agent
command runs.

## CLI credential bindings

Programmatic hosts continue providing any `CredentialResolver` implementation.
The standard CLI adds a repeatable mapping:

```text
--credential-env <opaque-reference>=<host-environment-name>
```

For example, `--credential-env stripe.mcp-token=STRIPE_MCP_TOKEN` binds the
reference authored in an action to one explicitly selected host variable. The
argument never contains the value. Explicit mappings can replace the CLI's
automatic Anthropic mapping, identical duplicates are deterministic, and
conflicting duplicates fail.

Parsing and missing-value errors do not reproduce the right-hand side. This is
intentional because a user may accidentally pass a value instead of an
environment name. Unrelated ambient variables are never copied, and only
references selected by capability preflight are resolved.

`forge validate` remains authority-free: it validates schemas, handler
availability, adapter compatibility, and requirement conflicts without reading
host credential values.

## Built-in and host-owned actions

The public Forge repository owns built-in action schemas, implementations,
ordering, portable errors, and any agent-realization capability required by a
public action. The exact Forge version identifies their implementation.

An embedding repository may own additional semantics in an action bundle. The
public Forge package contains only the generic bundle contract; it does not name
or import a host package. A bundle owns one non-reserved namespace, and its
manifest version and implementation digest are pinned by the experiment and
selected plan.

Host-owned source projection still happens before the plan is frozen. Local
directories become immutable content snapshots; private artifacts are selected
by digest; credential values remain behind opaque references; and selected
network policy has a safe identity and digest. An action never reads an ambient
host path or silently chooses a different service during apply.

Agent-oriented bundle actions may use public, narrow adapter capabilities when
native realization differs. For example, a generic skill-snapshot capability
can let one host action target different agent-native directories without
putting that action's schema in public Forge. A generic writable tools path can
similarly support a host-owned CLI action. The bundle owns the action semantics;
the public adapter or runtime owns only the narrow mechanism.

Public plugin support is a built-in because it is part of portable benchmark
behavior. Version 1 explicitly selects the current entry from a named GitHub
marketplace rather than claiming an immutable plugin lock. Agent-native
realization and the run-time snapshot boundary remain explicit; exact plugin
pins, remote MCP bindings, and private repository authentication need separately
designed follow-ups.

## Lifecycle

The resulting execution order is:

1. Parse and resolve an ambient-free run plan.
2. Select the coding-agent adapter.
3. Freeze the built-in registry plus explicitly imported action bundles.
4. Resolve and preflight every setup step.
5. Aggregate and validate setup and agent credential declarations.
6. Obtain normal agent and completion-provider requirements.
7. Resolve only explicitly required credentials.
8. Prepare the runtime and coding agent.
9. Apply the prepared case setup followed by prepared treatment setup.
10. Finalize setup and seal state which must be immutable during interaction.
11. Open the agent session with agent-scoped credentials.
12. Preserve the existing interaction, quiescence, evidence, evaluation,
    staging, cleanup, and atomic commit lifecycle.

## Compatibility and release

The setup handler, executor, execution context, and composition contracts are
being finalized as part of the initial `0.1.0` release; there is no earlier
published contract to preserve with a compatibility shim. Experiment and case
`schema_version` remain `1`: no existing wire field changes meaning, and each
future action has an independent `@N` semantic version. Experiment configs pin
the exact compatible Forge package version and every extension bundle namespace,
version, and implementation digest they may select. Selected plans retain only
the bundles they use. After `0.1.0` is released, a future breaking
public-contract change must advance the package compatibility version.

## Verification

The foundation must prove:

- All setup steps preflight before any apply operation.
- Prepared steps apply exactly once in authored order.
- Case setup continues preceding treatment setup.
- Selection and runtime context are fixed at preflight.
- Parsed plans and setup-step inputs remain immutable through application.
- Composition has no setup-action registry or dynamic loading authority.
- The default engine rejects every unknown action.
- An extended engine accepts only actions in its immutable, manifest-backed
  bundle registry.
- Bundle references and selected actions match exactly before authority.
- Setup-only, agent-only, and shared credentials receive the intended scopes.
- Conflicting names or references fail before credential resolution.
- Raw scope assignment fails.
- Invalid runtime credential bytes fail before allocation.
- Invalid agent environment declarations fail during authority-free preflight.
- CLI mappings are explicit and errors do not echo accidental values.
- No action, including a credentialed installer, can observe a setup credential
  declared only by another action.
- Existing write, command, interaction, evidence, evaluation, and result
  behavior remains unchanged.

## Follow-up sequence

1. Complete versioned setup-action bundles and engine-bound lifecycle tests.
2. Add a plan-visible runtime network-policy identity and digest for hosts which
   require explicit proxy behavior.
3. Add an explicit private-source authentication contract if a public use case
   requires it; `forge/plugin@1` currently accepts credential-free sources.
4. Add generic agent skill-snapshot and writable tools-path capabilities needed
   by bundle-owned actions without adding those actions to the default registry.
5. Add Codex realizations and run the shared cross-adapter conformance suite.
