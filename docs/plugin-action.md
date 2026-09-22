# Marketplace plugin treatments

## Summary

`forge/plugin@1` installs the plugin currently published by an agent-native
marketplace. The experiment names the qualified plugin and its GitHub
`owner/repository` marketplace. During each run, Forge registers that repository
through the native CLI, selects the named entry, and installs the complete
plugin. Claude's plugin files, settings, and hook data remain writable during
interaction, as they do for a user installing and using a plugin.

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

1. Claude fetches the current marketplace into a fresh, run-owned home.
2. Later setup actions reuse an already registered marketplace after verifying
   its repository and path. Forge does not explicitly update it between actions.
3. The selected entry chooses the plugin source and installed version. Each
   installation records the checkout commit and installed contents.
4. Native plugin commands, file edits, and Claude's normal update behavior may
   change plugin state during interaction. Forge does not lock it.
5. A later run starts with fresh state and may install another release.

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

Forge validates the selected current marketplace entry before invoking native
plugin installation. Version 1 accepts credential-free forms supported by the native
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
  - declare writable plugins state under the selected Claude configuration root
      |
      v
prepare runtime and verify Claude version
      |
      v
apply forge/plugin@1 (uncredentialed)
  - register the GitHub marketplace with Claude's native CLI
  - validate catalog name, selected entry, and source shape
  - install through `claude plugin install ... --scope user --json`
  - verify native ID, resolved version, path, source commit when present,
    load status, dependencies, and filesystem shape
  - retain an installation-time provenance receipt
      |
      v
PreparedRuntime.finalizeSetup()
  - close preparation and setup command projections
  - keep plugin state writable and retain the container
      |
      v
open Claude session
  - discover installed plugins through native user settings
  - allow ordinary plugin file edits and native plugin management
      |
      v
quiesce runtime before evidence selection
```

Case setup still precedes treatment setup. Finalization occurs once after both
and closes preparation and setup command projections. Agent commands continue
to have normal access to the writable home and plugin state. A separate state
directory declared immutable by another capability can still require Docker
to replace the setup container; this plugin installer does not declare one.

## Native installation

For the example above, setup uses the equivalent of:

```sh
claude plugin marketplace add anthropics/claude-plugins-official --scope user
claude plugin install stripe@claude-plugins-official --scope user --json
claude plugin list --json
```

The original marketplace name and plugin ID are preserved. Claude writes its
normal `~/.claude/settings.json` and `~/.claude/plugins` state by default,
including cached plugin files and the native plugin data directory. A host
using another runtime can explicitly supply its run-owned layout when creating
the Claude adapter:

```ts
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';

const claude = createClaudeCodeAdapter({
  layout: {
    workspace: '/tmp/evaluation-123/workspace',
    home: '/tmp/evaluation-123/home',
    configDirectory: '/tmp/evaluation-123/session',
  },
});
```

The adapter snapshots these canonical absolute Linux paths before preflight.
The host must pin the same effective layout in its runtime configuration and
provide actual paths without symlink aliases; Forge does not resolve paths
against the embedding process's filesystem. The runtime's declared workspace
and HOME must match. Workspace must be separate from home and configuration
state; configuration may be a child of home or a separate run-owned directory.
The runtime must honor declared plain environment variables for setup and
interaction. When the configuration root differs from `HOME/.claude`, the
adapter declares `CLAUDE_CONFIG_DIR` for all command projections, including
uncredentialed plugin installation. Native settings, plugin cache paths,
marketplace verification, and exact-session evidence then use that same root.
Native project directories use the pinned Claude version's workspace-path
encoding, including its long-path hash suffix. The default layout retains
adapter versions `2` and `2+gateway`; a custom layout records `2+layout` or
`2+gateway.layout`.

Forge supplies no separate installer home, plugin seed/cache environment
variables, or forced `--settings` file.
Native settings can disable or enable the plugin, and plugin files and hook
data can be modified under normal tool and OS permissions. When an edit becomes
visible to an active session depends on Claude's own loading and reload behavior.

## Verification and initial provenance

Claude Code 2.1.273 supports machine-readable plugin installation and listing.
Forge checks the final `plugin install --json` result, `plugin list --json`, and
the native `installed_plugins.json` record. It rejects unexpected installed
IDs, load errors, inconsistent versions or paths, malformed resolved Git
commits, and symbolic links or other unsupported filesystem entries.

Every successful run retains the resolution under the corresponding step in
`setup.json`. It records the authored plugin and marketplace, the exact
marketplace checkout commit at installation, Claude's native ID, the
installed version, an archive digest or resolved Git commit when available,
and an installed-tree digest. This is an execution receipt rather than a plan
pin or a final-state inventory. Later setup steps, agent actions, hooks, or
native updates may change the installed files and settings.

The `forge-plugin-tree-v1` digest covers every regular file and directory below
the installed plugin root using root-relative paths, file sizes, and SHA-256
content digests in stable lexical order. Symlinks and special entries are
rejected. The receipt also records entry count, file count, and total regular
file bytes. It identifies the contents at the end of that installation even
when a marketplace archive omitted its own digest. It does not establish that
the agent used unchanged files throughout the interaction. Forge does not
currently record a separate final plugin digest or filesystem mutation log.

Each run starts with its own home and plugin state; neither is reused by another
run. Plugin state is declared with `sealAfterSetup: false`. The runtime still
quiesces all processes before collecting evidence, so allowing interaction-time
writes does not change the evidence collection boundary.

Forge uses Git to read marketplace provenance. Each such command trusts only
the exact run-owned checkout through a command-scoped `safe.directory`, without
modifying global Git configuration. The native CLI performs registration and
installation with its ordinary writable state.

## Credentials and current limitations

The current action declares no credentials and receives Forge's uncredentialed
setup command runner. It never receives the Anthropic credential used by the
later coding-agent session. The native CLI fetches GitHub marketplaces over
HTTPS; source URLs selected by that
catalog may not embed credentials, query parameters, or fragments.

Version 1 additionally has these limitations:

- Claude Code is the only built-in adapter with `AgentPluginInstaller`.
- Marketplace and plugin versions are resolved at execution time, so identical
  plans can install different releases on different dates.
- Installed state remains writable during interaction. The receipt is an
  installation snapshot and does not attest to later contents or settings.
- Remote MCP services and other network dependencies are not pinned.
- Dependencies declared by the selected plugin are not part of the v1 model;
  if Claude installs another plugin ID, Forge aborts before interaction.
- User-configurable plugin options, private repositories, and authenticated
  archives are not represented.
- A typed local skill-override action is not part of `forge/plugin@1`; writable
  state alone does not add that authoring contract.
