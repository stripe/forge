# Marketplace plugin treatments

## Purpose

`forge/plugin` installs a registered plugin through the selected agent's native
installer. Forge owns the distribution mapping; experiments evaluate the plugin
currently published by its GitHub marketplace.

The action's schema and lifecycle are public Forge behavior. Agent-specific
commands stay behind the narrow `AgentPluginInstaller` capability, implemented
by the built-in Claude Code and Codex adapters.

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
2. Forge registers the selected marketplace through the agent's native CLI.
3. The marketplace entry selects the plugin source and installed version.
4. Forge validates the native installation and records its IDs, version,
   catalog commit, source commit when reported, and installed-content fingerprint.
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
3. installs through the agent's native CLI;
4. validates the native plugin identity, version, path, load status, and source
   provenance;
5. configures the bundled MCP connection; and
6. fingerprints the configured installation and records a receipt in `setup.json`.

The receipt includes:

- the resolved marketplace and native plugin selection;
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
the native installer. Claude must report any source commit pinned by its
catalog; Codex reports the requested selectors, as described above. The tree
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

Forge keeps the bundled URL and unrelated plugin content. Claude uses an
Authorization header template; Codex uses `bearer_token_env_var`. Both reference
`STRIPE_API_KEY` inside the runtime, so other tools invoked by the agent can
use the same key. Tokens reach only agent commands, never setup commands.
Forge fingerprints the configured installation. Runtime credential names and
references are part of the Forge version; the host variable name is not recorded
in the plan.

A missing server, non-HTTP transport, manifest MCP override, or unsupported auth
source fails setup. Custom MCP config paths, OAuth, and host login passthrough
are unsupported.

Plugin installation receives an uncredentialed setup command runner. Fetches
therefore work only for credential-free HTTPS sources accepted by the installer.

Current limitations are:

- native source support differs between Claude Code and Codex;
- marketplace and plugin versions resolve at execution time;
- installed state remains writable during interaction;
- remote services referenced by a plugin are not pinned;
- plugin dependencies are unsupported; and
- private repositories, authenticated archives, and user-defined plugin
  options are unsupported.
