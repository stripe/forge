# Stripe Forge

Forge is a portable execution harness for reproducible coding-agent evaluations.
It loads a versioned dataset and experiment config, resolves one selection into
an ambient-free run plan, executes a one-shot or Ava-driven multi-turn session
through a runtime adapter, normalizes agent evidence to ATIF, evaluates checks and success
guidelines, and atomically commits a neutral local result.

In Forge, reproducible means that a completed run provides an auditable account
of its declared intent, material setup resolutions, selected interaction
evidence, and result. It does not mean that a networked, model-driven run can be
replayed byte-for-byte: model responses, websites, documentation, registries,
and other external systems may change independently. `plan.json` records what
Forge intended to run, while `setup.json` records bounded non-sensitive values
that setup resolved at execution time.

For a conceptual explanation of its boundaries, lifecycle, trust model, and
extension points, see [Forge architecture](docs/architecture.md). For a
file-by-file map and concrete call paths, see the
[Forge codebase guide](docs/codebase-guide.md).

> **v0.1 status:** the implemented end-to-end paths are one-shot and engine-owned
> Ava multi-turn Claude Code and Codex runs, with file checks, model-judged success
> guidelines, latest-marketplace Claude Code and Codex plugin treatments, ATIF v1.8 evidence,
> and local results. The public CLI supports
> direct Anthropic and OpenAI, or explicitly configured compatible endpoints.
> Host-side Ava and judging currently use Anthropic, independently of the coding
> agent. See [Current limitations](#current-limitations) before authoring a
> benchmark.

## Requirements

These requirements apply to the built-in Docker composition. Embedding hosts
can supply an external runtime with its own explicit execution requirements.

- Node.js 22 or newer.
- A running Docker daemon and Docker CLI capable of building Linux images.
- A Docker server using `linux/amd64` or `linux/arm64`. Experiments may select
  either explicitly or use `native` to target the Docker server architecture.
- Network access to Docker Hub and npm when Forge first builds its runtime image.
- A `forge/plugin` treatment additionally needs HTTPS access to its GitHub
  marketplace and the source selected by the marketplace's current entry.
- The runtime image obtains Claude Code and Codex from npm; their use remains
  subject to the respective providers' applicable terms.
- Provider credentials for `forge run`: either `ANTHROPIC_API_KEY` for direct
  Anthropic, or `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` for an
  Anthropic Messages-compatible endpoint. The public CLI uses the selected
  credential for Claude Code and, when required by the plan, host-side Ava and
  judge completions. Validation and planning do not resolve it.
- Codex runs require `CODEX_API_KEY`. Optional `OPENAI_BASE_URL` selects a
  Responses-compatible API root. A checks-only, one-shot Codex run needs no
  Anthropic credential; Codex runs using Ava or judging additionally need the
  independently configured host completion provider's credential.
- Ava and guideline judging use strict structured outputs. The built-in
  Anthropic completion provider accepts Claude 4.5 or newer model identifiers.
- Enough Docker capacity for the experiment config's limits. Defaults are 4 GiB
  memory, 2 CPUs, and 512 processes.

Forge is ESM-only. From the directory that will contain `quickstart/`, install
the current development snapshot with an exact dependency pin. The commands
below use this locally installed CLI:

```sh
npm install --save-dev --save-exact @stripe/forge@dev
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
  path: ./dataset
  id: forge-quickstart
  version: 0.1.0
  manifest_sha256: sha256:2d75e3a65ff5c3b6c9612a572f078e6dd496c0b63007cf3c6e6da94c62fcd4e0
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
of the raw `manifest.json` bytes. The installed Forge package version is not an
authored experiment field. Forge records it in each resolved plan and result;
execution rejects a serialized plan made by a different package version. To
run an older dataset with a newer Forge release, resolve a fresh plan with that
release. The dataset and experiment versions identify those inputs independently
of the Forge package version. `dataset.path` is a CLI location hint, resolved
relative to the experiment file; it is excluded from resolved plans and their
checksums. Programmatic hosts may omit it and supply a loaded dataset directly.

`models: {}` is intentional for this one-shot, checks-only case. An experiment
config must set `models.role_player` for every selected `multi_turn` case and
`models.judge` for every selected case with non-empty `success_guidelines`.
Those model coordinates select host-side completion providers; the agent model
remains independently selected in `matrix.agents`.

Use `platform: native` for portable local smoke tests. Forge asks the Docker
server for its architecture before `plan` or `run` and records the resulting
concrete `linux/amd64` or `linux/arm64` value in the resolved plan. Pin a concrete
platform when architecture is part of the benchmark definition. Changing a
pinned platform, model, setup, resources, or any other experiment config field
creates a different experiment.

### 4. Validate, plan, and run

From `quickstart/`:

```sh
npx --no-install forge validate \
  --experiment ./experiment.yaml
```

`validate` verifies schemas, the complete manifest inventory and hashes,
dataset/experiment identity, all matrix references, setup inputs, and every
resolvable matrix selection. It also constructs the selected composition and
runs pure agent, setup, and completion-provider compatibility preflight for
every resolved plan. It does not resolve credentials, invoke provider
preflight or completions, build or allocate Docker, or run setup.

For an authored `platform: native`, ordinary validation preflights both
supported concrete interpretations without contacting Docker. To additionally
check the current execution host, opt into host validation:

```sh
npx --no-install forge validate \
  --experiment ./experiment.yaml \
  --host
```

`--host` requires a reachable Linux Docker server, detects its architecture,
builds the selected Forge runtime image, verifies Docker returns an immutable
image ID, and executes a network-disabled disposable shell probe from that
image. A native experiment checks the detected platform; a pinned experiment
thereby also tests any required cross-architecture emulation. It does not
resolve credentials, run setup, or make model calls.

Inspect the canonical resolved plan:

```sh
npx --no-install forge plan \
  --experiment ./experiment.yaml \
  --case-file ./dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6
```

Run the single selection:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
npx --no-install forge run \
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
npx --no-install forge run \
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
MY_MCP_TOKEN=your-restricted-token \
npx --no-install forge run \
  --experiment ./experiment.yaml \
  --credential-env example.mcp-token=MY_MCP_TOKEN
```

The experiment and resolved plan contain only `example.mcp-token`. Forge resolves
only references required by the selected run, and the declaring capability
determines whether each value is exposed to setup commands or agent commands.
Unrelated host environment variables are never copied into the runtime.

The CLI locates the dataset through `dataset.path` in the experiment config,
resolved relative to the experiment file. It verifies the pinned identity and
manifest digest. `--case-file` maps an exact regular file within that configured
dataset to its declared case ID; the case must be in the experiment matrix.
`--case` and `--case-file` are mutually exclusive.

`run` executes every matching matrix combination. Selection options restrict
which cases, treatments, agents, and repetitions run. `plan` requires exactly
one matching combination:

```text
--case <case-id>
--treatment <treatment-id>
--agent <adapter-id>
--provider <provider-id>
--model <model-id>
--repetition <zero-based-index>
```

`run` prints its experiment execution ID in progress records and a final JSON
summary. The quickstart eval is stored at
`results/experiments/<experiment-run-id>/runs/hello-001/`. Every completed eval contains:

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
native/codex/session.jsonl         # exact selected Codex rollout, for Codex runs
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
The `plan.json` artifact descriptor is the stored plan checksum.

`plan.json` is the exact resolved execution plan. `setup.json` is the ordered
audit of applied setup actions. Static actions repeat only their plan index and
namespaced `uses` ID; actions which resolve mutable inputs add a bounded
non-sensitive resolution. For `forge/plugin`, that resolution records the
selected marketplace and plugin IDs, the catalog commit, native plugin ID,
installed version, source kind and reported Git commit when available, and a
fingerprint of the installed plugin tree. `trajectory.json` is the full
selected, normalized, redacted ATIF audit trajectory. `interaction.json` is a
post-run driver audit record, not an execution input: it contains the public
agent turns, stop reason, and, for multi-turn runs, Ava's private need model and
decision history. It is not supplied to the guideline judge.

This plan/receipt split is deliberate. The plan captures declared semantics;
the setup receipt captures material facts that become known only while setup is
running, such as the installed plugin version and source revision. Plugin
receipts identify the catalog and installation-time contents so runs can be
compared when a rolling dependency changes. They do not attest to final plugin
state or make an external dependency replayable. Credentials, private host
paths, and unrelated ambient state do not belong in either file.

`workspace-evidence.json` contains bounded evidence and exact base64-encoded
bytes for the paths inspected by configured deterministic file checks. Its
artifact checksum covers the whole file; entries do not carry separate digests.
`judge-evidence.json` exists only when judging ran. Schema version 1 records the
positive transcript-projection policy and the exact
reduced, redacted steps supplied to the judge at `transcript.steps`, alongside
the bounded workspace text and warnings. These two evidence artifacts have
different scopes and are independently conditional.

Files below `extensions/<contributor-id>/` are optional supplemental artifacts
from registered `RunArtifactContributor`s. The `result.json` descriptors
independently identify all stored companion bytes.

The built-in agents retain only the exact root-session JSONL selected for the
run: Claude's project log or Codex's rollout. Forge copies those bytes without redaction, filtering,
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
  "provenance": {
    "source": {
      "kind": "native_log",
      "format": "claude-code-jsonl",
      "session_id": "session-123"
    },
    "adapter": {"id": "claude-code", "version": "0.1.1-dev.0"}
  },
  "completeness": "complete",
  "warnings": [],
  "redaction_count": 0
}
```

### Running and resuming an experiment

Run the matrix declared by an experiment with:

```sh
npx --no-install forge run --experiment ./experiment.yaml
```

Every invocation without `--resume` starts a new experiment execution and
prints a generated `experiment_run_id`. The dataset location comes from
`dataset.path`; there is no `--dataset` or `--all` flag. Use `--case <case-id>` or
the other selection options to run a subset of the matrix.

`--jobs <count>` (or `-j <count>`) limits simultaneous evals; the default is 1.
For example, this executes up to four selections at a time and starts another
as soon as a slot is free:

```sh
npx --no-install forge run --experiment ./experiment.yaml --jobs 4
```

Each eval retains its own runtime, agent session, and artifacts. Size concurrency
for the host's memory/CPU capacity and provider rate limits; `--jobs` limits
evals, not individual provider requests. Each eval may also judge up to four
guidelines concurrently. Completion and progress records can arrive in any order.

Each execution has an independent checkpoint, scorecard, and eval artifacts:

```text
results/experiments/<experiment-run-id>/
├── campaign.json
├── report.json
└── runs/
    ├── <eval-run-id>/
    └── <another-eval-run-id>/
