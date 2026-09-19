# Marketplace plugin treatments

## Summary

`forge/plugin@1` installs the plugin currently published by an agent-native
marketplace. The experiment names the qualified plugin and its GitHub
`owner/repository` marketplace. During each run, Forge snapshots that
repository's current default-branch `HEAD`, selects the named entry, installs
the complete plugin through the selected adapter, and seals the resulting
plugin state before interaction.

The first realization is Claude Code. The action and its wire format are public
Forge behavior; Claude-specific marketplace commands remain behind the narrow
`AgentPluginInstaller` capability. Other adapters can implement that capability
without changing the action or branching in the setup executor.

## Experiment format

```yaml
treatments:
  baseline:
    setup: []
  stripe-plugin:
    setup:
      - uses: forge/plugin@1
        with:
          agents:
            claude-code:
              plugin: stripe@claude-plugins-official
              marketplace: anthropics/claude-plugins-official
```

`agents` is keyed by the experiment's adapter ID. Parsing validates every
branch, while preflight selects one branch and setup contacts only that
branch's marketplace. A missing selected branch or an adapter without a plugin
installer is an authority-free preflight error.

The native plugin ID remains qualified as `plugin@marketplace`. The marketplace
portion must match the catalog's `name`, and the plugin portion must select
exactly one entry.

## “Latest” semantics

Version 1 deliberately follows the marketplace's current default branch:

1. Forge fetches `HEAD` once into run-owned state.
2. Every plugin selected from the same marketplace during that run uses that
   one snapshot.
3. The marketplace entry chooses the plugin source and installed version.
4. A later run may fetch a different marketplace commit, source commit, or
   plugin version.

The experiment therefore does not contain `version`, `marketplace.commit`, or
`source` fields. Those fields are rejected rather than accepted and ignored.
`forge/plugin@1` is suitable for comparisons intended to exercise the latest
published plugin, but its plan alone cannot reproduce the exact plugin bytes at
a later date. A future pinned action needs a separately versioned lock contract.

## A plugin is more than its skills

Forge installs the complete native plugin directory. Depending on the plugin,
that can include skills, slash commands, agents, hooks, language servers, and
MCP configuration. Forge does not extract only the skill directories.

For example, the Stripe plugin currently includes an `.mcp.json` entry pointing
at `https://mcp.stripe.com`. The marketplace snapshot determines that literal
configuration, but it does not freeze the implementation or data served by the
remote endpoint. Version 1 neither rewrites that URL nor verifies an MCP service
release. The selected runtime's network policy determines how the endpoint is
reached.

Consequently, installing the latest plugin and contacting a rolling remote MCP
service are both intentionally mutable inputs. Pinning or devbox-overriding an
MCP service requires a future explicit service-binding contract; it cannot be
derived from the plugin's package version.

## Accepted marketplace sources

Forge validates the selected current marketplace entry before giving it to
Claude. Version 1 accepts credential-free forms supported by the native
installer:

- a canonical `./relative/path` inside the fetched marketplace;
- an HTTPS Git URL, GitHub `owner/repository`, or Git subdirectory, with
  optional `ref` and full `sha` metadata; or
- an HTTPS archive, with an optional 64-hex SHA-256 supplied by the marketplace.

When the current entry includes a Git `sha`, Forge verifies that Claude's
installed-state record contains that commit. The action does not require the
entry to include one because its public semantics are “latest.” Authenticated
archive helpers, npm and command sources, and transitive plugin dependencies
are rejected.

## Lifecycle

```text
parse experiment
      |
      v
pure setup preflight
  - select agent branch
  - bind AgentPluginInstaller
  - declare git/claude executables
  - declare setup-sealed plugin state
  - declare separate writable plugin data
      |
      v
prepare runtime and verify Claude version
      |
      v
apply forge/plugin@1 (uncredentialed)
  - fetch the marketplace's current default-branch HEAD
  - validate catalog name, selected entry, and source shape
  - replace a reserved catalog name with a deterministic local alias
  - install through `claude plugin install ... --json`
  - verify native ID, resolved version, path, source commit when present,
    load status, dependencies, and filesystem shape
  - write exact enabled-plugin session settings
  - link the seed's data directory to the run-owned writable data mount
      |
      v
PreparedRuntime.finalizeSetup()
  - close preparation and setup command projections
  - restart Docker with plugin state mounted read-only
      |
      v
open Claude session
  - use the sealed directory as plugin seed and cache
  - force the selected plugin enabled through sealed settings
  - disable nonessential background traffic
```

