# Stripe Forge

Forge is a portable execution harness for reproducible coding-agent evaluations.
It loads a versioned dataset and benchmark profile, resolves one selection into
an ambient-free run plan, executes the plan in Docker, normalizes agent evidence
to ATIF, evaluates the workspace, and atomically commits a neutral local result.

> **v0.1 status:** the implemented end-to-end path is one-shot Claude Code with
> direct Anthropic or explicitly configured Anthropic-compatible endpoint
> credentials, the Forge-owned Docker image, file checks, ATIF v1.8 evidence,
> and local results. See [Current limitations](#current-limitations) before
> authoring a benchmark.

## Requirements

- Node.js 22 or newer.
- A running Docker daemon and Docker CLI capable of building Linux images.
- `linux/amd64` or `linux/arm64`, selected explicitly by the benchmark profile.
- Network access to Docker Hub and npm when Forge first builds its runtime image.
- The runtime image obtains Claude Code from npm; its use remains subject to
  Anthropic's applicable terms.
- Provider credentials for `forge run`: either `ANTHROPIC_API_KEY` for direct
  Anthropic, or `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` for an
  Anthropic-compatible endpoint. Validation and planning do not resolve them.
- Enough Docker capacity for the profile's limits. Defaults are 4 GiB memory,
  2 CPUs, and 512 processes.

Forge is ESM-only. Install the exact harness version named by the benchmark:

```sh
npm install --save-dev --save-exact @stripe/forge@0.1.0
```

From a source checkout, use the pinned package manager:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

## Quick start

Create this layout:

```text
quickstart/
├── dataset/
│   ├── manifest.json
│   └── cases/
│       └── examples/
│           └── hello-file.yaml
└── profile.yaml
```

The hashes below are for the exact UTF-8 file contents shown, including the
final newline. Dataset payload bytes must exactly match their manifest entries.

### 1. Eval case

Create `quickstart/dataset/cases/examples/hello-file.yaml`:

<!-- quickstart-case:start -->
```yaml
schema_version: 1
id: examples/hello-file
display_name: Hello file
initial_prompt: Create hello.txt containing exactly "hello, forge!" followed by a newline.
execution_mode: one_shot
setup: []
success_guidelines: []
checks:
  files_created:
    - hello.txt
  file_checks:
    - file: hello.txt
      exists: true
      contains: '^hello, forge!\n?$'
```
<!-- quickstart-case:end -->

An executable v0.1 case must use `execution_mode: one_shot` and must leave
`success_guidelines` empty. A one-shot case supplies exactly one of `task` or
`initial_prompt`; this example uses `initial_prompt`.

### 2. Dataset manifest

Create `quickstart/dataset/manifest.json`:

<!-- quickstart-manifest:start -->
```json
{
  "schema_version": 1,
  "dataset": {
    "id": "forge-quickstart",
    "version": "0.1.0"
  },
  "cases": [
    {
      "id": "examples/hello-file",
      "path": "cases/examples/hello-file.yaml"
    }
  ],
  "files": [
    {
      "path": "cases/examples/hello-file.yaml",
      "size": 350,
      "sha256": "3debb427a8120d54dc9e4a68590996bdc9945e4c25d225c98c2d821e51339017"
    }
  ]
}
```
<!-- quickstart-manifest:end -->

`files` is an exact inventory of every regular payload file below `dataset/`;
do not include `manifest.json` itself. Extra, missing, modified, symbolic-link,
or special-file payloads make the dataset invalid.

### 3. Benchmark profile

Create `quickstart/profile.yaml`:

<!-- quickstart-profile:start -->
```yaml
schema_version: 1
id: examples/quickstart
version: 0.1.0
dataset:
  id: forge-quickstart
  version: 0.1.0
  manifest_sha256: sha256:2d75e3a65ff5c3b6c9612a572f078e6dd496c0b63007cf3c6e6da94c62fcd4e0
forge:
  version: 0.1.0
runtime:
  adapter: docker
  image:
    kind: forge
  platform: linux/amd64
  resources:
    memory_bytes: 4294967296
    cpu_count: 2
    process_count: 512
models: {}
treatments:
  baseline:
    setup: []
matrix:
  cases:
    - examples/hello-file
  treatments:
    - baseline
  agents:
    - adapter: claude-code
      provider: anthropic
      model: claude-sonnet-4-6
  repetitions: 1
  retries: 0
limits:
  run_timeout_ms: 900000
```
<!-- quickstart-profile:end -->

The profile independently pins the dataset identity and the SHA-256 digest of
the raw `manifest.json` bytes. `forge.version` is an execution compatibility
pin, not a range: v0.1 refuses to run a plan for another harness version.

Use `linux/arm64` only when that is the benchmark's intentional, released
platform. Changing the platform, model, setup, resources, or any other profile
field creates a different experiment.

### 4. Validate, plan, and run

From `quickstart/`:

```sh
npx @stripe/forge@0.1.0 validate \
  --profile ./profile.yaml \
  --dataset ./dataset
```

`validate` verifies schemas, the complete manifest inventory and hashes,
dataset/profile identity, all matrix references, setup inputs, and every
resolvable matrix selection. It does not build Docker or resolve credentials.

Inspect the canonical resolved plan:

```sh
npx @stripe/forge@0.1.0 plan \
  --profile ./profile.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6
```

Run the single selection:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
npx @stripe/forge@0.1.0 run \
  --profile ./profile.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id hello-001
```

That command uses direct Anthropic when `ANTHROPIC_BASE_URL` is absent. To use
an Anthropic-compatible endpoint, keep the same profile and command but set a
valid endpoint URL and its token instead:

```sh
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
npx @stripe/forge@0.1.0 run \
  --profile ./profile.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id hello-001
```

When `ANTHROPIC_BASE_URL` is set, the CLI requires
`ANTHROPIC_AUTH_TOKEN` and does not select `ANTHROPIC_API_KEY`. Credentials and
the endpoint remain execution configuration; they do not belong in the case,
dataset manifest, or profile.

`--case-file` discovers the nearest ancestor `manifest.json`, verifies the
dataset, and maps the exact regular file back to its declared case ID. The case
must still be present in the selected profile's matrix; this option does not
create a combined case/profile format. Pass `--dataset` explicitly when the
manifest cannot be discovered.

The CLI requires one unambiguous matrix entry. For a larger matrix, add any
needed selectors (`--case` and `--case-file` are mutually exclusive):

```text
--case <case-id>
--treatment <treatment-id>
--agent <adapter-id>
--provider <provider-id>
--model <model-id>
--repetition <zero-based-index>
```

`run` prints a JSON summary after commit. The completed run is stored at
`results/runs/hello-001/` and contains:

```text
result.json
plan.json
trajectory.json
workspace-evidence.json
evaluation.json
```

`result.json` claims the size and digest of every accompanying artifact. Forge
quiesces the runtime, stages the artifacts, disposes the runtime, then uses a
directory rename as the atomic completion boundary. Use
`verifyCompletedRun(location)` to re-read and verify a committed result. Result
schema version 1 records the evidence source and adapter provenance.

For native Claude evidence, the result contains an evidence descriptor like:

```json
{
  "format": "atif",
  "schema_version": "ATIF-v1.8",
  "normalization_version": 1,
  "provenance": {
    "source": {
      "kind": "native_log",
      "format": "claude-code-jsonl",
      "session_id": "session-123"
    },
    "adapter": {"id": "claude-code", "version": "1"}
  },
  "completeness": "complete",
  "warnings": [],
  "redaction_count": 0
}
```

## Dataset, profile, and plan boundaries

Forge deliberately separates what is evaluated from how it is run:

- The dataset contains cases and fixture bytes. Stable case IDs are independent
  of the dataset's location on disk.
- A case owns the prompt, invariant setup, checks, and future guideline rules.
- A profile pins one dataset and defines treatments, agents, models, resources,
  limits, repetitions, retries, and the experiment matrix.
- A run selection chooses one case, treatment, agent, and repetition.
- `resolveRunPlan` applies defaults and emits the complete immutable input for
  one execution. The plan records dataset, case, profile, and Forge provenance.

YAML and JSON inputs use strict schemas: unknown fields, unsafe names,
non-canonical paths, unsupported Forge action versions, and oversized values are
rejected. YAML parsing additionally rejects duplicate keys. Defaults are
materialized in the resolved plan rather than inferred by the runtime.

### Built-in setup actions

Case setup runs first, followed by the selected treatment setup. Actions execute
in source order.

`forge/write@1` writes inline UTF-8 content or a manifest-listed dataset file to
a workspace-relative target:

```yaml
setup:
  - uses: forge/write@1
    with:
      target: seed.txt
      source:
        content: "seed data\n"
  - uses: forge/write@1
    with:
      target: config/example.json
      source:
        dataset_path: fixtures/example.json
```

`forge/command@1` executes an argv vector without implicit shell parsing:

```yaml
setup:
  - uses: forge/command@1
    with:
      argv: [npm, test]
      cwd: .
      timeout_ms: 120000
```

To request shell semantics, select the shell explicitly, for example
`argv: [sh, -lc, "printf ready > status.txt"]`. Setup failures stop the run.
Captured command output is not attached to setup errors because it may contain
credentials.

## Programmatic API

All root APIs use ESM:

```js
import {
  createArtifactStore,
  createDirectoryRunInputProvider,
  createEnvironmentCredentialResolver,
  executeEval,
  expandExperiment,
  forgeSetupHandlers,
  loadBenchmarkProfile,
  loadDataset,
  resolveRunPlan,
} from '@stripe/forge';
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';
import {createDockerRuntimeAdapter} from '@stripe/forge/runtime/docker';

const [dataset, profile] = await Promise.all([
  loadDataset('./dataset'),
  loadBenchmarkProfile('./profile.yaml'),
]);
const selections = expandExperiment(profile);
if (selections.length !== 1) throw new Error('Choose exactly one selection');

const plan = resolveRunPlan({dataset, profile, selection: selections[0]});
const claude = createClaudeCodeAdapter();
const completed = await executeEval({
  runId: 'hello-001',
  plan,
  composition: {
    runtime: createDockerRuntimeAdapter(),
    agents: new Map([[claude.id, claude]]),
    setupHandlers: forgeSetupHandlers,
    credentialResolver: createEnvironmentCredentialResolver({
      bindings: {'anthropic.api-key': 'ANTHROPIC_API_KEY'},
    }),
    inputProvider: await createDirectoryRunInputProvider(dataset.root),
    artifactStore: createArtifactStore({root: './results'}),
  },
});

console.log(completed.location);
```

### Anthropic-compatible endpoints

The public CLI selects its authentication mode from the environment. With no
`ANTHROPIC_BASE_URL`, it uses direct Anthropic and resolves
`ANTHROPIC_API_KEY`. With `ANTHROPIC_BASE_URL`, it passes that URL to Claude
Code and resolves `ANTHROPIC_AUTH_TOKEN` instead. Completed result metadata
records the gateway variant as Claude adapter version `1+gateway` without
adding endpoint or token fields; direct runs record adapter version `1`.

A programmatic host makes the same choice explicitly on its agent adapter.
Declare the non-secret base URL and bind the token through an opaque credential
reference:

```js
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '@stripe/forge';
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';

const gatewayBaseUrl = process.env.ANTHROPIC_BASE_URL;
if (!gatewayBaseUrl) throw new Error('ANTHROPIC_BASE_URL is required');

const gatewayClaude = createClaudeCodeAdapter({
  id: 'claude-code-gateway',
  provider: 'anthropic-compatible',
  baseUrl: gatewayBaseUrl,
  credential: credentialReference('anthropic.gateway-token'),
  credentialEnvironmentName: 'ANTHROPIC_AUTH_TOKEN',
});

const credentialResolver = createEnvironmentCredentialResolver({
  bindings: {
    'anthropic.gateway-token': 'ANTHROPIC_AUTH_TOKEN',
  },
});
```

Register `gatewayClaude` and `credentialResolver` in the `ForgeComposition`
passed to `executeEval`, and select matching profile coordinates:

```yaml
adapter: claude-code-gateway
provider: anthropic-compatible
model: claude-sonnet-4-6
```

The gateway must implement the Anthropic API expected by Claude Code. If it
also requires a private CA, special proxying, custom mounts, or network
allowlisting, supply a custom `RuntimeAdapter`; those are runtime concerns and
are not inferred from the host environment. The URL must be reachable from
inside the evaluation container: a loopback URL points at the container, not a
gateway process running on the host. Keep gateway tokens out of cases, profiles,
plans, logs, and result metadata.

CommonJS applications can use the standard asynchronous bridge:

```js
async function loadForge() {
  return import('@stripe/forge');
}
```

### Public entry points

| Entry point | Purpose |
| --- | --- |
| `@stripe/forge` | Schemas, loaders, planning, execution, evaluation, results, setup, and extension contracts |
| `@stripe/forge/atif` | Current ATIF parser, serializer, normalization types, and constants |
| `@stripe/forge/atif/v1.8` | Explicitly versioned ATIF v1.8 surface |
| `@stripe/forge/cli` | CLI runner and injectable composition seam for host-owned wrappers |
| `@stripe/forge/agents/claude-code` | Claude Code adapter, stream parser, and evidence loader |
| `@stripe/forge/runtime/docker` | Forge Docker adapter and pinned runtime metadata |
| `@stripe/forge/setup` | Built-in setup handlers and setup executor |
| `@stripe/forge/testing` | In-memory inputs/workspaces/stores, fake runtime and agent adapters, test plans, and runtime conformance checks |

Only documented package exports are public. Do not import `dist/` files or
undeclared internal paths.

## ATIF evidence policy

Forge persists the canonical agent trajectory as a standalone
`trajectory.json` using Agent Trajectory Interchange Format `ATIF-v1.8`.

- The implementation is pinned to Harbor v0.23.0 commit
  `1e5c5c6db929a10a140d05e606882c671ae20729` and its ATIF RFC.
- `schema_version` is required and Forge validates exactly one ATIF version.
- Explicit JSON `null` is accepted and preserved where the pinned ATIF contract
  treats null and omission equivalently. Conditional multimodal fields still
  obey the RFC's requirement to be omitted when inapplicable.
- Agent-native evidence is read only after runtime quiescence.
- The Claude adapter selects the exact run-owned session JSONL. It does not use
  a newest-session heuristic.
- If native evidence is absent, invalid, oversized, incomplete, or compacted,
  Forge constructs ATIF from completed driver turns and records
  `completeness: fallback` plus normalization warnings in `result.json`.
- Unknown native events and omitted values produce explicit warnings rather
  than silently changing the wire format.
- Result schema v1 records the normalization source kind, native format, source
  session when available, and adapter identity. Forge rejects adapter evidence
  whose provenance contradicts the selected adapter or session.
- Exact credential values are redacted before evidence and results are staged.

Use the versioned surface when consuming stored artifacts:

```js
import {
  ATIF_SCHEMA_VERSION,
  parseAtifTrajectory,
  serializeAtifTrajectory,
} from '@stripe/forge/atif/v1.8';
```

## Extensions and private compositions

`executeEval` owns lifecycle semantics. A host supplies mechanisms through one
`ForgeComposition`; Forge never discovers plugins or private services globally.
The composition contains:

- a `RuntimeAdapter`;
- an ID-to-`AgentAdapter` map;
- an action-ID-to-`SetupStepHandler` map;
- a `CredentialResolver` and read-only `RunInputProvider`;
- a transactional `RunArtifactStore`;
- optional completion providers, one observer, and artifact contributors.

Adapters declare executable, credential-reference, and logical state-directory
requirements before allocation. Credential values stay resolver-owned and do
not enter profiles, plans, events, or result records. Runtimes expose distinct
mutable and sealed capabilities; evidence collection receives only the sealed
workspace and run-owned agent state.

Forge assigns credential scope from the capability which declares a reference;
extensions do not select their own scope. For example, an agent requirement is
automatically agent-scoped:

```ts
requirements() {
  return {
    executables: ['acme-agent'],
    environment: {
      credentials: {
        ACME_TOKEN: {
          reference: credentialReference('acme.agent-token'),
        },
      },
    },
    stateDirectories: [],
  };
}
```

The runtime receives separate command capabilities: `uncredentialed` contains
only explicit plain variables, `setup` adds setup-declared credentials, and
`agent` adds agent-declared credentials. Agent preparation receives only the
uncredentialed runner; an open agent session receives only the agent runner.
Neither agent phase receives runtime `quiesce()` or `dispose()` authority.
Evidence collection receives a separately projected, read-only runtime without
commands or cleanup authority. `executeEval` retains the original prepared
runtime and is the only component which quiesces and disposes it.

Custom setup action IDs must use `owner/action@<positive-version>`, for example
`acme/install-tool@1`. The `forge/` namespace is reserved, and built-in handlers
cannot be replaced. A handler may declare credential references in its pure
`requirements` method and receives only the selected workspace, setup command
runner, dataset inputs, run ID, and abort signal when executed.

```ts
import {
  credentialReference,
  type SetupStepHandler,
} from '@stripe/forge';

const installHandler: SetupStepHandler = {
  uses: 'acme/install@1',
  requirements() {
    return {
      credentials: {
        PACKAGE_TOKEN: {
          reference: credentialReference('acme.package-token'),
        },
      },
    };
  },
  async execute(step, context) {
    await context.commands.run(['acme-install', '--locked'], {
      signal: context.signal,
    });
  },
};
```

Here `PACKAGE_TOKEN` is available to the setup command but not to agent or
uncredentialed commands. If setup and an agent both need the same reference,
both capabilities must declare it independently; Forge validates that the
bindings agree before resolving the value.

Artifact contributors may add files only below
`extensions/<contributor-id>/`. They cannot replace canonical artifacts, and
Forge scans their output for resolved secret values. Observer failures are
isolated and never change the benchmark result. External publication is a
caller-owned post-commit step; the default composition writes only locally.

This is the intended boundary for a private integration: depend on an exact
`@stripe/forge` version, implement public contracts, and pass the resulting
composition to `executeEval`. Do not fork or override the shared lifecycle.
Private command-line wrappers can import `runCli` from `@stripe/forge/cli` and
provide a `compositionFactory`, preserving the public command grammar while
selecting host-owned capabilities.

## Security and reproducibility

- Datasets are exact-manifest, hash-verified trees. Forge rejects symbolic
  links, special files, traversal, undeclared payloads, and unsafe roots.
- The Docker build context contains only Forge's packaged Dockerfile and
  entrypoint. The Node base image is pinned by OCI digest and Claude Code is
  installed at exact version `2.1.273`.
- Debian packages and the Claude Code tarball are resolved from the configured
  registries when the image is built. Forge records the resulting immutable
  image ID; a future release should add stronger dependency-level integrity
  pins if byte-for-byte rebuilds are required across registry state changes.
- The profile selects an explicit Linux platform. Forge records both its runtime
  asset digest and Docker's immutable built image ID in the result metadata.
- Containers run as UID/GID `10001`, with a read-only root filesystem, all Linux
  capabilities dropped, `no-new-privileges`, bounded memory/CPU/processes,
  bounded commands, and run-owned workspace/home/state mounts.
- Forge never mounts the Docker socket into the evaluation container.
- Credentials require explicit opaque-reference-to-host-environment mappings.
  Forge assigns secret values to setup or agent commands from the declaration
  source. Uncredentialed preparation commands receive neither scope. Docker
  passes secrets through short-lived mode-0600 environment files, not Docker
  argv or permanent container configuration.
- Workspace evidence is bounded and does not follow symlinks. Local artifacts
  are staged and claimed by digest before atomic commit.

Docker itself is a privileged host service. Anyone who can replace the Docker
binary, control the daemon, or modify Forge extension code is already outside
the container trust boundary. Extension handlers and artifact contributors are
ordinary host JavaScript and must be trusted even though the capabilities Forge
passes to them are narrow.

The evaluated agent receives its selected provider credential and has outbound
network access. It can intentionally disclose that credential. Use a dedicated,
restricted, short-lived key with appropriate account limits. Exact-value
redaction does not detect transformed, encoded, encrypted, or partially leaked
secrets. v0.1 does not provide domain allowlisting, a network proxy, or an
offline execution mode.

## Current limitations

The schemas reserve forward-compatible concepts that v0.1 cannot yet execute:

- Only `one_shot` runs execute. Multi-turn conversations and role-player-driven
  interactions are not implemented.
- Success-guideline judging is not implemented; executable cases must use
  `success_guidelines: []`. Evaluation currently covers file creation, file
  existence, and regular-expression content checks.
- Claude Code is the only built-in agent. The CLI supports direct Anthropic or
  an explicitly configured Anthropic-compatible endpoint; programmatic
  compositions can add other provider and network behavior. Codex, Cursor,
  OpenAI, and OpenRouter integrations are not included.
- Only the Forge-owned Docker image is accepted. Custom images, Dockerfiles,
  direct-process runtimes, interactive/human runs, and custom mounts are absent.
- `run` executes one selected matrix entry. There is no campaign scheduler,
  concurrency manager, or automatic retry loop; `repetitions` create selectable
  entries and `retries` is not acted on by the v0.1 CLI.
- Built-in setup is limited to `forge/write@1` and `forge/command@1`.
- Results are local. There is no remote publisher, worker/control plane, hosted
  execution service, or human-result policy in the public package.
- Each CLI process asks Docker to build and verify the Forge image; Docker's
  content cache normally reuses prior layers. A cold cache still needs registry
  availability, and the host Docker implementation can affect build success.

## Development

The library and test suite compile with `tsc`; the repository does not require
a bundler or an `esbuild` install/build exception. Tests run on Node's built-in
test runner.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
```

### Opt-in live tests

Live tests are separate from `pnpm test` and `pnpm check`. They require a
running Docker daemon and may build the packaged Forge image.

Exercise the real Docker runtime lifecycle without credentials or a model call:

```sh
pnpm test:live:docker
```

This starts a container, writes and seals a workspace probe, checks cleanup and
idempotent disposal, and prints a conformance report. Set
`FORGE_LIVE_TIMEOUT_MS` to a positive millisecond timeout (the default is 20
minutes), or `FORGE_DOCKER_EXECUTABLE` to an alternate Docker CLI path.

The Claude quickstart makes a billable model-provider call and therefore always
requires an explicit acknowledgement. For direct Anthropic, supply its API
key:

```sh
FORGE_LIVE_CLAUDE=1 \
ANTHROPIC_API_KEY=your-restricted-key \
pnpm test:live:claude
```

To exercise an Anthropic-compatible endpoint, supply its URL and token instead:

```sh
FORGE_LIVE_CLAUDE=1 \
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
pnpm test:live:claude
```

It runs the checked-in quickstart selection with `claude-sonnet-4-6`, verifies
the committed result, requires a passing evaluation, and fails if evidence fell
back from the native Claude session. Results remain under `results/live` by
default. `FORGE_LIVE_RUN_ID` selects a run ID and `FORGE_LIVE_RESULTS_ROOT`
selects another results directory. Its report identifies only the selected
authentication mode; it never prints the endpoint or credential.

The package smoke test installs the packed tarball into an isolated consumer and
checks every documented ESM subpath plus CommonJS dynamic import. Forge is
licensed under Apache-2.0; ATIF provenance and third-party attribution are
recorded in `src/atif/UPSTREAM.md`, `src/atif/NOTICE.md`, and `NOTICE`.