```

If an execution errors, Forge records the attempt and continues with the other
entries. To resume a specific execution, replace `EXPERIMENT_RUN_ID` below with
its printed ID:

```sh
npx --no-install forge run --experiment ./experiment.yaml --resume EXPERIMENT_RUN_ID
```

An ID is required: bare `--resume` is a usage error. If the same experiment was
run three times, each execution has a different ID and any of them can be
resumed independently. `--output <directory>` changes the base output directory;
resume must use the same underlying base directory, which may be accessed
through a symlink. Resume uses the saved selections,
including an original `--case` filter, so omit selection options on resume.
Concurrency is a scheduling choice, excluded from plan checksums. Resume can
use a different number of jobs:

```sh
npx --no-install forge run --experiment ./experiment.yaml --resume EXPERIMENT_RUN_ID --jobs 2
```

Resume verifies each completed run before skipping it and requires the same
resolved plans, including dataset pins, setup, models, runtime, and Forge
version. Missing or invalid artifacts are retried. Completed evaluations with
failed or partial scores remain completed; execution errors, including committed
`role_player_error` results, are retried. A run whose artifacts committed just
before interruption is recovered without rerunning it. Retries get fresh eval
IDs and preserve all earlier artifacts and attempt records.

Progress records go to stderr. The final JSON summary on stdout contains the
experiment execution ID, directory, checkpoint path, and total, executed,
skipped, completed, and errored counts, plus the `report` path. Exit code 1 means
execution errors remain or report generation failed; code 0 means every entry
completed and the report was saved, regardless of evaluation scores.
Each invocation attempts pending entries once; `matrix.retries` does not add
automatic attempts. Campaigns use the local artifact store and permit one
active process per execution. Cancellation stops new work, signals active evals,
and waits for their cleanup before releasing the checkpoint lock. A checkpoint
failure also cancels and drains active work; resume verifies any results committed
before interruption. `--run-id` can name an eval only when exactly one
combination is selected; it cannot be combined with resume.

`report.json` is the experiment's scorecard, automatically refreshed after each
run or resume invocation settles. `campaign.json` remains the execution
checkpoint with plan identities and attempt history; reports are derived from
verified eval artifacts and are never used to decide what to resume.
To view scores by case and configuration:

```sh
jq '.cases[] | {case_id, treatment, agent, completed, errored, pass_rate, guideline_score}' \
  results/experiments/EXPERIMENT_RUN_ID/report.json
