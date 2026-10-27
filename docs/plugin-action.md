# Marketplace plugin treatments

## Purpose

`forge/plugin` installs a registered plugin for the selected agent. Forge owns the distribution mapping; experiments evaluate the plugin
currently published by its GitHub marketplace.

The action's schema and lifecycle are public Forge behavior. Agent-specific
commands stay behind the narrow `AgentPluginInstaller` capability, implemented
by the built-in Claude Code, Codex, and OpenCode adapters.

Embedding hosts can use `AgentPluginInstaller` from a trusted
[setup action bundle](setup-action-bundles.md) to install other distributions.

## Experiment configuration

```yaml
treatments:
  baseline:
    setup: []
  stripe-plugin:
    setup:
      - uses: forge/plugin
        with:
          plugin: stripe
```

`stripe` is currently the only registered name. Both `claude-code` and `codex`
use the compatible Claude-format distribution `stripe@claude-plugins-official`
from `anthropics/claude-plugins-official`.

`with` accepts only `plugin`. Plans retain this short name; the producing Forge
version defines its native distribution and credential mapping. During pure
preflight, Forge resolves the name for the run's adapter and checks its installer
and authentication capabilities. Unsupported adapters fail before credentials
are resolved or a runtime is allocated.

The resolved marketplace name must match the fetched catalog, and the native
plugin name must select exactly one entry.

## “Latest” and reproducibility

The plugin action intentionally follows the marketplace's current default branch:

1. Each run starts with fresh, run-owned agent state.
2. Forge fetches the selected marketplace, using the native CLI where supported.
3. The marketplace entry selects the plugin source and installed version.
4. Forge validates the installation and records its identity, version,
   catalog commit, source commit when reported, and installed-content fingerprint.
5. Plugin state remains writable during interaction.

The experiment therefore has no plugin-version, marketplace-commit, or source
pin. Those fields are rejected rather than accepted and ignored. Identical
plans executed on different dates may install different plugin bytes.

Use `forge/plugin` only when that rolling behavior is part of the treatment.
A reproducibly pinned plugin would require a distinct lock contract and updates
to affected experiment configs.

## Installed behavior and external dependencies

Claude Code and Codex install the complete native plugin. A plugin may
contain commands, agents, hooks, language servers, or MCP configuration in
addition to skills.

Plugin files may name remote services that change independently of the installed
plugin version. These services remain mutable dependencies governed by the
runtime's network policy.

Source support depends on the selected native installer. Claude Code accepts:

- a canonical relative path within the fetched marketplace;
- an HTTPS Git URL, GitHub `owner/repository`, or Git subdirectory, optionally
  accompanied by `ref` and full Git SHA metadata; or
- an HTTPS archive, optionally accompanied by a 64-hex SHA-256 digest.

When a Claude Git-backed entry supplies a commit SHA, Forge requires the native
installed-state record to contain that commit. An archive SHA is accepted as
native marketplace metadata; Forge does not independently rehash the downloaded
archive or mirror its checksum into the installation receipt. Authenticated
archives, npm or command sources, embedded URL credentials, URL query
parameters or fragments, and transitive plugin dependencies are not supported
by this action.

Codex accepts a string or `{source: local, path: ./...}` marketplace-relative
path, or a credential-free HTTPS `url` or `git-subdir` source with optional
`ref`, full 40-hex Git `sha`, and subdirectory. Forge checks that native source
metadata retains the catalog's selectors. Codex applies the pin during install;
Forge does not independently verify the checkout commit. It rejects archives,
npm, `github` source objects, and dependencies. Codex receipts omit the optional
resolved source commit and use the installed-tree fingerprint to identify
observed bytes.

Codex selects the first native catalog present in this order:

1. `.agents/plugins/marketplace.json`
2. `.agents/plugins/api_marketplace.json`
3. `.claude-plugin/marketplace.json`
4. `.cursor-plugin/marketplace.json`

The pinned CLI does not recognize `.codex-plugin/marketplace.json`. A repository
with that file and a compatible Claude catalog therefore installs from the
Claude catalog. Forge validates the catalog the CLI actually selects.
Installed manifests may use the native `.codex-plugin`, `.claude-plugin`, or
`.cursor-plugin` format, or Agent Plugins 1.0's schema-qualified root
`plugin.json`. Forge checks the native manifest's identity and version.

## OpenCode standard bundle

OpenCode uses the same `stripe@claude-plugins-official` catalog entry as Codex.
It requires that entry to select `stripe/ai` with a full Git source SHA, checks
out that exact commit, and installs its `providers/agent-plugins/plugin`
standard bundle. The bundle may have a different version from the Claude-format
plugin at that commit. The catalog itself is fetched at execution time, so its
source pin can change between runs; Forge does not hard-code a plugin revision.

OpenCode has no native marketplace installer. Forge validates the standard
manifest and materializes its files into run-owned OpenCode state. Supported
behavior is skills plus the bundled Stripe HTTP MCP connection. Unsupported
behavioral declarations, missing skills, and unsafe filesystem entries fail
setup. Claude-specific hooks, commands, and agents are not ported.

The generated native config adds an absolute skill path and a remote MCP server
with OAuth disabled and `Authorization: Bearer {env:STRIPE_API_KEY}`. It retains
the bundled URL. An authored Stripe MCP entry is rejected rather than replacing
or disabling this connection. The adapter snapshots the combined authored and
plugin config and restores it before every turn, including resume.

