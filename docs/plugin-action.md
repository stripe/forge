# Marketplace plugin treatments

## Purpose

`forge/plugin` is a built-in setup action for installing a complete
agent-native plugin from a GitHub marketplace. It is intended for experiments
that deliberately evaluate the plugin currently published by that marketplace.

The action's schema and lifecycle are public Forge behavior. Agent-specific
commands stay behind the narrow `AgentPluginInstaller` capability; Claude Code
is currently the only built-in adapter that implements it.

This action is distinct from a [setup action bundle](setup-action-bundles.md):
`forge/plugin` ships with Forge, while bundles let an embedding host add its
own setup semantics.

## Experiment configuration

```yaml
treatments:
  baseline:
    setup: []
  marketplace-plugin:
    setup:
      - uses: forge/plugin
        with:
          agents:
            claude-code:
              plugin: example-plugin@example-marketplace
              marketplace: example-org/example-marketplace
```

The names above are illustrative and must be replaced with a real marketplace
and qualified plugin ID.

`agents` is keyed by adapter ID. Forge validates every authored branch, then
selects only the branch for the run's coding agent during pure preflight. A
missing branch or an adapter without `AgentPluginInstaller` fails before
credentials are resolved or a runtime is allocated.

The plugin ID remains qualified as `plugin@marketplace`. Its marketplace name
must match the fetched catalog, and its plugin name must select exactly one
entry.

## “Latest” and reproducibility

The plugin action intentionally follows the marketplace's current default branch:

1. Each run starts with fresh, run-owned agent state.
2. Forge registers the authored marketplace through the agent's native CLI.
3. The marketplace entry selects the plugin source and installed version.
4. Forge validates the native installation and records its IDs, version,
   catalog commit, reported source commit, and installed-content fingerprint.
5. Plugin state remains writable during interaction.

The experiment therefore has no plugin-version, marketplace-commit, or source
pin. Those fields are rejected rather than accepted and ignored. Identical
plans executed on different dates may install different plugin bytes.

Use `forge/plugin` only when that rolling behavior is part of the treatment.
A reproducibly pinned plugin would require a distinct lock contract and updates
to affected experiment configs.

## Installed behavior and external dependencies

Forge installs the complete native plugin, not only its skills. A plugin may
contain commands, agents, hooks, language servers, or MCP configuration in
addition to skills.

Plugin files may name remote services that change independently of the installed
plugin version. These services remain mutable dependencies governed by the
runtime's network policy.

The action accepts credential-free marketplace source forms supported by the
native installer:

- a canonical relative path within the fetched marketplace;
- an HTTPS Git URL, GitHub `owner/repository`, or Git subdirectory, optionally
  accompanied by `ref` and full Git SHA metadata; or
- an HTTPS archive, optionally accompanied by a 64-hex SHA-256 digest.

When a Git-backed entry supplies a commit SHA, Forge requires the native
installed-state record to contain that commit. An archive SHA is accepted as
native marketplace metadata; Forge does not independently rehash the downloaded
archive or mirror its checksum into the installation receipt. Authenticated
archives, npm or command sources,
embedded URL credentials, URL query parameters or fragments, and transitive
plugin dependencies are not supported by this action.

## Execution and receipt

During pure preflight, Forge selects the agent branch, binds the adapter's
plugin installer, and declares its executable and state requirements. During
setup, the prepared operation:

1. registers the marketplace;
2. validates the catalog and selected source;
3. installs through the agent's native CLI;
4. validates the native plugin identity, version, path, load status, and source
   provenance; and
5. records an installation receipt in `setup.json`.

The receipt includes:

- the authored marketplace and plugin IDs;
- the exact catalog commit used to read the marketplace entry;
- the native plugin ID and installed version;
- the selected source kind and installer-reported Git commit when available; and
- a deterministic digest and size/count summary of the installed tree.

Forge bounds and validates the installed tree, rejecting symbolic links and
special entries. The tree fingerprint covers relative paths, directories, and
the exact regular-file bytes read after installation in stable path order,
independent of the adapter's listing order. It lets runs compare installed
contents even when the plugin version or reported source commit is unchanged.

Git commits identify the catalog snapshot and the source revision reported by
the native installer. A source commit is optional for an unpinned Git source;
when the catalog supplies an expected commit, the installer must report that
same commit. The tree fingerprint identifies observed installation-time
contents separately from those source identities.

The receipt is recorded at installation and does not attest to final state.
Later setup actions, the coding agent, hooks, or native update behavior may
change plugin files and settings before the run ends. The runtime still
quiesces all mutation before evidence selection.

## Credentials and limitations

`forge/plugin` declares no credentials and receives an uncredentialed setup
command runner. It never receives the coding agent's model credential. Fetches
therefore work only for credential-free HTTPS sources accepted by the action.

Current limitations are:

- only the built-in Claude Code adapter implements plugin installation;
- marketplace and plugin versions resolve at execution time;
- installed state remains writable during interaction;
- remote services referenced by a plugin are not pinned;
- plugin dependencies are unsupported; and
- private repositories, authenticated archives, and user-defined plugin
  options are unsupported.