```

The strict, schema-version-1 report contains:

| Field | Meaning |
| --- | --- |
| `experiment_run_id`, `generated_at`, `checkpoint_sha256` | Execution ID, UTC snapshot time, and SHA-256 of the exact checkpoint bytes used for this report. |
| `summary` | Statistics across every saved selection. |
| `cases` | Statistics grouped by case ID, treatment, and complete agent selection (including Codex hook trust), combining repetitions. Groups appear in first-selection order. |
| `runs` | One row per saved selection in original order: zero-based `selection_index`, full `selection`, latest `run_id`, effective `state`, stable `error_code`, `attempt_count`, relative `result_path`, and `evaluation`. |

Each statistics object counts `selections`, `completed`, `errored`, `pending`,
and completed evaluation statuses (`passed`, `partial`, `failed`).
`attempts_total` counts all attempts; `retry_attempts` counts attempts after the
first for each selection. Retries never add another selection or another score.
`coverage` is completed selections divided by all selections. `pass_rate` is
passed evaluations divided by completed evaluations, or `null` when none
completed. `guideline_score` contains the mean score and number of completed
evaluations with guidelines; its mean is `null` when that count is zero. Ratios
and scores range from 0 to 1. A checks-only evaluation can pass with raw score
0; it contributes to pass rate, but not the guideline mean.

Only the latest verified effective outcome for each selection contributes to
scores, using the same committed-result recovery as resume. Completed failed
or partial evaluations keep their scores. Execution errors, including committed
role-player failures, and pending entries have `evaluation: null`. Completed
rows retain status, score, guideline passed/total counts, and check passed/total
counts. `result_path` points to `runs/<eval-run-id>/result.json` relative to the
experiment directory when verified artifacts exist, including an errored
role-player result; otherwise it is `null`.

Execution errors still produce a partial scorecard. Graceful cancellation or a
coordinator failure attempts to save one after active evals drain. Reports are
atomically replaced while the campaign lock is held. They are snapshots, so an
active resume or a hard process kill can leave the previous report stale or
missing. A report write failure preserves committed evals and is surfaced on
normal completion; an existing execution or cancellation failure remains the
primary error. Rerun with `--resume EXPERIMENT_RUN_ID` to refresh a missing or
corrupt report while skipping valid completed evals. Report generation does not
make additional model calls.

## Running Codex

Codex uses the same cases, runtime contracts, checks, Ava controller, and result
verification as Claude Code. Select it in the experiment's agent matrix:

```yaml
matrix:
  agents:
    - adapter: codex
      provider: openai
      model: gpt-5.4
      hook_trust: native
```

The [checked-in Codex example](https://github.com/stripe/forge/blob/main/examples/codex/README.md) is a complete runnable
experiment using the quickstart dataset. From a source checkout:

```sh
pnpm build
node dist/cli.js validate \
  --experiment examples/codex/experiment.yaml

CODEX_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment examples/codex/experiment.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.yaml \
  --agent codex --model gpt-5.4 \
  --output ./results --run-id codex-001
```

The model is an explicit experiment choice, subject to provider availability.
Change it in the experiment when using another Codex-supported model.
Validation and planning require neither credentials nor Docker allocation;
`run` requires Docker and makes potentially billable model calls.

Forge pins Codex CLI `0.149.0` and checks the binary version before setup. Each
run receives an isolated `CODEX_HOME`. Forge uses `codex exec --json` for the
first turn and `codex exec resume <exact-session-id>` for later Ava turns; it
never resumes the newest ambient session. The adapter explicitly chooses its
provider, endpoint, and credential environment name. Before each turn, it
filters the run-owned `config.toml` to validated native marketplace/plugin
settings, project trust, and hook enablement/review state, then loads that file
so installed plugins and workspace hooks retain their state across turns.
Provider, login, and other user settings are removed. Forge does not mount a
developer's Codex state or login. Codex's own approvals and sandbox are disabled
inside the externally isolated runtime; a custom runtime must provide suitable
isolation itself. A prompt consisting solely of `-` is
rejected because Codex treats it as its stdin sentinel.

The CLI maps `openai.api-key` to host `CODEX_API_KEY`. Override the host binding
with `--credential-env openai.api-key=MY_KEY_VARIABLE` if needed. It does not
implicitly read `OPENAI_API_KEY`. Optional `OPENAI_BASE_URL` is the complete API
root (for example, `https://gateway.example.com/v1`), not a Chat Completions
endpoint; the service must support the Responses protocol used by Codex. Use
HTTPS for remote services. Endpoints must be reachable from inside the runtime.
The adapter version is the installed Forge package version.
`result.json.agent.metadata.endpoint_mode` records `default` or `custom`;
endpoint URLs and credentials are not added to results.

`hook_trust` belongs on the Codex entry in `matrix.agents`. It defaults to
`native`, which lets Codex enforce its normal hook review requirements. Set
`automation` when enabled hooks should run without review in the isolated
runtime. Forge then passes `--dangerously-bypass-hook-trust` on every initial
and resumed turn. This applies to all enabled hooks, including workspace hooks.
New resolved plans explicitly record the policy, and matrix identity and
report grouping distinguish it. Saved plans that omit the field use `native`.
Claude Code rejects this field and retains its native hook behavior.

Programmatic hosts import `createCodexAdapter` from
`@stripe/forge/agents/codex` and register it in `composition.agents`. Options
include explicit `id`, `provider`, `executable`, `expectedVersion`, `credential`,
`credentialEnvironmentName`, `baseUrl`, and `layout`. Changing the CLI version
requires validating its stream and rollout formats against the adapter. A
custom layout specifies `workspace`, `home`, and `configDirectory` (the
run-owned `CODEX_HOME`) just like the Claude layout below.
`result.json.agent.metadata.layout_mode` records `default` or `custom`.
No Docker-specific mechanism is required by the agent contract.

Codex is a coding-agent adapter, not a host completion provider. For a
multi-turn Codex experiment, still declare `models.role_player`; for success
guidelines, declare `models.judge`. The CLI currently supplies Anthropic for
those roles, or embedding hosts can supply their own `CompletionProvider`.
Codex implements `forge/plugin`; add a `codex` distribution branch to the
treatment. See [Marketplace plugin treatments](docs/plugin-action.md) for
native catalog selection, supported sources, and receipts.

