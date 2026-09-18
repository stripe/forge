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
actions follow as separate vertical slices.

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
- Host composition is only for actions Forge does not officially ship.
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
| Generic first-party | `forge/write@1`, `forge/command@1`, `forge/skill@1`, `forge/mcp@1`, `forge/plugin@1` | Forge | Forge or selected adapter |
| Product first-party | `stripe/cli@1`, `stripe/link-cli@1` | Forge repository action owner | Forge repository action owner |
| External | `acme/install-tool@1` | Host extension | Host composition |

This change retains the two currently executable first-party actions:
`forge/write@1` and `forge/command@1`. The latter is the argv-based counterpart
to eval-runner's `shell` setup step; it does not add implicit shell parsing.
Skills, MCP, plugins, and Stripe CLIs in this table describe the intended action
ownership model, but remain non-executable until the follow-up slices below land.

The engine always installs the first-party registry. `ForgeComposition` exposes
only an optional `setupExtensions` map. Both `forge/` and `stripe/` are reserved
first-party namespaces, and a host cannot replace any registered first-party
handler. Supplying the exact existing first-party object is tolerated only as a
migration convenience. The exported registry is an introspection and migration
view; the engine retains its own registry so mutating that JavaScript object
cannot change execution behavior.

Different teams may own action-specific directories and review through
`CODEOWNERS`; that organizational boundary does not make an action dynamically
loaded or private.

## Prepared setup contract

Each `SetupStepHandler.preflight()` call receives only ambient-free selection
and runtime information. It returns a `PreparedSetupStep` containing validated
requirements and the exact operation that will later apply. The executor
preflights all steps, aggregates their requirements, and returns one
`PreparedSetup`.

The prepared object captures the selected handlers and normalized values in
memory. Execution does not repeat handler lookup or requirement derivation.
This prevents composition mutation or a second interpretation of the same wire
payload after credentials have been resolved.

The public requirement shape has three explicit concepts:

- `variables`: non-secret values which retain the existing behavior of being
  available to all runtime command projections.
- `credentials.setup`: opaque references exposed only through the setup command
  runner.
- `credentials.agent`: opaque references exposed only through the coding-agent
  command runner.

The top-level apply context includes uncredentialed and setup-scoped command
projections. For each prepared step, Forge exposes the setup projection only
when that step declared at least one setup credential; otherwise the operation
receives the uncredentialed projection. This keeps `forge/command@1`, which
declares no credentials, from observing credentials required by another setup
action. The per-step context also includes the selected agent coordinates,
runtime selection, step index, logical runtime paths, run-owned workspace,
input provider, and abort signal. It does not contain credential values, the
agent command runner, runtime cleanup authority, or ambient host state.

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

The runtime continues exposing three projections:

1. Uncredentialed agent preparation receives explicit non-secret variables.
2. Setup receives those variables and setup-scoped credentials.
3. Agent interaction receives those variables and agent-scoped credentials.

Within setup, a credential-free prepared step receives projection 1. A step
which explicitly declares a setup credential receives projection 2.

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

## Future agent realization

Portable agent-oriented actions will use typed adapter capabilities rather than
adapter-owned action handlers. The flow for MCP will be:

1. The Forge-owned `forge/mcp@1` handler validates the canonical HTTP MCP
   payload.
2. It derives a deterministic sandbox credential variable and declares its
   opaque reference under `credentials.agent`.
3. It creates a normalized MCP request containing the server name, URL,
   transport, and sandbox variable name, but no secret value.
4. It verifies during pure preflight that the selected adapter exposes an MCP
   realization capability.
5. The prepared operation invokes that capability during ordered setup.
6. Claude may render `.mcp.json`; Codex may use its native CLI. Both mechanisms
   receive the same normalized semantics.

The same boundary applies to skills and plugins. Forge validates sources,
identities, versions, and public semantics; the adapter selects native paths
and commands.

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
the selected runtime platform. Separate handler-package provenance is needed
only for genuine external extensions.

## Lifecycle

The resulting execution order is:

1. Parse and resolve an ambient-free run plan.
2. Select the coding-agent adapter.
3. Install the first-party action registry and explicit host extensions.
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
public, so this is an intentional `0.2.0` change rather than a compatibility
shim which would preserve ambiguous behavior. Experiment and case
`schema_version` remain `1`: no existing wire field changes meaning, and each
future action has an independent `@N` semantic version. Experiment configs pin
the exact compatible Forge package version.

## Verification

The foundation must prove:

- All setup steps preflight before any apply operation.
- Prepared steps apply exactly once in authored order.
- Case setup continues preceding treatment setup.
- Selection and runtime context are fixed at preflight.
- First-party actions cannot be replaced through composition.
- Unknown `forge/` and `stripe/` actions fail parsing.
- Setup-only, agent-only, and shared credentials receive the intended scopes.
- Conflicting names or references fail before credential resolution.
- Raw scope assignment fails.
- Invalid runtime credential bytes fail before allocation.
- CLI mappings are explicit and errors do not echo accidental values.
- Credential-free actions, including `forge/command@1`, cannot observe setup
  credentials declared by another action.
- Existing write, command, interaction, evidence, evaluation, and result
  behavior remains unchanged.

## Follow-up sequence

1. Add typed agent setup realization interfaces with `forge/skill@1` as the
   first secret-free vertical slice.
2. Add `forge/mcp@1` and prove agent-only bearer delivery.
3. Add a writable runtime tools path and implement first-party `stripe/cli@1`.
4. Add `forge/plugin@1` with immutable coordinates and setup-only marketplace
   credentials where required.
5. Add first-party `stripe/link-cli@1` if it remains part of the supported
   action set.
6. Add Codex realizations and run the shared cross-adapter conformance suite.
