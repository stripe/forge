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

`stripe` is currently the only registered name. Claude Code, Codex, and OpenCode
use the Claude-format distribution `stripe@claude-plugins-official` from
`anthropics/claude-plugins-official`. OpenCode loads its skills and MCP connection
as described below.

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

## OpenCode skills and MCP

OpenCode uses the same `stripe@claude-plugins-official` catalog entry as Claude
Code and Codex. It requires that entry to select `stripe/ai`'s
`providers/claude/plugin` with a full Git source SHA, checks out that exact
commit, and copies the selected bundle. Its version comes from the bundle's
`.claude-plugin/plugin.json`. The catalog is fetched at execution time, so its
source pin can change between runs; Forge does not hard-code a plugin revision.

OpenCode has no native marketplace installer. Forge validates the Claude-format
manifest and materializes its files into run-owned OpenCode state. It loads
only the conventional `skills/` directory and translates the Stripe HTTP
connection in `.mcp.json` into native OpenCode configuration. Other files and
Claude-specific hook, command, and agent declarations are retained but are not
registered or executed. Missing skills, manifest overrides of the skills or MCP
paths, unsupported MCP configuration, and unsafe filesystem entries fail setup.

The generated native config adds an absolute skill path and a remote MCP server
with OAuth disabled and `Authorization: Bearer {env:STRIPE_API_KEY}`. It retains
the bundled URL. An authored Stripe MCP entry is rejected rather than replacing
or disabling this connection. The adapter snapshots the combined authored and
plugin config and restores it before every turn, including resume.

OpenCode receipts use `installation: opencode-bundle` instead of
`native_plugin_id`. They retain the selected catalog identity and commit, record
`source: {kind: git-subdir, commit, path}` with path `providers/claude/plugin`, and
fingerprint the copied bundle plus generated config. The native Claude/Codex
receipt shape is unchanged. Like other plugin state, bundle files remain writable
during interaction; the receipt describes installation-time contents.

## Hook policy and writable state

Codex plugin installation and interaction share the run-owned `CODEX_HOME`.
Before installation and every initial or resumed turn, Forge filters its
`config.toml` to validated native marketplace/plugin settings, project trust,
hook enablement/review state, and Forge-declared MCP servers. Each
`mcp_servers` entry must be exactly a `url` and a `bearer_token_env_var`.
Forge rejects inline tokens, static or environment headers, other server
settings, and URLs with userinfo, a query string, or a fragment. This lets
Codex load enabled skills, hooks, and MCP configuration without inheriting
user-level provider or authentication settings. Changes to plugin enablement
remain effective on subsequent turns; a declared MCP server stays configured
independently of plugin enablement. Codex's recorded workspace trust is
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
3. installs through the agent's native CLI, or copies the bundle for OpenCode;
4. validates the plugin identity, version, path, source provenance, and native
   load status where applicable;
5. configures the bundled MCP connection and fingerprints the installed tree
   (Codex fingerprints first, before Forge moves the connection out of the
   bundle); and
6. records a receipt in `setup.json`.

The receipt includes:

- the resolved marketplace and native plugin selection;
- the exact catalog commit used to read the marketplace entry;
- the native plugin ID or bundle installation kind, and installed version;
- the selected source kind and installer-reported Git commit when available;
- a deterministic digest and size/count summary of the installed tree; and
- for Codex installs with MCP authentication, optional
  `mcp_configuration: codex-user-config` and `mcp_connections`. Together they
  mean Forge moved the bundled declarations into the run-owned user
  configuration, so `installed_tree` fingerprints the plugin before that move.
  `mcp_connections` lists the declared servers as `{name, url}`, sorted by name;
  a URL never carries userinfo, a query string, or a fragment, and no key or
  header value is recorded. Both fields appear together or not at all. Receipts
  without them keep their previous meaning and still read; older strict readers
  may reject receipts that carry them.

Forge bounds and validates the installed tree, rejecting symbolic links and
special entries. The tree fingerprint covers relative paths, directories, and
the exact regular-file bytes read at the fingerprint point in stable path order,
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
its bundled HTTP MCP connection and declares `STRIPE_API_KEY` for the agent.
The CLI requires an explicit grant to read the key. For a Claude Code experiment
using the default OpenAI Ava/judge models:

```sh
npx --no-install forge run --experiment ./experiment.yaml --output ./results \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
  --credential-env STRIPE_API_KEY
```

Export the selected host variables before starting the eval, using an Agent API
key for `STRIPE_API_KEY`. To read another host variable, replace the Stripe grant
with `--credential-env env:STRIPE_API_KEY=STRIPE_TEST_KEY`. Missing grants or
values fail before runtime allocation, without fallback to another variable.
Account or merchant provisioning remains external to Forge.
Embedding hosts resolve the opaque reference `env:STRIPE_API_KEY` through their
credential resolver. Ordinary validation and planning need neither grants nor
secret values. See the README for other
[credential grants](../README.md#requirements--credentials).

Forge keeps the bundled URL and unrelated plugin content. Claude and OpenCode use
Authorization header templates in the plugin's MCP configuration. Codex
re-materializes its plugin cache after startup, which discards edits to the
bundled `.mcp.json` and leaves the server on Codex's OAuth path. Forge therefore
moves each selected server out of the bundle into the run-owned Codex
`config.toml` as `[mcp_servers.<name>]` with `bearer_token_env_var`; the
plugin's skills and other content still load from the plugin.

The move carries only a transport `type`, the `url`, and an existing bearer
variable, which Forge replaces. Setup fails, before changing either file, when a
selected bundled server has anything else: `enabled`, `enabled_tools`,
`disabled_tools`, timeouts, static or environment headers, unknown fields, or a
URL with userinfo, a query string, or a fragment. Setup also fails when the
merged configuration would exceed the configuration size or entry limits, or
when `config.toml` already declares a different server of the same name; an
identical repeated declaration is accepted. A rejected move leaves the prior
`config.toml` and the bundle unchanged. All reference
`STRIPE_API_KEY` inside the runtime, so other tools invoked by the agent can
use the same key. Tokens reach only agent commands, never setup commands.
Runtime credential names and references are part of the Forge version; the host
variable name is not recorded in the plan.

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