Case setup still precedes treatment setup. Finalization occurs once after both,
so several plugin actions can populate one run-owned seed before it becomes
immutable.

## Reserved marketplace names

Claude rejects some local directory marketplaces whose catalog uses a reserved
name, including `claude-plugins-official`. Forge must use a local directory so
it can keep one consistent snapshot for the run.

After validating the original catalog, Forge derives a local alias from the
marketplace name and repository. It rewrites only the local catalog name and
retains the selected entry. The agent may therefore load a native ID such as
`stripe@forge-4bce...`; the experiment and plan continue to identify
`stripe@claude-plugins-official`. The alias is an adapter implementation detail.

## Native verification and state sealing

Claude Code 2.1.273 supports machine-readable plugin installation and listing.
Forge checks the final `plugin install --json` result, `plugin list --json`, and
the native `installed_plugins.json` record. It rejects unexpected installed
IDs, load errors, inconsistent versions or paths, malformed resolved Git
commits, and symbolic links or other unsupported filesystem entries.

Every successful run retains the resolution under the corresponding step in
`setup.json`. It records the authored plugin and marketplace, the exact
marketplace commit fetched for the run, Claude's native aliased ID, the
installed version, an archive digest or resolved Git commit when available,
and an installed-tree digest. This is an execution receipt rather than a plan
pin: a later execution of the same plan still resolves the then-current
marketplace `HEAD`.

The `forge-plugin-tree-v1` digest covers every regular file and directory below
the installed plugin root using root-relative paths, file sizes, and SHA-256
content digests in stable lexical order. Symlinks and special entries are
rejected. The receipt also records entry count, file count, and total regular
file bytes. It therefore identifies the exact plugin contents presented to the
agent even when a marketplace archive omitted its own digest.

The isolated installer home and cache contain only plugins selected by earlier
steps in the same setup. Forge never runs `marketplace update` or `plugin
update` after taking the run snapshot.

An installer can declare a runtime state directory with `sealAfterSetup: true`.
After setup, `PreparedRuntime.finalizeSetup()` permanently closes the
uncredentialed and setup command projections. The Docker runtime replaces its
setup container with an interaction container whose plugin state is mounted
read-only.

Claude receives both `CLAUDE_CODE_PLUGIN_SEED_DIR` and
`CLAUDE_CODE_PLUGIN_CACHE_DIR` pointing at that sealed directory. Supplying the
cache variable as well is required for command-mode discovery in the pinned
Claude Code 2.1.273 runtime.

That Claude version also derives each plugin's `CLAUDE_PLUGIN_DATA` directory
from the cache root. Forge creates one `seed/data` symlink during setup whose
target is a separate, declared, run-owned writable state mount. The symlink
itself, installed plugin files, marketplace snapshot, and session settings are
sealed read-only. Hooks can persist run-local data without changing installed
code. This Forge-owned link is outside every installed plugin tree; symlinks
inside those trees remain rejected. Neither the data nor the plugin seed is
reused by another run.

Docker Desktop can expose host ownership on the marketplace bind mount. Each
Forge Git command sets `safe.directory` only for its exact run-owned snapshot,
without trusting arbitrary repositories or modifying global Git configuration.

## Credentials and current limitations

The current action declares no credentials and receives Forge's uncredentialed
setup command runner. It never receives the Anthropic credential used by the
later coding-agent session. Forge expands a marketplace slug to
`https://github.com/<owner>/<repository>.git`; source URLs selected by that
catalog may not embed credentials, query parameters, or fragments.

Version 1 additionally has these limitations:

- Claude Code is the only built-in adapter with `AgentPluginInstaller`.
- Marketplace and plugin versions are resolved at execution time, so identical
  plans can install different releases on different dates.
- Remote MCP services and other network dependencies are not pinned.
- Dependencies declared by the selected plugin are not part of the v1 model;
  if Claude installs another plugin ID, Forge aborts before interaction.
- User-configurable plugin options, private repositories, and authenticated
  archives are not represented.
