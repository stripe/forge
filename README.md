# Stripe Forge

Forge is a portable execution harness for reproducible coding-agent evaluations.
It loads a versioned dataset and experiment config, resolves one selection into
an ambient-free run plan, executes a one-shot or Ava-driven multi-turn session in
Docker, normalizes agent evidence to ATIF, evaluates checks and success
guidelines, and atomically commits a neutral local result.

> **v0.1 status:** the implemented end-to-end paths are one-shot and engine-owned
> Ava multi-turn Claude Code runs, with file checks, model-judged success
> guidelines, latest-marketplace Claude plugin treatments, ATIF v1.8 evidence,
> and local results. The public CLI supports
> direct Anthropic or an explicitly configured Anthropic Messages-compatible
> endpoint. See [Current limitations](#current-limitations) before authoring a
> benchmark.

## Requirements

- Node.js 22 or newer.
- A running Docker daemon and Docker CLI capable of building Linux images.
- `linux/amd64` or `linux/arm64`, selected explicitly by the experiment config.
- Network access to Docker Hub and npm when Forge first builds its runtime image.
- A `forge/plugin@1` treatment additionally needs HTTPS access to its GitHub
  marketplace and the source selected by the marketplace's current entry.
- The runtime image obtains Claude Code from npm; its use remains subject to
  Anthropic's applicable terms.
- Provider credentials for `forge run`: either `ANTHROPIC_API_KEY` for direct
  Anthropic, or `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` for an
  Anthropic Messages-compatible endpoint. The public CLI uses the selected
  credential for Claude Code and, when required by the plan, host-side Ava and
  judge completions. Validation and planning do not resolve it.
- Ava and guideline judging use strict structured outputs. The built-in
  Anthropic completion provider accepts Claude 4.5 or newer model identifiers.
- Enough Docker capacity for the experiment config's limits. Defaults are 4 GiB
  memory, 2 CPUs, and 512 processes.

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
└── experiment.yaml
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

This minimal quickstart uses one-shot interaction and deterministic file checks,
so it needs no harness completion models. A one-shot case supplies exactly one
of `task` or `initial_prompt`; this example uses `initial_prompt`. Multi-turn
cases and success guidelines are described in
[Multi-turn Ava and guideline judging](#multi-turn-ava-and-guideline-judging).

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

### 3. Experiment config

Create `quickstart/experiment.yaml`:

<!-- quickstart-experiment:start -->
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
<!-- quickstart-experiment:end -->

The experiment config independently pins the dataset identity and SHA-256 digest
of the raw `manifest.json` bytes. `forge.version` is an execution compatibility
pin, not a range: v0.1 refuses to run a plan for another harness version.

`models: {}` is intentional for this one-shot, checks-only case. An experiment
config must set `models.role_player` for every selected `multi_turn` case and
`models.judge` for every selected case with non-empty `success_guidelines`.
Those model coordinates select host-side completion providers; the agent model
remains independently selected in `matrix.agents`.

Use `linux/arm64` only when that is the benchmark's intentional, released
platform. Changing the platform, model, setup, resources, or any other
experiment config field creates a different experiment.

### 4. Validate, plan, and run

From `quickstart/`:

```sh
npx @stripe/forge@0.1.0 validate \
  --experiment ./experiment.yaml \
  --dataset ./dataset
```

`validate` verifies schemas, the complete manifest inventory and hashes,
dataset/experiment identity, all matrix references, setup inputs, and every
resolvable matrix selection. It also constructs the selected composition and
runs pure agent, setup, and completion-provider compatibility preflight for
every resolved plan. It does not resolve credentials, invoke provider
preflight or completions, build or allocate Docker, or run setup.

Inspect the canonical resolved plan:

```sh
npx @stripe/forge@0.1.0 plan \
  --experiment ./experiment.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6
```

Run the single selection:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
npx @stripe/forge@0.1.0 run \
  --experiment ./experiment.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id hello-001
```

That command uses direct Anthropic when `ANTHROPIC_BASE_URL` is absent. To use
an Anthropic-compatible endpoint, keep the same experiment config and command
but set a valid endpoint URL and its token instead:

```sh
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
npx @stripe/forge@0.1.0 run \
  --experiment ./experiment.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id hello-001
```

When `ANTHROPIC_BASE_URL` is set, the CLI requires
`ANTHROPIC_AUTH_TOKEN` and does not select `ANTHROPIC_API_KEY`. Credentials and
the endpoint remain execution configuration; they do not belong in the case,
dataset manifest, or experiment config.

First-party setup actions may declare additional opaque credential references.
Bind each required reference to a host environment variable explicitly for the
run; pass the variable name, never its value:

```sh
STRIPE_MCP_TOKEN=your-restricted-token \
npx @stripe/forge@0.1.0 run \
  --experiment ./experiment.yaml \
  --dataset ./dataset \
  --credential-env stripe.mcp-token=STRIPE_MCP_TOKEN
```

The experiment and resolved plan contain only `stripe.mcp-token`. Forge resolves
only references required by the selected run, and the declaring capability
determines whether each value is exposed to setup commands or agent commands.
Unrelated host environment variables are never copied into the runtime.

`--case-file` discovers the nearest ancestor `manifest.json`, verifies the
dataset, and maps the exact regular file back to its declared case ID. The case
must still be present in the selected experiment config's matrix; this option
does not create a combined case/experiment format. Pass `--dataset` explicitly
when the manifest cannot be discovered.

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
`results/runs/hello-001/`. Every completed run contains:

```text
result.json
plan.json
setup.json
trajectory.json
interaction.json
```

Additional artifacts are emitted only when their capability is used:

```text
workspace-evidence.json            # one or more deterministic file checks
judge-evidence.json                # one or more guidelines judged
native/claude-code/session.jsonl   # exact selected Claude source session
extensions/<contributor-id>/...    # optional host-contributed artifacts
```

The checked-in quickstart includes `workspace-evidence.json` because its case
defines file checks. `result.json.evaluation` is the sole canonical evaluation
record; Forge does not write a duplicate `evaluation.json`.

`result.json` is the atomic commit marker and is not listed in its own artifact
array. Its `artifacts` and `supplemental_artifacts` arrays claim the media type,
size, and digest of every accompanying file. Forge quiesces the runtime, stages
the artifacts, disposes the runtime, then uses a directory rename as the atomic
completion boundary. Use
`verifyCompletedRun(location)` to re-read and verify a committed result. Result
schema version 1 records the evidence source and adapter provenance.

`plan.json` is the exact resolved execution plan. `setup.json` is the ordered
audit of applied setup actions. Static actions repeat only their plan index and
versioned `uses` ID; actions which resolve mutable inputs add a bounded
non-sensitive resolution. For `forge/plugin@1`, that resolution records the
marketplace commit, native plugin ID, resolved version and source identity, and
a digest of the installed plugin tree. `trajectory.json` is the full
selected, normalized, redacted ATIF audit trajectory. `interaction.json` is a
post-run driver audit record, not an execution input: it contains the public
agent turns, stop reason, and, for multi-turn runs, Ava's private need model and
decision history. It is not supplied to the guideline judge.

`workspace-evidence.json` contains bounded evidence for the paths inspected by
configured deterministic file checks; it is not a workspace snapshot.
`judge-evidence.json` exists only when judging ran and records the judge prompt
version and positive transcript-projection policy alongside the bounded
workspace text and warnings made available to the judge. These two evidence
artifacts have different scopes and are independently conditional.

Files below `extensions/<contributor-id>/` are optional supplemental artifacts
from registered `RunArtifactContributor`s. The `result.json` descriptors
independently identify all stored companion bytes.

The built-in Claude adapter retains only the exact root-session project JSONL
selected for the run. Forge copies those bytes without redaction, filtering,
normalization, or reserialization to
`native/<adapter-id>/session.jsonl`, including when ATIF normalization falls
back. This restricted supplemental artifact may contain credentials, prompts,
private reasoning, tool payloads, file contents, or other sensitive data. It is
written mode `0600` by the local store, never supplied to a judge, and never
affects scoring. Its descriptor sets `sensitivity: restricted`; custom stores
and caller-owned publishers must preserve appropriate access controls. The
normalized, credential-redacted `trajectory.json` remains the canonical
portable evidence.

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

## Dataset, experiment config, and plan boundaries

Forge deliberately separates what is evaluated from how it is run:

- The dataset contains cases and fixture bytes. Stable case IDs are independent
  of the dataset's location on disk.
- A case owns the prompt, invariant setup, checks, and success guidelines.
- An experiment config pins one dataset and defines treatments, agents, models,
  resources, limits, repetitions, retries, and the experiment matrix.
- A run selection chooses one case, treatment, agent, and repetition.
- `resolveRunPlan` applies defaults and emits the complete immutable input for
  one execution. The plan records dataset, case, experiment, and Forge
  provenance.

YAML and JSON inputs use strict schemas: unknown fields, unsafe names,
non-canonical paths, unsupported Forge action versions, and oversized values are
rejected. YAML parsing additionally rejects duplicate keys. Defaults are
materialized in the resolved plan rather than inferred by the runtime.

## Multi-turn Ava and guideline judging

A multi-turn case describes the developer's goal and optional background while
leaving the agent, role-player model, and judge model in the experiment config:

```yaml
schema_version: 1
id: examples/design-review
task: Work with the coding assistant to finish the requested design.
context: You are a developer maintaining this project.
execution_mode: multi_turn
max_turns: 6
setup: []
success_guidelines:
  - The assistant implements the requested behavior and explains the tradeoff.
checks: {}
example_answer: A concise reference answer used only to calibrate the judge.
```

`task` is required for `multi_turn`; `context` and `initial_prompt` are
optional. `max_turns` defaults to 10 and is capped at 100. When an
`initial_prompt` is present, Forge sends it verbatim as the first user turn,
then Ava initializes after the coding agent responds. Otherwise Ava generates
the opening turn.

The corresponding experiment config declares explicit host-side models:

```yaml
models:
  role_player:
    provider: anthropic
    model: claude-sonnet-4-6
  judge:
    provider: anthropic
    model: claude-sonnet-4-6
```

`models.role_player` is required exactly when a selected case is multi-turn.
`models.judge` is required exactly when a selected case has one or more success
guidelines. Unused model settings are not copied into checks-only, one-shot
plans. The experiment config's model providers must match entries in the
composition's `completionProviders`; the public CLI registers the built-in
`anthropic` provider.

### Ava interaction semantics

Ava is Forge's engine-owned role player. It privately derives up to six
high-level needs, each described in at most 240 characters, from the case task
and context. It pursues one need at a time with messages of at most 500
characters and never sends that private model to the coding agent. Every agent
turn uses the same persistent `AgentSession`. After each response, including
the final allowed response, Ava reassesses the remaining needs.

The interaction ends with one of three recorded stop reasons:

- `task_complete` when Ava reports no remaining needs;
- `max_turns` when Ava has assessed the final allowed agent response but needs
  remain; or
- `role_player_error` when Ava cannot obtain valid structured output.

Each Ava decision gets up to three completion attempts, with fixed one-second
and five-second waits after the first two failures. Exhaustion is committed as
a `role_player_error` result rather than aborting the run. If the failure occurs
before any agent turn, Forge emits a system-only fallback ATIF trajectory and a
null agent session ID; otherwise it preserves the completed session evidence.
The result and `interaction.json` record bounded failure details, while
`result.json` records safe per-call provider, model, usage, cost, stop, and error
summaries without prompts, responses, endpoints, or credentials.

### Guideline semantics

After the runtime is quiesced and agent evidence is normalized and redacted,
Forge judges every authored success guideline independently. It derives a
deterministic positive projection of current-run root ATIF behavior. The
allowlist contains root user and agent step identity, source, and messages;
tool-call IDs, names, and arguments; and tool-result content and
error status. Tool results without a source-call ID remain visible; correlation
is retained when the source provides it. An exact boolean
`observation.results[].extra.is_error` is promoted to the explicit
judge-visible `is_error`; all other result `extra` fields are excluded. System
steps and steps marked
`is_copied_context` are excluded,
as are reasoning, timestamps, model/provider metadata, metrics, arbitrary
`extra`, and subagent references or trajectories. Agent steps with no nonempty
text or media and no retained tool behavior are omitted rather than exposing
provider-specific hidden-call segmentation.

Opaque tool arguments and result content remain intact after credential
redaction, including nested keys named `reasoning_content`: tool behavior is
observable evidence, not private model reasoning. Subagent work is visible only
when it is surfaced in a root message or tool result, or in separately selected
workspace evidence. ATIF image and audio content parts retain their media type
and path references, but the completion transport is text-only: Forge does not
load or attach those referenced bytes as multimodal judge input.

The judge sees this projection, optional `example_answer`, and relevant bounded
text from the sealed workspace. It never sees `interaction.json`, Ava's private
needs, or the excluded ATIF data, and the prompt tells it not to infer or reward
private reasoning. Each authored guideline is capped at 65,536 characters,
matching the persisted evaluation-result bound. Projected transcript JSON is
capped at 786,432 UTF-8 bytes and receives the same bounded-JSON graph preflight
as ATIF before recursive validation. The complete rendered prompt is capped at
1,048,576 UTF-8 bytes before any completion provider is invoked.

`trajectory.json` remains the full selected, normalized, redacted audit
trajectory; it can retain normative reasoning fields even though those fields
are excluded from judging.

Programmatic consumers can reproduce the exact judge transcript bytes and
policy with `createJudgeTranscriptProjection` from `@stripe/forge`. The exported
projection ID, version, source, and positive included-field policy describe the
policy recorded in `judge-evidence.json`. The public `judgeGuidelines` helper
accepts this validated projection object rather than an arbitrary transcript
string, so callers cannot accidentally bypass the projection policy.

At most four guidelines are judged concurrently, with temperature 0, a
1,024-token response limit, and a strict one-guideline JSON schema.

Each guideline gets up to three attempts with the same one-second and
five-second retry waits. Repeated malformed structured output fails that
guideline closed and records it as not passed. If the provider request itself
still fails on the final attempt, execution aborts, runtime cleanup runs, and no
completed result is committed.

Judge workspace collection skips symlinks, agent state, dependency and build
directories, lockfiles, and common binary formats. Hard bounds are 10,000
listed entries, depth 32, two seconds, 512,000 bytes read, 20,000 characters per
file, and 80,000 rendered characters total. Truncation and unavailable files
are explicit evidence warnings. `judge-evidence.json` records the redacted
workspace subset and positive allowlist policy for the transcript projection
sent to the judge. It is an audit artifact, not an input to a later judge call.
`verifyCompletedRun` verifies the existing artifact descriptors, strict ATIF
trajectory, completed-turn coverage, and projection-policy declaration. Forge
refuses to dispatch a judge request if its final defensive
credential-redaction pass would rewrite the selected prompt evidence.

The numeric score remains the fraction of success guidelines that passed.
Deterministic checks are evaluated as additional pass/fail constraints. A
checks-only passing run retains numeric score `0`.

After adding the case to the manifest and updating its exact size and hashes,
use the same `forge validate`, `forge plan`, and `forge run` selection flow as
the quickstart.

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
credentials. The command action itself declares no credentials and runs with
Forge's uncredentialed command projection; use a typed setup action for an
operation that requires a credential.

`forge/plugin@1` installs the selected agent's complete native plugin from the
marketplace's current default-branch entry. Each agent branch states the native
identity and GitHub marketplace repository slug:

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

Forge registers the current marketplace through Claude's native CLI, validates
the selected entry, and installs it with user scope in the isolated run home.
The marketplace decides
the plugin source and resolved version. The action rejects authored `version`,
`marketplace.commit`, and `source` fields: identical plans can intentionally
install different releases on different dates.

Claude uses its normal `~/.claude/plugins` directory, original marketplace and
plugin identities, and native user settings. Plugin files, settings, and hook
data remain writable during interaction, matching normal plugin use. Each run
has its own home and plugin state. Plugin setup does not require a container
restart or forced session settings. The `setup.json` receipt identifies the
contents at installation time; it does not attest that those contents remained
unchanged during the run. Claude or the agent may edit, disable, update, or
install plugins under the runtime's ordinary permissions and network policy.

Forge installs the whole plugin—including skills, commands, hooks, and MCP
configuration—not only its skills. A remote endpoint
such as `mcp.stripe.com` remains a rolling external dependency. See
[Marketplace plugin treatments](docs/plugin-action.md) for the exact “latest”
semantics, verification, retained `setup.json` resolution, and current
limitations.

### Setup action bundles

Embedding hosts may supply trusted setup actions without adding their names or
implementations to this package. A bundle owns one non-reserved namespace and
is imported by host code before an immutable engine is constructed. YAML never
names a JavaScript package to download or import. The bundle may be an ordinary
module colocated with the embedding eval runner; it does not need to be
published as a separate package.

```js
import {
  createForgeEngine,
  defineSetupActionBundle,
} from '@stripe/forge';

const actions = defineSetupActionBundle({
  manifest: {
    namespace: 'acme-evals',
    version: '1.0.0',
    sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  actions: [{
    uses: 'acme-evals/tool@1',
    parseWith(input) {
      if (typeof input?.name !== 'string') throw new TypeError('invalid tool');
      return {name: input.name};
    },
    preflight(step) {
      return {
        requirements: {},
        async apply(context) {
          await context.commands.run(['install-tool', step.with.name]);
        },
      };
    },
  }],
});

const engine = createForgeEngine({setupActionBundles: [actions]});
```

An experiment which uses the action pins the same namespace, version, and
implementation digest under `forge.action_bundles`. The selected resolved plan
and `result.json` contain only bundles actually used by that run. A missing or
mismatched bundle fails before credentials resolve or a runtime is allocated.

The `forge` and `stripe` action namespaces remain reserved for implementations
shipped by this package. Bundles execute trusted host code in the Forge process,
but their `parseWith`, `preflight`, credential declarations, and `apply`
operations retain the same validation and least-privilege lifecycle as built-in
actions. `parseWith` must produce a stable canonical value: Forge proves its
output is a fixed point during authoring and rejects any resolved plan that the
parser would transform. An `apply` implementation may return bounded,
non-sensitive JSON describing execution-time resolution; Forge snapshots it in
`setup.json`. See
[Setup action bundles](docs/setup-action-bundles.md) for the full contract and
release boundary.

## Programmatic API

All root APIs use ESM:

```js
import {
  createArtifactStore,
  createDirectoryRunInputProvider,
  createEnvironmentCredentialResolver,
  executeEval,
  expandExperiment,
  loadExperimentConfig,
  loadDataset,
  resolveRunPlan,
} from '@stripe/forge';
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';
import {createDockerRuntimeAdapter} from '@stripe/forge/runtime/docker';

const [dataset, experiment] = await Promise.all([
  loadDataset('./dataset'),
  loadExperimentConfig('./experiment.yaml'),
]);
const selections = expandExperiment(experiment);
if (selections.length !== 1) throw new Error('Choose exactly one selection');

const plan = resolveRunPlan({dataset, experiment, selection: selections[0]});
const claude = createClaudeCodeAdapter();
const completed = await executeEval({
  runId: 'hello-001',
  plan,
  composition: {
    runtime: createDockerRuntimeAdapter(),
    agents: new Map([[claude.id, claude]]),
    credentialResolver: createEnvironmentCredentialResolver({
      bindings: {'anthropic.api-key': 'ANTHROPIC_API_KEY'},
    }),
    inputProvider: await createDirectoryRunInputProvider(dataset.root),
    artifactStore: createArtifactStore({root: './results'}),
  },
});

console.log(completed.location);
```

### Completion providers

An `AgentAdapter` and a `CompletionProvider` have intentionally different
authority. The agent adapter drives the selected coding agent inside the
runtime, maintains its session, and collects run-owned evidence. A completion
provider makes host-side text/structured-output calls for Forge-owned
score-affecting behavior: currently Ava (`role_player`) and success-guideline
judging (`judge`). It does not receive a workspace, run commands, own the Ava
state machine, or replace the selected coding agent.

`CompletionProvider.requirements()` is a pure declaration evaluated during
composition preflight. On `run`, Forge resolves only those declared credential
references, calls the provider's optional credential-aware `preflight()`, then
invokes `complete()` with a provider-neutral model, purpose, system prompt,
message history, strict response schema, and abort signal. Prompts are redacted
before dispatch, responses are redacted before parsing or persistence, and only
safe call summaries enter `result.json`.

Register providers by ID, or provide a `CompletionProviderResolver` when model
routing needs more than a map:

```js
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '@stripe/forge';
import {createAnthropicCompletionProvider} from '@stripe/forge/providers/anthropic';

const anthropicCompletions = createAnthropicCompletionProvider({
  credential: credentialReference('anthropic.api-key'),
});

const credentialResolver = createEnvironmentCredentialResolver({
  bindings: {'anthropic.api-key': 'ANTHROPIC_API_KEY'},
});

const completionProviders = new Map([
  [anthropicCompletions.id, anthropicCompletions],
]);
```

Pass `completionProviders` and `credentialResolver` in `ForgeComposition`.
The `provider` in `models.role_player` or `models.judge` must match the resolved
provider's `id`. The field is optional only when the plan needs neither Ava nor
guideline judging.

### Anthropic-compatible endpoints

The built-in completion provider is exported from
`@stripe/forge/providers/anthropic`. It uses Node.js 22's native `fetch`, calls
the Anthropic Messages API, supports strict JSON-schema output, and never reads
ambient credentials itself. A custom `baseUrl` selects a Messages-compatible
service root; Forge appends `/v1/messages`. HTTPS is required except for a
loopback development endpoint.

The public CLI selects its authentication mode from the environment. With no
`ANTHROPIC_BASE_URL`, Claude Code and host-side completions use direct Anthropic
and resolve `ANTHROPIC_API_KEY`. With `ANTHROPIC_BASE_URL`, both use that URL and
resolve `ANTHROPIC_AUTH_TOKEN` instead. Completed result metadata records the
gateway variant as Claude adapter version `2+gateway` and completion-provider
version `1+messages-compatible`, without adding endpoint or token fields;
direct runs record Claude adapter version `2` and completion-provider version
`1`.

Claude adapter version `2` uses native writable plugin installation and user
settings. Version `1` used a custom plugin seed and setup-sealed state.

A programmatic host makes the same choice explicitly on its agent adapter.
Declare the non-secret base URL and bind the token through an opaque credential
reference:

```js
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '@stripe/forge';
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';
import {createAnthropicCompletionProvider} from '@stripe/forge/providers/anthropic';

const gatewayBaseUrl = process.env.ANTHROPIC_BASE_URL;
if (!gatewayBaseUrl) throw new Error('ANTHROPIC_BASE_URL is required');

const gatewayClaude = createClaudeCodeAdapter({
  id: 'claude-code-gateway',
  provider: 'anthropic-compatible',
  baseUrl: gatewayBaseUrl,
  credential: credentialReference('anthropic.gateway-token'),
  credentialEnvironmentName: 'ANTHROPIC_AUTH_TOKEN',
});

const gatewayCompletions = createAnthropicCompletionProvider({
  id: 'anthropic-compatible',
  baseUrl: gatewayBaseUrl,
  auth: 'bearer',
  credential: credentialReference('anthropic.gateway-token'),
});

const credentialResolver = createEnvironmentCredentialResolver({
  bindings: {
    'anthropic.gateway-token': 'ANTHROPIC_AUTH_TOKEN',
  },
});
```

Register `gatewayClaude`, `gatewayCompletions`, and `credentialResolver` in the
`ForgeComposition` passed to `executeEval`, and select matching experiment
coordinates. The agent selection uses the adapter, while any harness models use
the completion provider:

```yaml
models:
  role_player:
    provider: anthropic-compatible
    model: claude-sonnet-4-6
  judge:
    provider: anthropic-compatible
    model: claude-sonnet-4-6
matrix:
  agents:
    - adapter: claude-code-gateway
      provider: anthropic-compatible
      model: claude-sonnet-4-6
```

The gateway must implement the Anthropic APIs expected by Claude Code and the
provider's `/v1/messages` requests, including structured output. If it also
requires a private CA, special proxying, custom mounts, or network allowlisting,
supply a custom `RuntimeAdapter`; those are runtime concerns and are not
inferred from the host environment. The URL must be reachable from both the
host process and inside the evaluation container: a loopback URL points at the
container when used by Claude Code. Keep gateway tokens out of cases, experiment
configs, plans, logs, and result metadata.

CommonJS applications can use the standard asynchronous bridge:

```js
async function loadForge() {
  return import('@stripe/forge');
}
```

### Public entry points

| Entry point | Purpose |
| --- | --- |
| `@stripe/forge` | Schemas, loaders, planning, execution, evaluation, results, setup, and composition contracts |
| `@stripe/forge/atif` | Current ATIF parser, serializer, normalization types, and constants |
| `@stripe/forge/atif/v1.8` | Explicitly versioned ATIF v1.8 surface |
| `@stripe/forge/cli` | CLI runner and injectable composition seam for host-owned wrappers |
| `@stripe/forge/agents/claude-code` | Claude Code adapter, stream parser, and evidence loader |
| `@stripe/forge/providers/anthropic` | Direct Anthropic and Messages-compatible host completion provider |
| `@stripe/forge/runtime/docker` | Forge Docker adapter and pinned runtime metadata |
| `@stripe/forge/setup` | Built-in handlers plus action-bundle and setup-executor contracts |
| `@stripe/forge/testing` | In-memory inputs/workspaces/stores, fake runtime and agent adapters, scripted completion providers, test plans, and runtime conformance checks |

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
- The same exact selected root JSONL is retained byte-for-byte as a restricted
  supplemental artifact under `native/`. Forge does not crawl or retain sibling
  sessions or subagent traces.
- Structurally valid Claude attachment records with one or more
  string-valued `rendered[].content` entries are preserved as ATIF system steps
  in native order. The exact rendered text and timestamp are retained, while
  `extra` identifies the
  native record and attachment types. These system steps remain excluded from
  guideline judging. Empty session-context bookkeeping is ignored; prompt
  snapshots remain in the restricted native source and produce a partial-detail
  warning until their per-call semantics can be normalized faithfully.
- Forge accepts that native candidate only when it identifies the selected
  session and structurally covers the completed driver ledger: the same number
  of logical turns, the same ordered user prompts, and visible response or tool
  activity for each completed response. Native assistant text and tool payloads
  need not be byte-identical because live and persisted protocols are lossy
  projections of the same turn.
- If native evidence is absent, invalid, oversized, incomplete, or compacted,
  or fails that structural reconciliation, Forge discards the entire native
  candidate, constructs ATIF from every completed driver turn, and records
  `completeness: fallback` plus normalization warnings in `result.json`.
  Driver fallback preserves every ordered user prompt and a visible response
  marker for every completed invocation, but it may deterministically truncate
  assistant text, tool calls, or tool arguments to stay inside ATIF safety
  limits. Such loss adds a `value_omitted` warning. Evaluation consumes that
  exact bounded trajectory, and guideline judging consumes it through the
  declared positive root-behavior projection.
- If Ava exhausts its retries before the first agent turn, Forge instead writes
  a system-only fallback trajectory with `role_player_error` provenance.
- Known non-conversation metadata is ignored explicitly. Unknown conversation
  records, attachments without renderable or explicitly classified content,
  unknown content blocks, sidechains, and compaction make the native candidate
  incomplete and trigger whole-trajectory fallback. Loss of optional detail
  such as an invalid timestamp remains an explicit partial-evidence warning.
- Result schema v1 records the normalization source kind, native format, source
  session, and adapter identity for every completed agent interaction. Forge
  rejects adapter evidence which omits or contradicts the selected session.
- `verifyCompletedRun` independently parses `trajectory.json` and applies the
  same session and completed-turn coverage checks before trusting a committed
  result.
- Exact credential values are redacted before normalized evidence and ordinary
  result artifacts are staged. The explicitly restricted native source artifact
  is an unredacted exception.
- The full selected, redacted trajectory remains the canonical audit artifact.
  Guideline judging uses a separately defined positive projection of
  current-run root user/agent messages and tool behavior.

For example, a Claude `environment` attachment whose rendered content is
`<system-reminder>workspace: /workspace</system-reminder>` becomes:

```json
{
  "step_id": 2,
  "source": "system",
  "message": "<system-reminder>workspace: /workspace</system-reminder>",
  "extra": {
    "native_record_type": "attachment",
    "attachment_type": "environment"
  }
}
```

Use the versioned surface when consuming stored artifacts:

```js
import {
  ATIF_SCHEMA_VERSION,
  parseAtifTrajectory,
  serializeAtifTrajectory,
} from '@stripe/forge/atif/v1.8';
```

## Adapters and private compositions

`executeEval` owns lifecycle semantics. A host supplies environment mechanisms
through one `ForgeComposition`; Forge never discovers plugins or private
services globally. Setup semantics are selected separately when a host creates
an immutable `ForgeEngine` with explicitly imported action bundles.
The setup preflight, first-party action, and credential-lifecycle design is
documented in
[Agent-aware setup and credential contracts](docs/agent-aware-setup-and-credentials.md).
The composition contains:

- a `RuntimeAdapter`;
- an ID-to-`AgentAdapter` map;
- a `CredentialResolver` and read-only `RunInputProvider`;
- a transactional `RunArtifactStore`;
- optional completion providers, one observer, and artifact contributors.

Completion providers may be a read-only ID map or a
`CompletionProviderResolver`. Forge selects them from the explicit
`models.role_player` and `models.judge` coordinates in the resolved plan.
Providers declare their own opaque credential references by purpose and receive
resolved values only for their host-side calls; those values are never placed
in the runtime environment unless an agent or setup capability independently
declares the same reference.

Adapters declare executable, credential-reference, and logical state-directory
requirements before allocation. Credential values stay resolver-owned and do
not enter experiment configs, plans, events, or result records. Runtimes expose
distinct mutable and sealed capabilities; evidence collection receives only the
sealed workspace and run-owned agent state.

An adapter may expose the narrow `AgentPluginInstaller` capability used by the
public `forge/plugin@1` action. Its preflight is pure: it binds one selected
distribution and declares executables plus state directories. Installation then
receives only that step's state and command projection. A state requirement can
set `sealAfterSetup`; Forge calls `PreparedRuntime.finalizeSetup()` after every
setup operation and before opening the agent session. The Docker adapter
enforces that boundary by replacing the setup container with an interaction
container whose selected state mounts are read-only.

Forge assigns concrete credential scope from the declaration surface. Handlers
identify lifecycle purpose through fixed setup and agent collections; they
cannot attach raw scope metadata. Environment declarations are strict,
JSON-like objects: arrays, explicit `null`, unknown fields, and extra credential
binding fields fail pure preflight rather than being discarded. For example,
an agent requirement is automatically assigned agent scope:

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

An agent adapter's pure `evidenceIdentity()` method declares the coding-agent
name and version to record if Forge must build fallback ATIF. After quiescence,
`collectEvidence()` may return only an exact-session native candidate or an
explicit unavailable reason. The engine validates and reconciles that candidate
against its completed-turn ledger; adapters do not construct or select fallback
evidence themselves. An adapter must translate failure to read or normalize its
native source into an explicit unavailable reason. Malformed data labeled
`available` is an adapter contract violation and fails the run.

The built-in setup schemas and handlers are shipped by the exact installed
Forge version and do not belong in a host composition. The default engine
rejects unknown action IDs. An embedding host may create a separate engine with
explicit, manifest-backed action bundles, but no bundle can replace the meaning
of a first-party `forge/` or `stripe/` action.

A setup action's pure `parseWith` method turns authored input into a stable
canonical payload. Resolved-plan boundaries revalidate that payload but reject
any transformation. Its pure `preflight` method then binds the exact operation
applied later by the engine. Requirements distinguish setup-only and agent-only
credential references; actions never assign raw credential scopes or receive
resolved values directly. A prepared operation which declares no setup
credential receives only the uncredentialed command projection. A credentialed
operation receives exactly the setup environment names it declared, never
credentials required only by another operation.

Artifact contributors may add files only below
`extensions/<contributor-id>/`. They cannot replace canonical artifacts, and
Forge scans their output for resolved secret values. Observer failures are
isolated and never change the benchmark result. External publication is a
caller-owned post-commit step; the default composition writes only locally.
Publishers must explicitly account for descriptors marked
`sensitivity: restricted` rather than assuming every committed artifact is safe
to distribute.

This is the intended boundary for an embedding integration: depend on an exact
`@stripe/forge` version, implement public contracts, and construct one engine
and composition without overriding the shared lifecycle. Command-line wrappers
can import `runCli` from `@stripe/forge/cli` and provide both that engine and a
`compositionFactory`, preserving the public command grammar while selecting
host-owned semantics and capabilities.

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
- The experiment config selects an explicit Linux platform. Forge records both
  its runtime asset digest and Docker's immutable built image ID in the result
  metadata.
- Containers run as UID/GID `10001`, with a read-only root filesystem, all Linux
  capabilities dropped, `no-new-privileges`, bounded memory/CPU/processes,
  bounded commands, and run-owned workspace/home/state mounts.
- Forge never mounts the Docker socket into the evaluation container.
- Plugin installation uses an uncredentialed command projection and verifies
  the selected marketplace, native installation, dependencies, and filesystem
  entries before interaction. Plugin files, native settings, and hook data stay
  writable within the isolated run home. The receipt records installation-time
  provenance; plugin mutations during interaction are permitted and are not
  separately inventoried. All mutation is quiesced before evidence selection.
- Credentials require explicit opaque-reference-to-host-environment mappings.
  Forge assigns secret values to setup or agent commands from the declaration
  source. Uncredentialed preparation commands receive neither scope. Docker
  passes secrets through short-lived mode-0600 environment files, not Docker
  argv or permanent container configuration.
- Completion providers separately declare credentials for each score-affecting
  purpose. Forge redacts all resolved secret values from completion prompts,
  responses, ATIF, interaction audit, judge evidence, and result metadata. The
  exact selected native agent log is deliberately retained unredacted as a
  restricted local artifact and may contain values the agent recorded.
- Workspace evidence is bounded and does not follow symlinks. Guideline judges
  receive only the separately bounded, redacted text subset and the
  visible transcript projection described above. Local artifacts are
  staged and claimed by digest before atomic commit.

Docker itself is a privileged host service. Anyone who can replace the Docker
binary, control the daemon, or modify the installed Forge code is already
outside the container trust boundary. Artifact contributors are ordinary host
JavaScript and must be trusted even though the capabilities Forge passes to
them are narrow.

The evaluated agent receives its selected provider credential and has outbound
network access. It can intentionally disclose that credential. Ava and judge
providers also receive benchmark prompts and the explicitly documented evidence
needed for their purpose. Use providers appropriate for the data, plus a
dedicated, restricted, short-lived key with appropriate account limits.
Exact-value redaction does not detect transformed, encoded, encrypted, or
partially leaked secrets. v0.1 does not provide domain allowlisting, a network
proxy, or an offline execution mode.

## Current limitations

- Multi-turn automation uses the fixed engine-owned Ava semantics. There is no
  alternate role-player engine, interactive human controller, or public
  conversation-policy plugin. Programmatic hosts may supply completion
  providers, but they cannot replace Ava's lifecycle from the composition.
- Success guidelines are model-judged pass/fail criteria. The deterministic
  built-in evaluator remains limited to file creation, file existence, and
  regular-expression content checks; there are no built-in test-command,
  static-analysis, or custom deterministic check plugins.
- Claude Code is the only built-in agent. Codex and Cursor adapters are not
  included.
- Anthropic is the only built-in completion provider. It supports direct
  Anthropic and Anthropic Messages-compatible endpoints and requires Claude
  4.5-or-newer model identifiers for strict structured output. OpenAI,
  OpenRouter-native, and other provider protocols are not included, though a
  programmatic composition can implement the public provider contract.
- Only the Forge-owned Docker image is accepted. Custom images, Dockerfiles,
  direct-process runtimes, interactive/human runs, and custom mounts are absent.
- `run` executes one selected matrix entry. There is no campaign scheduler,
  concurrency manager, or automatic run retry loop; `repetitions` create
  selectable entries and experiment-level `retries` is not acted on by the v0.1
  CLI. Ava and guideline completion attempts have their own fixed retry policy
  and do not implement the experiment config's campaign retry field.
- Built-in setup includes `forge/write@1`, `forge/command@1`, and Claude-backed
  `forge/plugin@1`. Plugin v1 installs the current entry from a public GitHub
  marketplace named as `owner/repository`. Exact plugin-version pins, remote
  MCP-service pins, private repository authentication, npm and command sources,
  plugin configuration, transitive plugin dependencies, and non-Claude native
  realizations are not included.
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

The repository has one live suite. It is separate from `pnpm test` and
`pnpm check` because it needs a running Docker daemon, may build the packaged
image, and makes several potentially billable model calls. Direct Anthropic
uses a dedicated API key:

```sh
FORGE_LIVE=1 \
ANTHROPIC_API_KEY=your-restricted-key \
pnpm test:live
```

An Anthropic Messages-compatible endpoint uses its URL and bearer token:

```sh
FORGE_LIVE=1 \
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
pnpm test:live
```

One invocation builds once and runs the following checks in order:

1. The real Docker adapter conformance probe, including sealing, cleanup, and
   idempotent disposal.
2. A credential-free install of the latest Stripe Claude plugin through the
   current marketplace, followed by verification of writable plugin files,
   native settings, and hook data, with the same container retained after setup.
3. The checked-in one-shot quickstart, which must pass its deterministic checks
   without calling a host completion provider.
4. The checked-in multi-turn example, which must exercise at least two turns in
   one persistent Claude session and pass both deterministic checks and model
   judging.
5. Full `verifyCompletedRun` integrity verification plus targeted checks of the
   interaction, trajectory, judge evidence, completion calls, and session
   provenance, including the exact restricted Claude source artifact.

When `ANTHROPIC_BASE_URL` names a host-loopback endpoint, the live suite creates
an ephemeral authenticated bridge for Claude Code in Docker. The container sees
only a one-run bridge credential; the real gateway token remains in the host
process and host-side completions call the original endpoint directly. The
bridge exposes no general proxy and is removed during cleanup. This convenience
belongs only to the repository live suite; the public `forge run` command still
requires its configured endpoint to be reachable from the container. The
loopback bridge requires a Docker implementation which provides
`host.docker.internal`, such as Docker Desktop, and fails its connectivity
preflight before making model calls when that route is unavailable.

Results remain under `results/live` by default. `FORGE_LIVE_RUN_ID` selects the
suite ID used as the prefix for its four run IDs,
`FORGE_LIVE_RESULTS_ROOT` selects another results directory,
`FORGE_LIVE_TIMEOUT_MS` sets the overall positive millisecond timeout (30
minutes by default), and `FORGE_DOCKER_EXECUTABLE` selects another Docker CLI.
The final report contains bounded result summaries but never prints endpoints,
prompts, responses, or credentials.

The package smoke test installs the packed tarball into an isolated consumer and
checks every documented ESM subpath plus CommonJS dynamic import. Forge is
licensed under Apache-2.0; ATIF provenance and third-party attribution are
recorded in `src/atif/UPSTREAM.md`, `src/atif/NOTICE.md`, and `NOTICE`.
