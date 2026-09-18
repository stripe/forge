# Agent-aware setup and credential contracts

## Summary

Forge needs to support setup actions whose public meaning is portable but whose
native realization depends on the selected coding agent. Skills, MCP servers,
and plugins are the initial examples. Forge also needs first-party product
actions, such as `stripe/cli@1`, whose implementation ships in this public
repository even though their semantic owner is not the generic `forge/`
namespace.

This design makes setup a two-stage operation:

1. Pure preflight validates every step, binds it to one exact implementation,
   and declares all required setup and agent credentials.
2. After Forge resolves those declarations and prepares the runtime, it applies
   the already-preflighted operations in source order.

The foundation in this change covers prepared setup, credential lifecycle
declarations, the first-party action boundary, and explicit CLI credential
bindings. Concrete `forge/skill@1`, `forge/mcp@1`, `stripe/cli@1`, and plugin
actions follow as separate vertical slices. Typed resource inputs let a host
select public, private, or explicit devbox sources without replacing the action
handler or changing its semantics. Network proxying remains a separate runtime
concern.

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
One treatment should express `forge/mcp@1` once. Forge owns that action's schema
and semantics, and the selected adapter realizes a typed request as Claude or
Codex configuration.

## Design principles

- Forge owns the schema, validation, ordering, and portable semantics of every
  first-party action.
- Agent adapters provide narrow native realization mechanisms; they do not own
  arbitrary `forge/*` handlers.
- All official actions are implemented in this public repository and available
  through the standard Forge CLI and programmatic engine.
- The action namespace identifies semantic ownership, not code location or
  loading behavior. Both `forge/mcp@1` and `stripe/cli@1` are first-party.
- Hosts cannot register setup actions or replace first-party handlers.
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
| Generic first-party | `forge/write@1`, `forge/command@1`, `forge/skill@1`, `forge/mcp@1`, `forge/plugin@1` | Forge | Forge, a typed resource resolver, or the selected adapter |
| Product first-party | `stripe/cli@1`, `stripe/link-cli@1` | Forge repository action owner | Forge repository action owner |

This change retains the two currently executable first-party actions:
`forge/write@1` and `forge/command@1`. The latter is the argv-based counterpart
to eval-runner's `shell` setup step; it does not add implicit shell parsing.
Skills, MCP, plugins, and Stripe CLIs in this table describe the intended action
ownership model, but remain non-executable until the follow-up slices below land.

The engine always installs the first-party registry. `ForgeComposition` exposes
no setup-handler registry. Unknown action IDs fail schema validation, and a host
cannot replace a registered first-party handler. The exported registry is an
introspection view; the engine retains its own registry so mutating that
JavaScript object cannot change execution behavior.

Different teams may own action-specific directories and review through
`CODEOWNERS`; that organizational boundary does not make an action dynamically
loaded or private.

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

## Public actions and environment-specific resources

There should not be a separate internal implementation of Forge setup actions.
The internal eval-runner depends on the exact public Forge package and supplies
narrow resolver implementations through public contracts.

The public Forge repository owns:

- the versioned `forge/mcp@1` and `forge/skill@1` wire schemas;
- strict parsing, normalization, credential declaration, and portable errors;
- canonical MCP binding and content-addressed skill-source contracts;
- typed source-resolution interfaces where portable source coordinates require
  resolution before planning;
- the action handlers and their ordering within the shared lifecycle;
- agent-realization requests for Claude, Codex, and other supported adapters;
- provenance, content-digest, and verification rules; and
- default implementations for genuinely public source forms.

The internal eval-runner owns only environment-specific implementations and
policy:

- projecting Stripe-private source coordinates into canonical action inputs;
- turning an explicit local skill override into an immutable input snapshot;
- resolving Stripe-private artifact coordinates and credentials;
- implementing devbox MITM proxy mechanics, certificate handling, and routing
  in an internal runtime adapter;
- exposing internal CLI flags or configuration which select those overrides;
  and
- enforcing any Stripe-specific access and network policy.

An override is an input or runtime-policy selection, not a replacement handler.
It must be chosen before the final run plan is frozen and represented by safe
provenance. Local skill bytes must be captured and content-hashed; the setup
action must not read an ambient devbox path later during execution. A selected
network policy must have a stable identity and digest without recording secret
values. This makes a devbox run distinguishable and auditable while keeping the
action's meaning identical to a normal run.

## Future agent realization

