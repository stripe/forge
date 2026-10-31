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
   catalog commit, distribution path, available source commit, and installed-content
   fingerprint.
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
npm, `github` source objects, and dependencies. Codex receipts record the full
source pin when supplied, or the catalog commit for a marketplace-relative
source. An unpinned remote source has no recorded commit. This records the
selected revision; the installed-tree fingerprint identifies observed bytes.

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
with OAuth disabled. Its URL and bearer token select the run-owned host relay.
The adapter combines this fragment with the model definition
from the experiment's agent `model_profile` and restores it before every turn,
including resume. A workspace `opencode.json` is ignored; model declarations
belong to the agent selection, and skills/MCP come from `forge/plugin`. See the
[OpenCode setup](../README.md#opencode-setup) for a baseline/plugin comparison.

OpenCode receipts use `installation: opencode-bundle` instead of
`native_plugin_id`. They retain the selected catalog identity and commit, record
`source: {kind: git-subdir, commit, path}` for the actual standard bundle, and
fingerprint the copied bundle before adding the generated config. `dropped_parts` lists
`hooks`, `commands`, and `agents`: these behavior kinds are excluded by the
OpenCode distribution policy. This is a policy record, not a count of removed
files; unsupported declarations still fail setup. Native Claude/Codex receipts
omit this field because Forge does not inspect their exclusion policies. Like
other plugin state, bundle files remain writable during interaction; the receipt
describes installation-time contents.

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
installer, and declares executable and state requirements. The engine declares
the host relay credential separately from command credentials.
During setup, the prepared operation:

1. registers the marketplace;
2. validates the catalog and selected source;
3. installs through the agent's native CLI, or materializes OpenCode's standard bundle;
4. validates the plugin identity, version, path, source provenance, and native
   load status where applicable;
5. fingerprints the installed tree before Forge changes the bundled MCP
   connection; and
6. points that connection at the run's host relay and records a receipt in `setup.json`.

The receipt includes:

- the resolved marketplace and native plugin selection;
- the exact catalog commit used to read the marketplace entry;
- the native plugin ID or bundle installation kind, and installed version;
- the selected source kind, distribution path in `source.path` (`.` for a source
  root), and reported Git commit or full source pin when available;
- inspected policy exclusions in optional `dropped_parts`: absence means not
  inspected, `[]` means inspected with no excluded kinds, and a nonempty list
  names excluded behavior kinds;
- a deterministic digest and size/count summary of the installed tree; and
- for Codex installs with MCP authentication, optional
  `mcp_configuration: codex-user-config` and `mcp_connections`. Together they
  mean Forge moved the bundled declarations into the run-owned user
  configuration, so `installed_tree` fingerprints the plugin before that move.
  `mcp_connections` lists the servers as `{name, url}`, sorted by name, with
  the upstream endpoint rather than the run's relay address;
  a URL never carries userinfo, a query string, or a fragment, and no key or
  header value is recorded. Both fields appear together or not at all. Receipts
  without them keep their previous meaning and still read; older strict readers
  may reject receipts that carry them.

Forge bounds and validates the installed tree, rejecting symbolic links and
special entries. The tree fingerprint covers relative paths, directories, and
the exact regular-file bytes read after installation, before relay configuration, in stable path
order, independent of the adapter's listing order. It lets runs compare installed
contents even when the plugin version or reported source commit is unchanged.

Git commits identify the catalog snapshot and the available source revision. Claude must report any source commit pinned by its
catalog; Codex records the selected source pin; OpenCode verifies the checked-out
source commit. The tree fingerprint identifies observed installation-time
contents separately from those source identities.

New eval results copy built-in plugin receipts to `plugin_installations` in setup
order. An empty array means no built-in plugin was installed; an absent field
means it was not recorded. Completed-run verification requires this copy, when
present, to match `setup.json`. Old receipts may omit `source.path` and
`dropped_parts`; readers retain that absence rather than guessing.

Reports compare each treatment's ordered installation set across its saved runs,
including regraded, reused, checks-only, and saved errored runs. Identity includes
plugin and marketplace names, version, source kind/path/commit, the entire
`installed_tree` descriptor (format, hash, entry/file counts, bytes), and the
set of `dropped_parts`. Native adapter/plugin IDs and the catalog commit are
excluded. Installation count and setup order always participate when receipts
are recorded. Missing receipt arrays yield `unknown` unless a known difference
exists. At each installation position, a field absent from every run is skipped;
a field present in only some runs yields `unknown` unless a known difference
exists. Thus identical native installations can be `same` on their recorded
fields without asserting that their exclusion policies were inspected.

Each comparison's optional `compared_fields` records the basis as entries with
`installation_index` (zero-based setup order) and `fields`. The field names are
`plugin`, `marketplace`, `version`, `source.kind`, `source.path`, `source.commit`,
`installed_tree`, and `dropped_parts`. A field is listed when at least one run
records it at that position; uniformly absent fields are omitted. `installed_tree`
compares the complete descriptor. An empty basis covers either an empty recorded
installation set or unrecorded receipts, distinguished by the status and run
rows. Old comparisons can omit the basis; readers recompute it from run rows.

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

Forge checks that the bundled server names the fixed Stripe MCP endpoint, then
replaces that connection with a run-owned relay URL and a random bearer token.
The relay runs in the Forge host process, outside the container. It forwards
only to `https://mcp.stripe.com/`, replaces client authorization with the host
key, and rejects redirects, other paths, and methods other than GET, POST, or
DELETE. The key never enters the command environment or generated config.
Declaring the same key name or credential reference for command environments
in a plugin run fails pure preflight, as does declaring the reserved relay-token
variable `FORGE_STRIPE_MCP_RELAY_TOKEN`.

The relay starts before setup and survives setup-container replacement. Abort,
quiescence, and disposal close it and cancel in-flight requests. Its token has
no authority after shutdown. Forge redacts relay tokens from ordinary artifacts;
restricted native logs can still contain them. Installation hashes cover native
plugin content before relay configuration. OpenCode hashes the copied bundle
before adding its generated config. Relay URLs and tokens do not affect these
hashes; changes to bundle content still do.

Claude Code and OpenCode carry the relay URL and token in their native MCP
configuration. Codex re-materializes its plugin cache after startup, which
discards edits to the bundled `.mcp.json` and leaves the server on Codex's OAuth
path. Forge therefore moves each selected server out of the bundle into the
run-owned Codex `config.toml` as `[mcp_servers.<name>]`, with the relay URL and
`bearer_token_env_var = "FORGE_STRIPE_MCP_RELAY_TOKEN"`. The runtime exposes the
per-run relay token under that name to commands inside the container; the file
holds no token and no upstream key. The plugin's skills and other content still
load from the plugin.

The Codex move carries only a transport `type`, the `url`, and an existing
bearer variable, which Forge replaces. Setup fails, before changing either file,
when a selected bundled server has anything else: `enabled`, `enabled_tools`,
`disabled_tools`, timeouts, static or environment headers, unknown fields, or a
URL with userinfo, a query string, or a fragment. Setup also fails when the
merged configuration would exceed the configuration size or entry limits, or
when `config.toml` already declares a different server of the same name; an
identical repeated declaration is accepted. A rejected move leaves the prior
`config.toml` and the bundle unchanged. The declared URL is the run's loopback
or bridge relay address, which passes the same endpoint rule as any other
declaration. The receipt's `mcp_connections` records the bundled upstream
endpoint, not that address, so receipts do not vary with the relay's random port.

Docker's default network uses `host.docker.internal`. Native Linux inspects the
default bridge's IPv4 gateway, binds the relay to that address, and adds an
explicit `--add-host` mapping to the same address. A missing or ambiguous gateway
fails preparation; there is no wildcard listener fallback. This alias also
names other host services bound to the bridge gateway. Forge does not isolate
those services from the container. Docker Desktop supplies its host DNS and
the relay binds loopback. With `runtime.network: host`, both the listener and
client URL use loopback.
Forge appends the relay host to `NO_PROXY` and `no_proxy`, preserving existing
entries. The relay does not restrict general network egress: the selected Docker
network and other proxy settings stay unchanged. Agents can still browse docs
and use unauthenticated CLIs and tools; only the plugin key moves to the host.
A local Docker daemon
and a container-reachable host are required; remote daemons are unsupported for
this treatment. Host networking retains Docker's platform requirements.

Relay bounds are defined by `McpCredentialRelayLimits` and
`DEFAULT_MCP_CREDENTIAL_RELAY_LIMITS`, exported from `@stripe/forge/runtime/docker`.
Embedding hosts can override them through `DockerRuntimeAdapterOptions.mcpRelayLimits`.
Defaults allow eight active requests, 32 authenticated sockets, 1 MiB request
bodies, and 16 MiB streamed responses. Four pending unauthenticated sockets have
a separate one-second authentication window; newer connections evict the oldest
pending socket. Unauthenticated requests do not enter saved counts.

The default idle limit is 60 seconds. Request-body bytes, upstream response
headers, and response-body bytes reset it. A stream may outlive that limit while
bytes arrive; run abort remains the outer bound. A stalled request or stream
closes when idle time expires, including when the upstream ignores cancellation.
Native client reconnection after idle closure needs live validation.
Only MCP transport headers are forwarded. Runs that commit a result record
authenticated request and error counts as `runtime.metadata.pluginMcpRequests`
and `pluginMcpErrors`, plus the resolved limits as canonical JSON in
`pluginMcpLimits`. Counts include discovery and authenticated rejections.
`pluginMcpToolCalls` holds canonical JSON with `tools` (tool name to call count),
`other`, `unparsed`, and `overflow`. The relay reads only `method` and
`params.name` from the already-bounded request body. Each `tools/call` in a batch
counts separately, before forwarding; failed upstream calls still count.
Other RPC methods do not add tool counts. Body-less GET/DELETE requests do not
add tool observations. Requests rejected before body collection add no tool counts.

Tool names must be 1–128 characters from `[A-Za-z0-9_.-]`; unsafe or missing
names count under `other`, as do names containing the host key or relay token.
At most 64 distinct names are retained per run;
calls to further names count under `overflow`, while known names keep counting.
Safe names such as `other` remain distinct from the bucket. Malformed JSON or
UTF-8, empty batches, and malformed message entries count under `unparsed`.
Counting never rejects a request. No arguments, results, or bodies are retained.
These observation bounds are fixed by the Forge version, separately from
transport limits.

Failed attempts without a committed result retain no counts on this lifecycle.
Older results may omit these keys. Writes are not blocked while tool use is
being observed. Analysis can classify reads and writes from names; Forge has
no hard-coded write list. A later tool policy may block writes.

Custom runtimes must opt into `supportsMcpCredentialRelay`, honor
`RuntimeRequirements.mcpRelays`, and keep `RuntimePreparation.mcpRelayCredentials`
host-only. They return `pluginMcpConnections` for setup and own relay shutdown.
Direct installer callers supply these connections through
`AgentPluginInstallContext`. Unsupported runtimes fail before credential lookup.
The `forge/plugin` setup handler declares executable and state requirements;
it does not declare an agent credential. Hosts that discover credentials from
setup requirements must instead honor the engine's `RuntimeRequirements.mcpRelays`
and resolve the separate host-only credential inputs. The Docker adapter's
`hostPlatform` option controls host routing and defaults to the process platform;
it is separate from the container's target architecture.

Use `forge validate --host --experiment …` to install setup and check native MCP
initialization and tool discovery from a disposable runtime. It requires the
Stripe key, makes no model or MCP tool calls, and reports model auth as
untested. Codex requires exactly one Forge-declared server of that name (no
plugin identity), bearer auth, server information, and a nonempty tool map. This check does not prove that `codex exec` exposes those
tools to its model. Eval runs do not perform a separate discovery probe; their
saved results can report native dispatch refusals as described in the
[artifact contract](architecture.md).
Ordinary `validate` remains credential-free.

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