See the official Codex [non-interactive guide](https://developers.openai.com/codex/noninteractive/)
and [CLI reference](https://developers.openai.com/codex/cli/reference/) for the
underlying CLI behavior.

## Dataset, experiment config, and plan boundaries

Forge deliberately separates what is evaluated from how it is run:

- The dataset contains cases and fixture bytes. Stable case IDs are independent
  of the dataset's location on disk.
- A case owns the prompt, invariant setup, checks, and success guidelines.
- An experiment config pins one dataset, locates it with `dataset.path` for CLI
  execution, and defines treatments, agents, models,
  resources, limits, repetitions, retries, and the experiment matrix.
- A run selection chooses one case, treatment, agent, and repetition.
- `resolveRunPlan` applies defaults and emits the complete immutable input for
  one execution. The plan records dataset, case, experiment, and Forge
  provenance.

YAML and JSON inputs use strict schemas: unknown fields, unsafe names,
non-canonical paths, unknown or version-suffixed setup actions, and oversized
values are rejected. YAML parsing additionally rejects duplicate keys.
Defaults are materialized in the resolved plan rather than inferred by the runtime.

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
projection ID, source, and positive included-field policy describe the
policy recorded in `judge-evidence.json`. Its `transcript.steps` array is decoded
directly from the same canonical transcript JSON passed to `judgeGuidelines`;
canonical serialization of that array reproduces the transcript bytes in every
guideline request. The public `judgeGuidelines` helper
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
workspace subset, positive allowlist policy, and projected transcript steps
sent to the judge. It is an audit artifact, not an input to a later judge call.
`verifyCompletedRun` verifies the artifact descriptors, strict ATIF trajectory,
completed-turn coverage, projection-policy declaration, and equality of the
embedded steps with the projection of `trajectory.json`. Embedded steps are
required; artifacts containing only the projection policy are rejected. The
artifact schema remains at 1; its contract includes the projection policy. Forge
refuses to dispatch a judge request if its final defensive
credential-redaction pass would rewrite the selected prompt evidence.

For a guideline-judged run named `judged-001`, inspect the actual reduced
transcript with:

```sh
jq '.transcript.steps' results/experiments/EXPERIMENT_RUN_ID/runs/judged-001/judge-evidence.json
```

The numeric score remains the fraction of success guidelines that passed.
Deterministic checks are evaluated as additional pass/fail constraints. A
checks-only passing run retains numeric score `0`.

After adding the case to the manifest and updating its exact size and hashes,
use the same `forge validate`, `forge plan`, and `forge run` selection flow as
the quickstart.

### Built-in setup actions

Case setup runs first, followed by the selected treatment setup. Actions execute
in source order. Action IDs use `namespace/name` without an individual version.
The exact installed Forge package or pinned host action bundle supplies their
meaning. An incompatible action change requires updating affected case files
and dataset manifests, or treatment setup and experiment configs.

`forge/write` writes inline UTF-8 content or a manifest-listed dataset file to
a workspace-relative target:

```yaml
setup:
  - uses: forge/write
    with:
      target: seed.txt
      source:
        content: "seed data\n"
  - uses: forge/write
    with:
      target: config/example.json
      source:
        dataset_path: fixtures/example.json
```

`forge/command` executes an argv vector without implicit shell parsing:

```yaml
setup:
  - uses: forge/command
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

`forge/plugin` installs the selected agent's complete native plugin from the
marketplace's current default-branch entry. Each agent branch states the native
identity and GitHub marketplace repository slug:

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
            codex:
              plugin: example-plugin@example-marketplace
              marketplace: example-org/example-marketplace
```

The marketplace and plugin names above are illustrative and must be replaced
with real identifiers.

Forge registers the current marketplace through the selected agent's native
CLI, validates the selected entry, and installs it in the isolated run home.
The marketplace decides
the plugin source and resolved version. The action rejects authored `version`,
`marketplace.commit`, and `source` fields: identical plans can intentionally
install different releases on different dates.

Claude uses its normal `~/.claude/plugins` directory and native user settings;
Codex uses its run-owned `CODEX_HOME` for both plugins and sessions. Both retain
the original marketplace and plugin identities. Plugin files, settings, and hook
data remain writable during interaction, matching normal plugin use. Each run
has its own home and plugin state. Plugin setup does not require a container
restart or forced session settings. The `setup.json` receipt identifies the
contents at installation time; it does not attest that those contents remained
unchanged during the run. The agent may edit, disable, update, or
install plugins under the runtime's ordinary permissions and network policy.

Forge installs the whole plugin—including skills, commands, hooks, and MCP
configuration—not only its skills. A remote endpoint
such as `mcp.example.com` remains a rolling external dependency. See
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

```js check
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
    uses: 'acme-evals/tool',
    parseWith(input) {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        typeof input.name !== 'string'
      ) {
        throw new TypeError('invalid tool');
      }
      return {name: input.name};
    },
    preflight(step) {
      return {
        requirements: {executables: ['install-tool']},
        async apply(context) {
          const result = await context.commands.run(
            ['install-tool', step.with.name],
            {signal: context.signal},
          );
          if (result.exitCode !== 0) throw new Error('tool installation failed');
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
`setup.json`. Actions should return every material non-sensitive value resolved
during setup that could explain a behavioral difference between runs, rather
than implying that a rolling external dependency was pinned by the plan. See
[Setup action bundles](docs/setup-action-bundles.md) for the full contract and
security model.

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
const composition = {
  runtime: createDockerRuntimeAdapter(),
  agents: new Map([[claude.id, claude]]),
  credentialResolver: createEnvironmentCredentialResolver({
    bindings: {'anthropic.api-key': 'ANTHROPIC_API_KEY'},
  }),
  inputProvider: await createDirectoryRunInputProvider(dataset.root, {
    manifest: dataset.manifest,
  }),
  artifactStore: createArtifactStore({root: './results'}),
};
const completed = await executeEval({
  runId: 'hello-001',
  plan,
  composition,
});

console.log(completed.location);
```

Pass the loaded manifest to the directory input provider to check the exact
bytes returned to setup against their declared sizes and hashes and enforce
the declared directory inventory. The public CLI enables these checks
automatically. A root-only provider supplies path-safe access without content
pinning.

When a programmatic host loads an experiment with `platform: native`, it must
materialize the Docker server platform before resolving the plan. The public
CLI does this automatically:

```js
import {detectDockerRuntimePlatform} from '@stripe/forge/runtime/docker';

const runtimePlatform = await detectDockerRuntimePlatform();
const plan = resolveRunPlan({
  dataset,
  experiment,
  selection: selections[0],
  runtimePlatform,
});
```

Hosts using a remote or wrapped Docker executable can pass the same executable
or an explicit host command runner to `detectDockerRuntimePlatform`.

### Experiment campaigns

Hosts can share the run loop through `@stripe/forge/campaign`. Reuse the loaded inputs and composition
above, choose an execution ID, resolve every selected plan, and point the local
artifact store at the campaign root:

```js
import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {defaultForgeEngine} from '@stripe/forge';
import {readCampaignSelections, runCampaign} from '@stripe/forge/campaign';

const engine = defaultForgeEngine; // Or the host's immutable custom engine.
const resumeId = undefined; // Set to an existing experiment execution ID to resume.
const experimentRunId = resumeId ?? randomUUID();
const root = path.resolve('results', 'experiments', experimentRunId);
const selected = resumeId === undefined
  ? expandExperiment(experiment)
  : await readCampaignSelections(root);
const plans = selected.map((selection) => engine.resolveRunPlan({
  dataset, experiment, selection,
  runtimePlatform: plan.runtime.platform,
}));
const summary = await runCampaign({
  root,
  plans,
  engine,
  composition: {...composition, artifactStore: createArtifactStore({root})},
  resume: resumeId !== undefined,
  jobs: 4,
  signal: new AbortController().signal,
  execute: (input) => engine.executeEval(input),
  runIdFactory: randomUUID,
  progress: (event) => console.error(event),
});
console.log(summary);
```

`runCampaign` preflights every plan with the supplied `engine` and `composition`
before writing checkpoints or invoking `execute`. The callback may acquire
per-run host resources and construct another composition before calling that
same engine. It must honor the supplied signal and finish cleanup in `finally`
before settling; its full lifetime occupies a job slot. The artifact store must
commit at `<root>/runs/<run-id>` so the campaign can verify results. Progress
callbacks are synchronous; throwing stops scheduling and cancels active work.
An optional synchronous `onOutcome(outcome, selectionIndex)` callback collects
bounded verified outcomes, including selections skipped on resume. Like progress,
throwing from this callback stops scheduling. `CampaignOptions`,
`CampaignProgressEvent`, `CampaignSummary`, and `CampaignOutcome` are exported
types from the same subpath.

Both `runCampaign` and `runCampaignCommand` automatically write the
[experiment scorecard](#running-and-resuming-an-experiment) under their selected
root and return its path as `summary.report`. `parseCampaignReport` validates
loaded report JSON, including agreement between run rows and aggregate
statistics. `CAMPAIGN_REPORT_SCHEMA_VERSION`, `CampaignReportV1`, and its
evaluation, run, statistics, and case types are exported from
`@stripe/forge/campaign`. A reporting failure after normal execution makes
`runCampaign` reject with `CampaignReportError`, which carries the report path
and original cause. `runCampaignCommand` wraps it in `CampaignCommandError` as
its cause, retaining the experiment reference. Saved evaluations remain
resumable.

For command hosts, `@stripe/forge/campaign/cli` adds a shared run/resume stage.
`runCampaignCommand` parses `--jobs`/`-j`, `--resume <id>`, `--output`/`-o`, and
`--run-id`, selects the execution ID/root, restores saved selections before
loading inputs, and delegates execution to `runCampaign`. Hosts supply their own
option definitions, validation, and loader; no experiment format or dataset
argument is required by this wrapper. The public `forge run` uses the same stage.

This example is an embedding pattern; `prepareInputs` and `publish` are
host-supplied functions:

```js
import {runCampaignCommand} from '@stripe/forge/campaign/cli';

async function runHostCommand(argv, {engine, prepareInputs, publish}) {
  const result = await runCampaignCommand(argv, {
    engine,
    hostOptions: {
      experiment: {type: 'string', short: 'e'},
      case: {type: 'string'},
      upload: {type: 'boolean'},
    },
    selectorOptions: ['case'],
    validateHostArgs({values}) {
      if (!values.experiment) throw new Error('--experiment is required');
    },
    loadCampaign: async (context) => {
      // May read custom YAML and generate a deterministic input inventory.
      // On resume, reproduce context.savedSelections in their original order.
      const inputs = await prepareInputs(context);
      return {
        plans: inputs.plans,
        composition: inputs.preflightComposition,
        execute: (request) => inputs.execute(request),
        dispose: () => inputs.dispose(),
      };
    },
  });
  if (result.arguments.values.upload) await publish(result.outcomes);
  return result;
}
```

The outer router owns commands, help, and version handling. It can compose its
parser with `createCampaignCliOptions(hostOptions)` or use `parseCampaignArgs`;
forward shared run flags rather than rejecting them in a separate hardcoded
list. Long-name and short-alias collisions are rejected. `allowPositionals: true`
lets `validateHostArgs` enforce host-specific positional grammar, including
rejecting positional selectors on resume. `suppliedOptions` lists explicit
options independently of defaults. Explicit options listed in `selectorOptions`
are forbidden on resume; the loader must use saved selections instead of
selection defaults and reproduce the original plan checksums. Compatible
operational flags become available after a pinned dependency upgrade; flags
which require new host input or capability behavior still need host integration.

Loading may parse and materialize inputs but must defer credentials, bridges,
runtime allocation, and tool preparation until `execute`, after every plan
passes pure preflight. Use the supplied engine for planning and execution. The
loader must clean partial preparation if it throws before returning. Once it
returns, the wrapper awaits its `dispose` exactly once after callbacks drain,
including on cancellation or failure, and preserves the primary error if
disposal also fails. Cancellation during disposal still rejects the command
after cleanup finishes. Prepared-input disposal and per-run cleanup must operate
independently of an aborted signal. Host capabilities must support the selected
concurrency; sharing checkpoints does not make host global resources safe.

The result contains the execution reference, counts, parsed arguments, and one
outcome per selection in original order. An outcome has its plan digest, latest
run ID, execution state/error code, and, when verified, a local artifact reference
with evaluation status/score and a bounded failure code. Valid failed or partial
scores remain completed. Publication and final exit policy are host-owned.
Keep upload state outside `campaign.json`, keyed by immutable run/artifact
identity and destination, and use idempotent publication or a publication lock.
Publish verified skipped outcomes too; an upload error must not cause an eval to
rerun. Do not perform uploads inside the execution or outcome callbacks.

`inspectCampaign({root, engine, signal?})` from `@stripe/forge/campaign` verifies
the latest attempt for every saved selection without loading inputs, acquiring
execution credentials, or changing the checkpoint. It supports publication-only
retries even when the original sources have changed. Both the saved selection
and plan digest must match the verified commit. Inspection derives effective
state from artifacts just as resume does: an errored or running checkpoint with
a valid successful commit is reported completed, without changing the checkpoint.
It returns no historical
attempts; an unstarted selection has a pending outcome with no artifact.
Invalid or missing artifacts have no publishable reference. Inspection is a
snapshot and does not wait for active execution. After a failed stage has drained
and disposed inputs, `CampaignCommandError.reference` identifies the execution
for inspection; its `cause` is caller-owned and must not be persisted wholesale.
The wrapper performs no publication after cancellation or any other failure.

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

Built-in implementations use `FORGE_VERSION` as their adapter/provider version.
Independently released integrations supply their own `version`. Optional
`AgentAdapter.metadata` contains `endpoint_mode` and `layout_mode`; optional
`CompletionProvider.metadata` contains `endpoint_mode`. Each value is `default`
or `custom`, with no additional fields. Forge validates and freezes fresh
snapshots during pure preflight and persists them in `agent.metadata` and
`completion_calls[].provider_metadata`.

### Anthropic-compatible endpoints

The built-in completion provider is exported from
`@stripe/forge/providers/anthropic`. It uses Node.js 22's native `fetch`, calls
the Anthropic Messages API, supports strict JSON-schema output, and never reads
ambient credentials itself. A custom `baseUrl` selects a Messages-compatible
service root; Forge appends `/v1/messages`. HTTPS is required except for a
loopback development endpoint. Host-side completions reject HTTP redirects
with `http_error`, keeping credentials and requests at the configured endpoint.

The public CLI selects its authentication mode from the environment. With no
`ANTHROPIC_BASE_URL`, Claude Code and host-side completions use direct Anthropic
and resolve `ANTHROPIC_API_KEY`. With `ANTHROPIC_BASE_URL`, both use that URL and
resolve `ANTHROPIC_AUTH_TOKEN` instead. Built-in adapter and completion-provider
versions use the installed Forge package version.
`result.json.agent.metadata.endpoint_mode` and
`completion_calls[].provider_metadata.endpoint_mode` record `default` or
`custom`, without adding endpoint URLs or token values. Claude uses native
writable plugin installation and user settings.

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
| `@stripe/forge/campaign` | Shared local scheduling, checkpoints, resume, automatic scorecards and their parser/types, verified outcomes, and read-only inspection |
| `@stripe/forge/campaign/cli` | Extensible shared run/resume command stage and operational option definitions |
| `@stripe/forge/agents/claude-code` | Claude Code adapter, stream parser, and evidence loader |
| `@stripe/forge/agents/codex` | Codex adapter, stream parser, and exact-rollout evidence loader |
| `@stripe/forge/providers/anthropic` | Direct Anthropic and Messages-compatible host completion provider |
| `@stripe/forge/runtime/docker` | Forge Docker adapter and pinned runtime metadata |
| `@stripe/forge/setup` | Built-in handlers plus action-bundle and setup-executor contracts |
| `@stripe/forge/testing` | In-memory inputs/workspaces/stores, fake runtime and agent adapters, scripted completion providers, test plans, and runtime conformance checks |
| `@stripe/forge/package.json` | Package metadata |

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
- The Claude and Codex adapters select the exact run-owned session JSONL. They
  do not use a newest-session heuristic. Codex selects one matching root UUID
  rollout below its isolated `CODEX_HOME/sessions` and checks session metadata.
- Codex native evidence uses format `codex-rollout-jsonl`. Actual user turns
  are distinguished from injected AGENTS.md and environment context, which
  become system steps. Function and custom-tool calls retain native call IDs,
  arguments, and correlated outputs. Native tool-search calls and their returned
  tool definitions remain correlated tool behavior. Each MCP call requires a
  matching `McpToolCall` completion snapshot, checked against its call and result.
  A missing snapshot triggers incomplete-source fallback even when the output
  includes an `is_error` flag; a completion for another tool type is not a
  substitute. A completed invocation does not override an MCP `isError` result.
  Supported MCP text and image blocks may include `annotations` and `_meta`
  objects. Forge treats their contents as opaque data under the existing JSON
  size and nesting limits, not as Forge control fields. Metadata
  present in the recorded rendered output is preserved after credential
  redaction; metadata present only in the full snapshot is not added to judge
  evidence. Metadata alone does not add a warning or reduce completeness.
  Recognized Codex MCP truncation preserves exactly the shortened text recorded
  in the native output (after credential redaction), including truncation and
  omitted-item markers. Forge validates the retained text and omission counts
  against the full snapshot; it never restores hidden text into judge evidence. A
  `value_omitted` warning marks the native trajectory as `partial`. Unknown or
  mismatched truncation, including a clipped timing header that cannot be
  reconstructed from the snapshot, still triggers driver fallback.
  Tool results may be strings or supported content-block arrays. Text blocks
  remain judge-visible. Image bytes and URL references remain only in the restricted native
  artifact; the normalized result contains an explicit omission marker and a
  `value_omitted` warning, making that native trajectory `partial` instead of
  discarding its text and falling back. Forge does not fabricate image-file
  references, fetch image URLs, or attach native image bytes to text-only judges.
  Incomplete, compacted, ambiguous, or
  unsupported conversational records trigger whole-trajectory driver fallback.
- The same exact selected root JSONL is retained byte-for-byte as a restricted
  supplemental artifact under `native/`. Forge does not crawl or retain sibling
  sessions or subagent traces.
- Structurally valid Claude attachment records with one or more
  string-valued `rendered[].content` entries are preserved as ATIF system steps
  in native order. The exact rendered text and timestamp are retained, while
  `extra` identifies the
  native record and attachment types. These system steps remain excluded from
  guideline judging. A `hook_success` record is treated as bookkeeping only
  when its validated output contains a single nonempty `additionalContext` that
  is repeated in the immediately following, rendered `hook_additional_context`
  record. The latter supplies the ATIF system step; a missing or mismatched pair
  still triggers fallback. Empty session-context bookkeeping is ignored; prompt
  snapshots remain in the restricted native source and produce a partial-detail
  warning until their per-call semantics can be normalized faithfully.
- Forge accepts that native candidate only when it identifies the selected
  session and structurally covers the completed driver ledger: the same number
  of logical turns, the same ordered user prompts, and visible response or tool
  activity for each completed response. Native assistant text and tool payloads
  need not be byte-identical because live and persisted protocols are lossy
  projections of the same turn. For native Codex evidence, each turn must also
  retain assistant text when the live turn had text and at least the observed
  count of each comparable tool kind (including each named MCP tool). Native-only
  tool discovery cannot compensate for a missing executed tool. This rule uses
  native-format provenance, not the configured adapter ID; custom Codex adapter
  IDs receive the same checks. These are lower-bound coverage checks, not exact
  one-to-one execution matching. Claude's projection-tolerant coverage and explicit
  bounded driver fallback retain their existing rules.
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
  Unsupported-record fallback diagnostics identify a safe record category and
  line number, never native payload values.
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
The [architecture guide](docs/architecture.md#setup-architecture) documents
setup preflight and credential scoping. Embedding hosts that add setup semantics
should also read [Setup action bundles](docs/setup-action-bundles.md).
The composition contains:

- a `RuntimeAdapter`;
- an ID-to-`AgentAdapter` map;
- a `CredentialResolver` and read-only `RunInputProvider`;
- a transactional `RunArtifactStore`;
- optional completion providers, one observer, and artifact contributors.

### External runtimes

Docker remains the built-in runtime and the public executable's default. An
embedding host can supply another `RuntimeAdapter` using a fully specified
runtime descriptor in its experiment:

```yaml
runtime:
  adapter: acme/process
  platform: linux/amd64
  config:
    profile: isolated-worker
    tool_build: immutable-build-123
    network_policy: approved-egress
```

The names and fields inside `config` belong to that adapter. The public parser
validates the strict envelope and bounded plain JSON (at most 1 MiB serialized
configuration, subject to the overall graph limits). It rejects unsafe object
keys and does not add defaults or rewrite external configuration. A namespaced
adapter ID and platform are required. `docker` and `forge/docker` are reserved
for the built-in format.

Supply one implementation through `ForgeComposition.runtime`; no registry,
automatic imports, or runtime discovery is involved. An external adapter must
implement synchronous, pure `preflight({plan, requirements, environment})`. Forge calls it
after merging agent and setup requirements, before resolving any credentials
or allocating resources. It must reject unknown config fields, missing
effective settings, unsupported requirements, and incompatible limits. It must
not inspect ambient state, normalize defaults, allocate, or return a promise.
Environment checks belong in `prepare()`. A runtime with a host-import phase
may defer physical executable checks until those imports finish, but must
complete them after setup command authority closes and before interaction. The
built-in Docker runtime requires each resolved target to be a regular file
executable by its final non-root container user; a shell built-in or merely
discoverable path is insufficient. The implementation ID must match the plan
exactly.
The preflight environment contains plain variables and opaque credential
names, references, and scopes. Use it to reject incompatible environment policy
before secret resolution; secret values are supplied only to `prepare()`.

Parsing and planning validate the public envelope; execution and `validate`
with a host composition additionally validate provider semantics. The public
CLI cannot execute an external descriptor on its own. Wrappers using `runCli`
receive the selected descriptor in the factory's `options.runtime` field and
explicitly choose their implementation.

The complete descriptor participates in the canonical `plan.json` artifact
checksum. Verification
binds runtime identity and platform to the plan without loading the private
adapter. Offline verification checks the recorded artifacts and descriptor,
not the private adapter's configuration semantics or actual isolation
enforcement.

Keep declared behavior, constraints, and policies, such as resources and
network policy, in the resolved configuration. Pin an immutable tool build
there when that exact build is part of the intended experiment. When setup
intentionally resolves changing external state, retain its actual non-sensitive
identity and version in `setup.json` instead of treating it as though the plan
pinned it. Compute a content digest for an expected-content check, artifact
verification, or a documented identity workflow such as comparing installed
plugin snapshots. Keep credentials and infrastructure clients
in the composition. An adapter may record actual build and deployment identity in
sealed runtime metadata. A worker deployment is distinct from its
command-execution mechanism; hosts can reuse an adapter when moving a worker
without changing that mechanism.

See [the runnable external-runtime example](https://github.com/stripe/forge/blob/main/examples/external-runtime/README.md)
for an offline demonstration using test adapters. It completes the ordinary
execution and artifact-verification lifecycle without Docker or credentials.

### Runtime layouts and conformance

State requirements retain the field name `containerPath` for compatibility;
its meaning is an absolute path visible to commands in the selected runtime.
The runtime must expose exactly the declared state directories and enforce its
mutable, setup-finalized, sealed, and disposed boundaries. An adapter which
cannot enforce `sealAfterSetup: true` must reject that requirement in preflight.

Trusted embedding hosts can use the optional `PreparedRuntime.importHostFile`
capability to install a large local file into a declared state directory without
holding it all in Node memory. The host supplies an absolute source path, a
single safe filename at the state root, a byte limit, and the expected SHA-256.
The Docker runtime streams the copy, verifies the staged bytes, and publishes them
atomically. `verifyAfterSetup: true` checks the file again as setup ends and
requires a sealed state directory. This capability is available only to the
host holding `PreparedRuntime`; it is not exposed to authored YAML, setup
actions, or agents. A custom runtime may omit it; hosts that need imports must
check for support. Docker state mounts may be under `/home/forge`, or under
`/opt` when `sealAfterSetup: true` protects a system-managed tool.

The expected SHA-256 establishes transfer integrity for that import. The core
capability does not currently add an import receipt to `setup.json` or bind the
digest into the resolved plan. An integration which makes imported bytes
material to an evaluation must therefore treat their missing persisted identity
as a provenance limitation; pinning an expected digest in resolved runtime
configuration provides a stronger declared guarantee.

The public Claude adapter accepts a fixed, runtime-visible layout:

```js
const claude = createClaudeCodeAdapter({
  layout: {
    workspace: '/run/example/workspace',
    home: '/run/example/home',
    configDirectory: '/run/example/session',
  },
});
```

Choose the run-owned paths in trusted host code before constructing the adapter;
the runtime creates them during preparation. `ClaudeCodeLayout` is exported as
a type from `@stripe/forge/agents/claude-code`. The layout is validated and
snapshotted without filesystem access. The runtime must report the same home
and workspace paths. Claude config, plugin installation, and native project
paths share the effective configuration root, including when it is separate
from HOME. The adapter records `layout_mode: custom` in
`result.json.agent.metadata`; the standard Docker layout records `default`.

Use `assertRuntimeAdapterConforms` from `@stripe/forge/testing` to exercise an
adapter. Its optional `commandProbes` check scoped command results using
synthetic credentials, and `cancellationProbe` uses an explicit ready line and
a bounded abort deadline. The helper also checks state bytes and revocation of
mutable and command handles. Each real implementation must additionally test
its process cleanup, background-writer termination, filesystem boundaries, and
isolation guarantees; a test-double probe does not establish those properties.

### Credentials and lifecycle authority

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
public `forge/plugin` action. Its preflight is pure: it binds one selected
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

```ts fragment
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
host-owned semantics and capabilities. Wrappers with their own grammar or
generated inputs can instead use the shared [campaign API](#experiment-campaigns).

## Security and reproducibility

Forge targets auditable semantics and provenance rather than deterministic
replay of every external system. It records the bounded values it controls or
resolves, plus the evidence it actually selects. It cannot inventory the state
of the internet, force a model provider to repeat an output, or prove that a
remote document remained unchanged unless an integration records an immutable
identity or content digest.

- Datasets are exact-manifest, hash-verified trees. Forge rejects symbolic
  links, special files, traversal, undeclared payloads, and unsafe roots.
  Manifest-backed input providers recheck each returned file buffer and
  directory inventory before setup consumes them.
- The Docker build context contains only Forge's packaged Dockerfile and
  entrypoint. The Node base image is pinned by OCI digest; Claude Code is
  installed at exact version `2.1.273` and Codex at `0.149.0`.
- Debian packages and the coding-agent packages are resolved from the configured
  registries when the image is built. Forge records the resulting immutable
  image ID; a future release should add stronger dependency-level integrity
  pins if byte-for-byte rebuilds are required across registry state changes.
- The resolved plan always selects a concrete Linux platform. An authored
  Docker experiment may request `native`; planning then materializes the Docker
  server's architecture before execution. Forge records both its runtime asset
  digest and Docker's immutable built image ID in the result metadata.
- Containers run as the named non-root `forge` user. On a non-root Unix host,
  that image user has the host UID so bind-mounted setup files and agent output
  retain one owner in both filesystem views; root hosts use fallback UID
  `10001` and assign host-written runtime files to it. Runtime metadata records
  the effective UID. Containers otherwise use a read-only root filesystem, all
  Linux capabilities dropped,
  `no-new-privileges`, bounded memory/CPU/processes, bounded commands, and
  run-owned workspace/home/state mounts.
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
- Claude Code and Codex are built-in agents. Cursor is not included. Codex
  supports non-interactive API-key execution; ChatGPT login is not included.
- Anthropic is the only built-in completion provider. It supports direct
  Anthropic and Anthropic Messages-compatible endpoints and requires Claude
  4.5-or-newer model identifiers for strict structured output. OpenAI host completions,
  OpenRouter-native, and other provider protocols are not included, though a
  programmatic composition can implement the public provider contract.
- The built-in Docker adapter accepts only the Forge-owned image. Custom
  images, mounts, and other execution mechanisms require a host-supplied
  runtime. No additional runtime implementations or interactive/human
  controller ship in this package.
- `run` supports bounded local concurrency through `--jobs` and explicit
  `--resume <experiment-run-id>`. There is no distributed scheduler or automatic
  run retry loop; experiment-level `retries` is not acted on by the CLI. Ava and
  guideline completion attempts have their own fixed retry policy and do not implement
  the experiment config's campaign retry field.
- Built-in setup includes `forge/write`, `forge/command`, and agent-native
  `forge/plugin`. The plugin action installs the current entry from a public
  GitHub marketplace named as `owner/repository`. Exact plugin-version pins,
  remote MCP-service pins, private repository authentication, npm and command
  sources, user-defined plugin options, and transitive plugin dependencies are
  not included. Codex also rejects archives and SHA-pinned Git source metadata;
  its pinned CLI does not report installed source commits. See the
  [plugin contract](docs/plugin-action.md) for adapter-specific source support.
- Results are local. There is no remote publisher, worker/control plane, hosted
  execution service, or human-result policy in the public package.
- Each CLI process asks Docker to build and verify the Forge image; Docker's
  content cache normally reuses prior layers. A cold cache still needs registry
  availability, and the host Docker implementation can affect build success.
- `PreparedRuntime.importHostFile` verifies requested bytes but does not
  currently emit a core `setup.json` receipt for the installed digest, size,
  mode, and destination.

## Development

The library and test suite compile with `tsc`; the repository does not require
a bundler or an `esbuild` install/build exception. Tests run on Node's built-in
test runner.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:docs
pnpm test:package
pnpm check
```

Pull requests targeting `main`, including drafts, automatically run the same
validation as `pnpm check` on Node.js 22 through the
[PR checks workflow](https://github.com/stripe/forge/blob/main/.github/workflows/pr-checks.yml).
The single `Forge checks` job has named steps for type checking, automated tests,
build, documentation validation, and package checks, using the same package
scripts as the local command without Docker or model credentials. It runs when
a PR opens, receives new commits, or reopens, and cancels obsolete runs when a
newer commit arrives. Development snapshots are published by the separate
workflow after pushes to `main`.

Maintainers can require `Forge checks` in the branch rules for `main` to block
merging until it passes for the current commits. Adding the workflow reports
results on PRs; requiring its status check is a separate repository setting.

### Opt-in live tests

The repository has one live suite with `full` (default) and `setup` modes. Both
need a running Docker daemon and network access to build the packaged image;
plugin checks additionally contact the public marketplace. The suite is
separate from `pnpm test` and `pnpm check`.

Run setup action integration without model credentials or model calls:

```sh
FORGE_LIVE=1 FORGE_LIVE_MODE=setup pnpm test:live
```

Setup mode tests `forge/write` with inline UTF-8 and dataset files;
`forge/command` with literal argv, a working directory, nonzero exits,
and timeouts; and `forge/plugin` with a real native installation for the
selected agent. Each case runs through Forge's normal parser, planner, setup,
and execution lifecycle in its own real Docker runtime. A deterministic interaction probe
checks the setup effects after finalization. Completed artifacts and
`setup.json` receipts are verified, and both successful and failed setup must
leave no containers or runtime files. Select `FORGE_LIVE_AGENT=codex` to test
Codex setup. That mode also exercises a local marketplace fixture with the
pinned Codex CLI, skills, MCP, native and automated hook policies, exact-session
resume, plugin disabling between turns, provider isolation, and native
evidence. Its Responses server and role-player are deterministic fixtures;
it makes no upstream model calls and requires no model credentials.

Full mode makes potentially billable model calls. Direct Anthropic uses a
dedicated API key:

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

One full-mode invocation builds once and runs the following checks in order:

1. The real Docker adapter conformance probe, including bidirectional bind-mount
   writes, private file ownership, sealing, cleanup, and idempotent disposal.
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

To test only Codex, select its mode in the same live suite:

```sh
FORGE_LIVE=1 \
FORGE_LIVE_AGENT=codex \
CODEX_API_KEY=your-restricted-key \
OPENAI_BASE_URL=https://gateway.example.com/v1 \
pnpm test:live
```

Omit `OPENAI_BASE_URL` for direct OpenAI. Codex mode runs Docker conformance,
the plugin fixture suite described above, the checked-in Codex one-shot
experiment, and full artifact verification, including native rollout evidence.
It needs no Anthropic credential; its multi-turn fixture uses a scripted
host completion provider. The selected model for upstream inference is
`gpt-5.4`, as pinned by the example experiment.

For this live-suite mode, a temporary authenticated host bridge forwards only
Responses API requests to the configured endpoint. The real upstream key stays
host-side; Codex receives only a per-run bridge credential. This requires
`host.docker.internal` support, such as Docker Desktop; the suite checks
container reachability before making model calls. The public CLI itself does
not create this test-only bridge.

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
suite ID used as the prefix for its run IDs,
`FORGE_LIVE_RESULTS_ROOT` selects another results directory,
`FORGE_LIVE_TIMEOUT_MS` sets the overall positive millisecond timeout (30
minutes by default), and `FORGE_DOCKER_EXECUTABLE` selects another Docker CLI.
The final report contains bounded result summaries but never prints endpoints,
prompts, responses, or credentials.

The package smoke test installs the packed tarball into an isolated consumer and
checks every documented ESM subpath plus CommonJS dynamic import. Forge is
licensed under Apache-2.0; ATIF provenance and third-party attribution are
recorded in `src/atif/UPSTREAM.md`, `src/atif/NOTICE.md`, and `NOTICE`.