Portable agent-oriented actions will use typed resource inputs and adapter
capabilities rather than host- or adapter-owned action handlers. The flow for
MCP will be:

1. The Forge-owned `forge/mcp@1` handler validates the canonical server name,
   URL, transport, and optional credential reference.
2. It derives a deterministic sandbox credential variable and declares its
   opaque reference under `credentials.agent`.
3. It creates a normalized MCP request containing the server name, URL,
   transport, and sandbox variable name, but no secret value.
4. It verifies during pure preflight that the selected adapter exposes an MCP
   realization capability.
5. The prepared operation invokes that capability during ordered setup.
6. Claude may render `.mcp.json`; Codex may use its native CLI. Both mechanisms
   receive the same normalized semantics.

The MCP handler does not know whether traffic later passes directly to that URL
or through a devbox proxy. A separate runtime/network slice must make the
selected proxy policy identity and digest plan-visible; the internal runtime
adapter owns the actual proxy, CA, and rewrite mechanics. An MCP binding resolver
is needed only if authoring uses a logical service coordinate instead of a
canonical URL, and its output must become ordinary plan input before freezing.

For skills, source projection produces a content-addressed input snapshot before
the plan is frozen. The same boundary applies to plugins. Forge validates
sources, identities, versions, and public semantics; source resolution selects
immutable bytes, and the adapter selects native paths and commands.

## First-party Stripe CLI

`stripe/cli@1` is a first-party action implemented in this repository and
installed by the standard engine. It is not a composition extension. Its
`stripe/` namespace communicates product ownership while its exact
implementation remains pinned by the Forge version.

Stripe CLI requires one additional runtime capability not included in this
foundation: a run-owned, non-root tools directory on the agent's `PATH`. The
planned implementation will expose a logical tools path backed by
`/home/forge/.local/bin`, download a platform-specific pinned artifact to a
temporary path, verify its SHA-256 digest, set executable permissions, rename it
atomically, and verify its version. An optional Stripe credential will be
declared under `credentials.agent`; installation itself does not need it.

Because the action ships with Forge, its implementation is identified by the
exact Forge version, `stripe/cli@1`, the configured CLI version and digest, and
the selected runtime platform. There is no separately injected handler package.

## Lifecycle

The resulting execution order is:

1. Parse and resolve an ambient-free run plan.
2. Select the coding-agent adapter.
3. Install the first-party action registry.
4. Resolve and preflight every setup step.
5. Aggregate and validate setup and agent credential declarations.
6. Obtain normal agent and completion-provider requirements.
7. Resolve only explicitly required credentials.
8. Prepare the runtime and coding agent.
9. Apply the prepared case setup followed by prepared treatment setup.
10. Open the agent session with agent-scoped credentials.
11. Preserve the existing interaction, quiescence, evidence, evaluation,
    staging, cleanup, and atomic commit lifecycle.

## Compatibility and release

The setup handler, executor, execution context, and composition contracts are
being finalized as part of the initial `0.1.0` release; there is no earlier
published contract to preserve with a compatibility shim. Experiment and case
`schema_version` remain `1`: no existing wire field changes meaning, and each
future action has an independent `@N` semantic version. Experiment configs pin
the exact compatible Forge package version. After `0.1.0` is released, a future
breaking public-contract change must advance the package compatibility version.

## Verification

The foundation must prove:

- All setup steps preflight before any apply operation.
- Prepared steps apply exactly once in authored order.
- Case setup continues preceding treatment setup.
- Selection and runtime context are fixed at preflight.
- Parsed plans and setup-step inputs remain immutable through application.
- Composition has no arbitrary setup-action registry.
- Every unknown setup action fails parsing.
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

1. Add a plan-visible runtime network-policy identity and digest so an internal
   adapter can implement eval-runner's devbox proxy without hidden inputs.
2. Add typed skill-source resolution and agent realization with `forge/skill@1`
   as the first secret-free vertical slice, including immutable devbox input
   snapshots.
3. Add `forge/mcp@1` with canonical bindings and agent-only bearer delivery;
   keep runtime proxy selection outside the action.
4. Add a writable runtime tools path and implement first-party `stripe/cli@1`.
5. Add `forge/plugin@1` with immutable coordinates and setup-only marketplace
   credentials where required.
6. Add first-party `stripe/link-cli@1` if it remains part of the supported
   action set.
7. Add Codex realizations and run the shared cross-adapter conformance suite.