OpenCode receipts use `installation: opencode-bundle` instead of
`native_plugin_id`. They retain the selected catalog identity and commit, record
`source: {kind: git-subdir, commit, path}` for the actual standard bundle, and
fingerprint the copied bundle plus generated config. The native Claude/Codex
receipt shape is unchanged. Like other plugin state, bundle files remain writable
during interaction; the receipt describes installation-time contents.

## Hook policy and writable state

Codex plugin installation and interaction share the run-owned `CODEX_HOME`.
Before installation and every initial or resumed turn, Forge filters its
`config.toml` to validated native marketplace/plugin settings, project trust,
and hook enablement/review state. This lets Codex load enabled skills, hooks,
and MCP configuration without inheriting user-level provider or authentication
settings. Changes to plugin enablement
remain effective on subsequent turns. Codex's recorded workspace trust is
retained because its resume path does not repeat first-turn trust initialization.

Hook trust is an agent coordinate in the experiment:

```yaml
matrix:
  agents:
    - adapter: codex
      provider: openai
      model: gpt-5.4
      hook_trust: automation
```

`native` is the default and leaves hook review to Codex. `automation` passes
`--dangerously-bypass-hook-trust` on every turn and permits all enabled hooks,
including workspace hooks, to run without review. New resolved plans record
the default explicitly; saved plans without the field use `native`. The policy
participates in matrix identity, plan hashes, and report grouping. It is not a
plugin option. Claude Code rejects `hook_trust` and retains its native settings
and hook execution behavior.

## Execution and receipt

During pure preflight, Forge resolves the registered plugin, binds the adapter's
installer, and declares executable, state, and agent credential requirements.
During setup, the prepared operation:

1. registers the marketplace;
2. validates the catalog and selected source;
3. installs through the agent's native CLI, or materializes OpenCode's standard bundle;
4. validates the plugin identity, version, path, source provenance, and native
   load status where applicable;
5. configures the bundled MCP connection; and
6. fingerprints the configured installation and records a receipt in `setup.json`.

The receipt includes:

- the resolved marketplace and native plugin selection;
- the exact catalog commit used to read the marketplace entry;
- the native plugin ID or bundle installation kind, and installed version;
- the selected source kind and installer-reported Git commit when available; and
- a deterministic digest and size/count summary of the installed tree.

Forge bounds and validates the installed tree, rejecting symbolic links and
special entries. The tree fingerprint covers relative paths, directories, and
the exact regular-file bytes read after installation in stable path order,
independent of the adapter's listing order. It lets runs compare installed
contents even when the plugin version or reported source commit is unchanged.

Git commits identify the catalog snapshot and the source revision reported by
the installer. Claude must report any source commit pinned by its
catalog; Codex reports the requested selectors; OpenCode verifies the checked-out
source commit. The tree
fingerprint identifies observed installation-time contents separately from
those source identities.

The receipt is recorded at installation and does not attest to final state.
Later setup actions, the coding agent, hooks, or native update behavior may
change plugin files and settings before the run ends. The runtime still
quiesces all mutation before evidence selection.

## Credentials and limitations

Selecting `plugin: stripe` automatically configures bearer authentication for
its bundled HTTP MCP connection. By default, the CLI reads an Agent API key from
the host's `STRIPE_API_KEY`. To read another host variable, pass an explicit binding:

```sh
npx --no-install forge run --experiment ./experiment.yaml --output ./results \
  --credential-env env:STRIPE_API_KEY=STRIPE_TEST_KEY
```

Export the selected host variable before starting the eval. An explicit binding
takes precedence over the default; if its value is missing, Forge fails without
falling back to another variable. Account or merchant provisioning remains
external to Forge.
Embedding hosts resolve the opaque reference `env:STRIPE_API_KEY` through their
credential resolver. Missing values fail before runtime allocation. Ordinary
validation and planning need no values.

Forge keeps the bundled URL and unrelated plugin content. Claude and OpenCode use
Authorization header templates; Codex uses `bearer_token_env_var`. All reference
`STRIPE_API_KEY` inside the runtime, so other tools invoked by the agent can
use the same key. Tokens reach only agent commands, never setup commands.
Forge fingerprints the configured installation. Runtime credential names and
references are part of the Forge version; the host variable name is not recorded
in the plan.

Use `forge validate --host --experiment …` to install setup and check native MCP
initialization and tool discovery from a disposable runtime. It requires the
Stripe key, makes no model or MCP tool calls, and reports model auth as
untested. Ordinary `validate` remains credential-free. Eval execution also runs
native MCP checks after setup when the adapter supplies them (Claude Code and
Codex). A failed check stops setup before the agent session opens. Codex rejects
missing or disconnected plugin servers, unavailable bearer auth, and empty tool
maps with fixed reasons that do not include native output. These checks discover
tools but do not invoke them or prove model-facing tool use. A full eval with a
known tool call is needed to verify that boundary.

A missing server, non-HTTP transport, manifest MCP override, or unsupported auth
source fails setup. Custom MCP config paths, OAuth, and host login passthrough
are unsupported.

Plugin installation receives an uncredentialed setup command runner. Fetches
therefore work only for credential-free HTTPS sources accepted by the installer.

Current limitations are:

- supported distributions and source handling differ by agent;
- marketplace and plugin versions resolve at execution time;
- installed state remains writable during interaction;
- remote services referenced by a plugin are not pinned;
- plugin dependencies are unsupported; and
- private repositories, authenticated archives, and user-defined plugin
  options are unsupported.
