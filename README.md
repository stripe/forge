# Stripe Forge

Forge runs and compares coding agents, models, and plugins on versioned tasks.
Each evaluation runs in an isolated environment, evaluates the agent's output,
and saves results and transcripts for inspection. Claude Code and Codex are
built in; embedding hosts can supply other agents, runtimes, and completion
providers through public contracts.

Forge aims to make runs auditable. `plan.json` records declared inputs and the
producing Forge package; `setup.json` records bounded, non-sensitive setup
receipts; results bind those records to selected evidence and outcomes. These
records do not guarantee identical reruns or complete capture of external state.

Forge is in early development. The public CLI supports one-shot and multi-turn
runs, deterministic file checks, model-judged criteria, marketplace plugin
treatments, local concurrency, resume, and local reports. Review the
[current limitations](#current-limitations) before designing a benchmark.

- [Concepts](#concepts)
- [Requirements and credentials](#requirements-and-credentials)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Authoring cases and experiments](#authoring-cases-and-experiments)
- [Running experiments](#running-experiments)
- [Results and scores](#results-and-scores)
- [Security and auditability](#security-and-auditability)
- [Programmatic API](#programmatic-api)
- [Development](#development)

## Concepts

| Concept | What it means |
| --- | --- |
| Case | One task, its invariant setup, interaction mode, checks, and judging criteria. |
| Dataset | A versioned collection of case files and fixtures, with an exact inventory of their sizes and hashes. |
| Treatment | Setup applied after case setup, such as installing a plugin. A baseline can have no additional setup. |
| Experiment | A dataset pin, treatments, agents/models, runtime choices, and a matrix of cases to evaluate. |
| Experiment run | One resumable execution of the selected experiment matrix, with a checkpoint and report. |
| Eval run | One execution attempt for one case, treatment, agent, and repetition. Retries receive new eval run IDs. |

A matrix selection chooses one case, treatment, agent, and repetition. Forge
resolves it into an immutable plan before execution. An experiment may produce
many selections; running it again creates a separate experiment run.

Ava is Forge's built-in role player for multi-turn evaluations: it acts as the
developer talking to the coding agent. Ava and the criterion judge use
host-side completion models independently of the coding agent. Agent
transcripts are normalized to Agent Trajectory Interchange Format (ATIF v1.8).

## Requirements and credentials

The built-in CLI composition requires:

- Node.js 22 or newer. Forge is ESM-only.
- A running Linux Docker server and Docker CLI, supporting `linux/amd64` or
  `linux/arm64`. `platform: native` selects the server's architecture.
- Network access to Docker Hub and npm for the first runtime image build.
  Marketplace plugin treatments also need access to their public GitHub
  marketplace and selected source.
- Capacity for each concurrent eval run. Default limits are 4 GiB memory,
  2 CPUs, and 512 processes per runtime.
- Credentials for the selected coding agent and any host completion models.
  Execution makes potentially billable model calls; ordinary validation does not.

The runtime installs pinned Claude Code and Codex CLI releases from npm. Their
use remains subject to the respective providers' terms. Custom runtimes have
[their own explicit requirements](docs/embedding.md#external-runtimes).

| Selected workload | Coding-agent credential | Host completion credential |
| --- | --- | --- |
| Claude Code, one-shot with file checks only | `ANTHROPIC_API_KEY`, or the configured Anthropic-compatible endpoint token | None |
| Claude Code with Ava or judging criteria | Same as above | The CLI uses the same Anthropic configuration for the required roles |
| Codex, one-shot with file checks only | `CODEX_API_KEY` | None |
| Codex with Ava or judging criteria | `CODEX_API_KEY` | Independently configured Anthropic credential |
| `validate` or `plan` | None | None |

The CLI's built-in host completion provider is Anthropic. It requires
Claude 4.5-or-newer model identifiers and strict structured-output support.
Selecting Codex as the coding agent does not change the Ava or judge provider.

For direct Anthropic, set `ANTHROPIC_API_KEY`. For a compatible service, set
both `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; when the URL is present,
the CLI requires that token and does not select `ANTHROPIC_API_KEY`.
The service must support the Anthropic APIs used by Claude Code and host-side
`/v1/messages` requests, including structured output.

For Codex, set `CODEX_API_KEY`. Optional `OPENAI_BASE_URL` is the complete
Responses-compatible API root, such as `https://gateway.example.com/v1`.
The CLI does not implicitly read `OPENAI_API_KEY`. Remote endpoints must use
HTTPS and be reachable from inside the runtime; host-side Ava and judging must
also reach their endpoint. A host loopback URL points at the container when
used by the coding agent.

Export the required variables in your shell, or provide them through your
usual credential manager, before running or resuming pending work. Credentials
and endpoints are execution configuration, outside the case and experiment.
See [embedding and credential configuration](docs/embedding.md) for explicit
bindings, custom providers, and compatible endpoints.

## Installation

Development snapshots are published to **GitHub Packages**, not npmjs.org.
GitHub requires authentication to install public npm packages too. Use a
personal access token (classic) with `read:packages` and access to the package;
see [GitHub's npm registry instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

In the consuming project's `.npmrc`, configure the scope and an environment
variable for authentication:

```ini
@stripe:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Set `NODE_AUTH_TOKEN` to the GitHub token in your shell or credential manager,
then install an exact dependency pin:

```sh
npm install --save-dev --save-exact @stripe/forge@dev
```

`dev` selects the current snapshot; `--save-exact` records its resolved version.
Keep that package version pinned when comparing runs or reading saved artifacts.
GitHub package authentication is separate from model-provider authentication.

From a source checkout, use the pinned package manager:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The examples below use the locally installed `npx --no-install forge` command.
In a source checkout, substitute `node dist/cli.js`, and use
`node docs/create-quickstart.mjs` for the quickstart helper.

## Quick start

Run these commands from the project where you installed Forge. The packaged
helper creates a small one-shot case, its exact manifest, and a baseline
experiment, calculating the size and hashes from the bytes it writes:

```sh
node node_modules/@stripe/forge/docs/create-quickstart.mjs ./quickstart
```

It refuses to overwrite an existing destination. The generated layout is:

```text
quickstart/
├── dataset/
│   ├── manifest.json
│   └── cases/examples/hello-file.case.yaml
└── experiment.yaml
```

The agent must create `hello.txt` containing exactly `hello, forge!` followed by
one newline. File checks evaluate the result, so this example needs no Ava or
judge model. Its experiment uses `platform: native` for a local smoke test.

Validate the inputs without Docker allocation or model credentials:

```sh
npx --no-install forge validate --experiment ./quickstart/experiment.yaml
```

Configure a dedicated Anthropic key for this shell, then run the single
selection and save the command summary:

```sh
export ANTHROPIC_API_KEY=your-restricted-key
npx --no-install forge run \
  --experiment ./quickstart/experiment.yaml \
  --output ./results \
  --run-id hello-001 > run-summary.json
```

This command uses Docker and calls Claude Code's model. Progress goes to stderr;
`run-summary.json` contains the generated experiment run ID and output location.
Inspect the evaluation using Node:

```sh
node --input-type=module <<'JS'
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
const summary = JSON.parse(await readFile('run-summary.json', 'utf8'));
const result = JSON.parse(await readFile(
  path.join(summary.location, 'runs', 'hello-001', 'result.json'), 'utf8',
));
console.log(result.evaluation);
JS
```

A successful result has `status: 'passed'` and every entry in `checks` passed.
Its numeric `score` is **0**, because numeric scores measure judging criteria
and this case has none. Exit code 0 means execution completed and the report
was saved; it does not mean an evaluation passed.

The eval artifacts live at
`results/experiments/<experiment-run-id>/runs/hello-001/`.
The experiment directory also contains `experiment.json` and `report.json`.
See [Results and scores](#results-and-scores) for their meanings.

**Native logs are restricted:** `native/<adapter>/session.jsonl` retains the
exact source log without redaction and can contain credentials, private
reasoning, or file contents. Preserve its access controls when copying or
publishing artifacts. `trajectory.json` is the normalized, credential-redacted
transcript.

To inspect the plan without executing it:

```sh
npx --no-install forge plan --experiment ./quickstart/experiment.yaml
```

For `platform: native`, planning queries the Docker server's architecture but
does not build or allocate a runtime. To additionally build the image and probe
the current Docker host without credentials or model calls:

```sh
npx --no-install forge validate --experiment ./quickstart/experiment.yaml --host
```

### Run the same case with Codex

Replace `matrix.agents` in the generated experiment with:

```yaml
matrix:
  agents:
    - adapter: codex
      provider: openai
      model: gpt-5.4
      hook_trust: native
```

Keep its other matrix fields and dataset pin. The model is an explicit
experiment choice, subject to provider availability. Validate the changed
experiment, configure the Codex key, and run:

```sh
npx --no-install forge validate --experiment ./quickstart/experiment.yaml
export CODEX_API_KEY=your-restricted-key
npx --no-install forge run \
  --experiment ./quickstart/experiment.yaml \
  --output ./results --run-id codex-001
```

This checks-only run needs no Anthropic credential. `hook_trust: native` lets
Codex enforce its normal hook review requirements. `automation` permits all
enabled hooks, including workspace hooks, to run without review in the isolated
runtime. See [plugin hook policy](docs/plugin-action.md#hook-policy-and-writable-state).

## Authoring cases and experiments

Start from the generated inputs and use the [authoring guide](docs/authoring.md)
for complete case, dataset, and experiment examples and the hash-update workflow.

- Cases own tasks, invariant setup, execution mode, checks, and judging criteria.
  Each declares an `id`, unique within its dataset release, using lowercase
  kebab-case segments separated by `/`.
- Case filenames are `case.yaml` or `<name>.case.yaml` with a nonempty name.
  The declared ID is independent of the filename.
- The manifest's `cases` list contains dataset-relative file paths. Its `files`
  array is the exact inventory of all regular payload files, excluding
  `manifest.json` itself. Extra, missing, modified, symbolic-link, or special-file
  payloads are rejected.
- Experiments pin dataset identity and the raw manifest digest. `dataset.path`
  resolves relative to the experiment file; case paths resolve within that dataset.
- Experiment versions identify input definitions. The installed Forge package
  defines schemas and generated formats; authored inputs have no `schema_version`.
  Unknown fields and duplicate YAML keys are rejected.

An experiment owns runtime, model, treatment, resource, and matrix choices.
For multi-turn cases, supply `models.role_player`; for nonempty
`judging_criteria`, supply `models.judge`. These are host completion models,
independent of `matrix.agents`. Unused role settings are excluded from the
resolved selection's plan.

Ava keeps one coding-agent session across turns, privately tracks the task's
remaining needs, and stops on completion, the turn limit, or a role-player error.
Judges evaluate each criterion independently against selected visible behavior
and bounded workspace text. They do not receive Ava's private need model or
private reasoning. See [interaction and scoring semantics](docs/architecture.md#interaction-architecture).

### Treatments and setup

Case setup runs first, followed by treatment setup, in authored order. The
baseline may have `setup: []`. Built-in actions are:

| Action | Purpose |
| --- | --- |
| `forge/write` | Write inline UTF-8 content or a manifest-listed fixture into the workspace. |
| `forge/command` | Execute an argv vector during setup. Shell parsing requires an explicit shell. |
| `forge/plugin` | Install the selected agent's complete native plugin from a public GitHub marketplace. |

Setup commands execute **before the agent**. Running `npm test` in setup does
not judge the code the agent later writes. Built-in deterministic evaluation
supports file creation, existence, and regex content checks, not post-agent
commands or static-analysis plugins.

Marketplace treatments install the current catalog entry, including supported
skills, hooks, commands, and MCP configuration. Their `setup.json` receipt
records installation-time identity and contents; identical plans may install
different plugin releases on different dates. Plugin state remains writable
during interaction. See [Marketplace plugin treatments](docs/plugin-action.md)
for configuration and source limitations.

Embedding hosts can add trusted setup actions through explicit, immutable
[setup action bundles](docs/setup-action-bundles.md). The stock CLI uses only
built-in actions; YAML never names a package to import.

### Experiment matrices

A flat matrix evaluates every combination of its `cases`, `treatments`, and
`agents`, repeated `repetitions` times. Cases are complete dataset-relative
paths, including `cases/`; each must occur in the manifest.

Use groups when different cases need different treatments or models in the
same experiment. Each group evaluates its own Cartesian product:

<!-- grouped-matrix:start -->
```yaml
matrix:
  repetitions: 2
  retries: 0
  groups:
    - cases:
        - cases/examples/payment.case.yaml
      treatments:
        - baseline
        - payment-plugin
      agents:
        - adapter: claude-code
          provider: anthropic
          model: claude-sonnet-4-6
        - adapter: claude-code
          provider: anthropic
          model: claude-opus-4-6
    - cases:
        - cases/examples/marketplace/case.yaml
      treatments:
        - baseline
        - marketplace-plugin
      agents:
        - adapter: claude-code
          provider: anthropic
          model: claude-opus-4-6
```
<!-- grouped-matrix:end -->

This fragment assumes both case paths are in the manifest and all three
treatments are defined. It produces **12 selections**: eight for payment and
four for marketplace. It never creates combinations across groups.

Choose flat axes or `groups`; mixing them is an error. Every group provides
nonempty `cases`, `treatments`, and `agents`. `repetitions` and `retries` belong
at matrix level. A case may appear in several groups, but duplicate resolved
selections, including materialized agent defaults, are rejected.

Groups flatten into ordinary selections without a group identity in plans,
checkpoints, or reports. Ordering is group, case, treatment, agent, then
zero-based repetition.

The repository's [Stripe integration sample bundle](https://github.com/stripe/forge/blob/main/datasets/stripe-integration-public-evals/README.md)
contains a payments case and runnable baseline experiment. Its
`experiment.yaml` sits beside `dataset/` and uses `dataset.path: ./dataset`, so
the complete release bundle can be moved or archived without rewriting paths.
Those sample input files require a source checkout; they are separate from the
npm package.

## Running experiments

With credentials configured, run every selection in an experiment:

```sh
npx --no-install forge run --experiment ./quickstart/experiment.yaml --output ./results
```

Every invocation without `--resume` starts a new experiment run and prints its
ID. `dataset.path` supplies the dataset location; there is no separate
`--dataset` or `--all` flag.

### Select cases, treatments, and agents

`run` executes every matching combination. `plan` requires exactly one match.
Filters select existing combinations, including from grouped matrices:

```text
--case <case-id>
--case-file <path-to-listed-case-file>
--treatment <treatment-id>
--agent <adapter-id>
--provider <provider-id>
--model <model-id>
--repetition <zero-based-index>
```

`--case` uses the declared ID. `--case-file` maps an exact regular file within
the configured dataset to that ID; the case must be selected by the experiment.
The two options are mutually exclusive. For example:

```sh
npx --no-install forge run \
  --experiment ./quickstart/experiment.yaml \
  --case-file ./quickstart/dataset/cases/examples/hello-file.case.yaml \
  --treatment baseline --agent claude-code --model claude-sonnet-4-6
```

`--run-id` names an **eval run** and requires exactly one matching combination.
It does not name the experiment or experiment run. Omit it for automatically
generated IDs. It cannot be combined with resume.

### Concurrency and failures

`--jobs <count>` or `-j <count>` limits simultaneous eval runs; the default is 1:

```sh
npx --no-install forge run --experiment ./quickstart/experiment.yaml --jobs 4
```

Each eval run owns its runtime, session, and artifacts. Size concurrency for
host memory/CPU and provider rate limits. `--jobs` limits eval runs, not provider
requests; each run may judge up to four criteria concurrently.

When an eval run errors, the experiment records the attempt and continues with
other selections. Each invocation attempts pending selections once;
`matrix.retries` does not add automatic attempts. Ava and judging have separate
fixed completion retry policies. Cancellation stops scheduling and waits for
active eval cleanup before releasing the checkpoint lock.

Progress goes to stderr; the final JSON summary goes to stdout. It includes the
experiment run ID, location, checkpoint/report paths, and selection counts.
Exit code 1 means execution errors remain or report generation failed. Exit
code 0 means every selection completed and the report was saved, regardless of
its evaluation scores.

### Resume an experiment run

Replace `EXPERIMENT_RUN_ID` with the printed ID, use the original output root,
and configure credentials again if pending selections need execution:

```sh
npx --no-install forge run \
  --experiment ./quickstart/experiment.yaml \
  --output ./results --resume EXPERIMENT_RUN_ID --jobs 2
```

Bare `--resume` is a usage error. Resume restores the saved selections,
including original filters; omit selection options and `--run-id`. It requires
the same resolved plans, including dataset pins, setup, models, runtime, and
Forge producer identity. Operational concurrency may change without changing
plan checksums.

Forge verifies completed artifacts before skipping them. Failed or partial
evaluations remain completed. Execution errors, including committed
`role_player_error` outcomes, are retried with fresh eval run IDs. Missing or
invalid artifacts are retried; a valid commit just before interruption is
recovered without rerunning. Earlier artifacts and attempt records remain.
Only one process may actively execute a given experiment run.

A missing or corrupt report can also be refreshed through resume while valid
completed evals are skipped. Report generation itself makes no model calls.
See the [checkpoint and cleanup contracts](docs/architecture.md#failure-cancellation-and-cleanup-semantics)
for interruption and recovery details.

## Results and scores

Each experiment run has this layout:

```text
results/experiments/<experiment-run-id>/
├── experiment.json
├── report.json
└── runs/
    └── <eval-run-id>/
        ├── result.json
        ├── plan.json
        ├── setup.json
        ├── trajectory.json
        └── interaction.json
```

| File | What to use it for |
| --- | --- |
| `experiment.json` | Checkpoint, selected plan identities, and execution attempt history used for resume. |
| `report.json` | Derived scorecard across the saved selections; refreshed after run or resume settles. |
| `result.json` | Canonical evaluation at `.evaluation`, execution provenance, and companion artifact descriptors. |
| `plan.json` | The exact resolved input for one eval run. |
| `setup.json` | Ordered setup receipts, including bounded resolutions reported by actions. |
| `trajectory.json` | Selected, normalized, credential-redacted ATIF transcript. |
| `interaction.json` | Driver turn history and stop reason; includes Ava's private audit data for multi-turn runs. It is not judge input. |

Conditional artifacts include `workspace-evidence.json` for deterministic file
checks, `judge-evidence.json` for judging, and
`native/<adapter>/session.jsonl` for the exact selected source log. Registered
host contributors may add supplemental files below `extensions/<contributor-id>/`.

The **native source log is unredacted and restricted**, even if normalized
evidence fell back to the driver transcript. The local store writes it with
mode `0600` and marks its descriptor `sensitivity: restricted`. Custom stores
and publishers must preserve appropriate access controls. It never affects
scoring or goes to the judge.

### Interpret the scorecard

Numeric `score` is the fraction of judging criteria that passed. File checks
are additional pass/fail constraints; they do not change that fraction.

| Outcome | Meaning |
| --- | --- |
| `passed` | All required checks and judging criteria passed. A checks-only pass has score `0`. |
| `partial` | Some criteria passed, or checks passed while criteria did not all pass. |
| `failed` | The completed evaluation did not establish a pass or partial success. |
| Execution error | The selection did not complete successfully; it can be retried. This differs from a failed evaluation. |

Interaction stop reasons and evaluation status are separate: reaching
`max_turns` can still produce a passing evaluation. The
[scoring contract](docs/architecture.md#evaluation-and-scoring) explains criteria,
evidence bounds, and completion failure handling.

With optional `jq`, inspect per-case/configuration statistics:

```sh
jq '.cases[] | {case_id, treatment, agent, completed, errored, pass_rate, judging_score}' \
  results/experiments/EXPERIMENT_RUN_ID/report.json
```

The report contains `summary`, `cases`, and `runs`:

- `summary` aggregates all saved selections.
- `cases` groups by case ID, treatment, and complete agent selection, combining
  repetitions. Codex hook trust is part of that identity.
- `runs` has one row per saved selection, with its latest effective attempt,
  state/error code, result path, attempt count, and evaluation when completed.

`coverage` is completed selections divided by all saved selections. `pass_rate`
is passed evaluations divided by completed evaluations, or `null` when none
completed. `judging_score.mean` covers only completed evaluations with judging
criteria; checks-only runs contribute to pass rate, not that mean. Ratios range
from 0 to 1.

Retries do not add another selection or score. Only the latest verified
effective outcome contributes. Combinations absent from a grouped matrix have
no report row and do not count as pending. Compare treatments on matched case
IDs and complete agent selections: different case/model coverage describes
different evaluation distributions. Each completed judged evaluation has equal
weight, so more selected configurations for one case give that case more weight.

Reports are snapshots and can be stale after an interrupted process. They are
derived from verified eval artifacts and do not control resume.

### Verify and inspect evidence

`result.json` is the atomic commit marker. Artifact descriptors identify each
companion file's media type, size, and digest; there is no duplicate
`evaluation.json`. Programmatic consumers use `verifyCompletedRun(location)`
to verify saved results and cross-artifact invariants before trusting them.

Saved artifacts record their producing Forge version. Readers require an exact
package-version match whenever either version is outside the `X.Y.Z-dev.*`
development channel. Different development versions can be read with current
strict schemas on a best-effort basis, without a compatibility guarantee. Use
the corresponding released package to inspect its artifacts, or resolve fresh
plans to execute with a newer release.

Native evidence can be `complete`, `partial`, or replaced by explicit driver
`fallback` evidence with recorded warnings. The judge receives a positive
projection of visible root-session messages and tool behavior, plus bounded
workspace text. It excludes system/copied context, private reasoning, metrics,
and Ava's private needs. `judge-evidence.json` records the actual projected
steps and workspace subset used for judging.

See [evidence architecture](docs/architecture.md#evidence-architecture) and
[result and artifact architecture](docs/architecture.md#result-and-artifact-architecture)
for exact formats, verification rules, and fidelity limits. Setup receipts
capture installation-time facts, not every external state change or final
plugin mutation.

## Security and auditability

The built-in Docker runtime isolates each eval run with a non-root user,
read-only root filesystem, dropped Linux capabilities, `no-new-privileges`,
bounded resources, and run-owned workspace/home/state. Forge never mounts the
Docker socket into the eval container. The host daemon and installed Forge
code remain trusted.

Provider credentials are scoped to declared capabilities; Forge does not copy
the host environment wholesale. Normalized evidence and ordinary artifacts
redact exact resolved secret values. Restricted native logs are the explicit
unredacted exception. Redaction does not detect transformed or partially
leaked values.

The evaluated agent receives its selected provider credential and outbound
network access, so it can intentionally disclose that credential. Use a
restricted, short-lived key with appropriate account limits. Ava and judge
providers receive benchmark prompts and the documented evidence needed for
their roles. v0.1 does not provide domain allowlisting or an offline execution
mode.

Dataset hashes verify the declared input bytes. Forge pins packaged runtime
assets and agent CLI versions and records the actual built image identity.
Registry state, model responses, websites, marketplace entries, and remote MCP
services may still change between runs. Bounded setup receipts make selected
resolutions auditable; they do not promise identical replay or complete external
state capture. See [the trust model](docs/architecture.md#security-and-trust-boundaries).

## Current limitations

- Claude Code and Codex are built-in agents. Cursor and interactive human
  controllers are not included. Codex uses API-key execution, not ChatGPT login.
- Multi-turn automation uses fixed Ava semantics. Completion providers can be
  supplied by embedding hosts, but compositions cannot replace Ava's lifecycle.
- Deterministic evaluation supports file creation, existence, and regex content
  checks. There are no built-in post-agent test-command or static-analysis checks.
- Anthropic is the only built-in host completion provider. OpenAI host completions
  and other protocols require an embedding implementation, even for Codex runs.
- The built-in Docker adapter accepts the Forge-owned image. Custom images,
  mounts, network policies, and other execution mechanisms need a custom runtime.
- Execution is local, with bounded concurrency and explicit resume. There is no
  distributed scheduler, automatic eval retry loop, remote publisher, or hosted
  execution service. `matrix.retries` does not schedule automatic attempts.
- Marketplace plugins follow the current public catalog entry. Exact authored
  plugin pins, private repository authentication, transitive dependencies, and
  user-defined plugin options are unsupported. Source support differs by agent;
  see [the plugin contract](docs/plugin-action.md#credentials-and-limitations).
- Docker execution and `validate --host` build and verify the runtime image.
  Docker's cache normally reuses layers; cold builds need registry access.
  Ordinary `validate`, `plan`, and a fully skipped resume do not build it.
- Host-file imports verify transferred bytes but do not emit a core setup
  receipt; see [the embedding guide](docs/embedding.md) for the provenance gap.

## Programmatic API

Forge exposes ESM loaders, planning, execution, result verification, and public
composition contracts. Use the [embedding guide](docs/embedding.md) for runnable
single-eval and experiment-run examples, custom providers/endpoints, runtimes,
credential bindings, and publication patterns.

[Forge architecture](docs/architecture.md) explains lifecycle and trust
boundaries. The [codebase guide](docs/codebase-guide.md) maps implementation
files and call paths. Setup extensions use [action bundles](docs/setup-action-bundles.md).

### Public entry points

| Entry point | Purpose |
| --- | --- |
| `@stripe/forge` | Schemas, loaders, planning, execution, evaluation, results, setup, and composition contracts |
| `@stripe/forge/atif` | Current ATIF parser, serializer, normalization types, and constants |
| `@stripe/forge/atif/v1.8` | Explicitly versioned ATIF v1.8 surface |
| `@stripe/forge/cli` | CLI runner and injectable composition seam for host-owned wrappers |
| `@stripe/forge/experiment` | Shared local scheduling, checkpoints, resume, automatic scorecards and their parser/types, verified outcomes, and read-only inspection |
| `@stripe/forge/experiment/cli` | Extensible shared run/resume command stage and operational option definitions |
| `@stripe/forge/agents/claude-code` | Claude Code adapter, stream parser, and evidence loader |
| `@stripe/forge/agents/codex` | Codex adapter, stream parser, and exact-rollout evidence loader |
| `@stripe/forge/providers/anthropic` | Direct Anthropic and Messages-compatible host completion provider |
| `@stripe/forge/runtime/docker` | Forge Docker adapter and pinned runtime metadata |
| `@stripe/forge/setup` | Built-in handlers plus action-bundle and setup-executor contracts |
| `@stripe/forge/testing` | In-memory inputs/workspaces/stores, fake runtime and agent adapters, scripted completion providers, test plans, and runtime conformance checks |
| `@stripe/forge/package.json` | Package metadata |

Only documented package exports are public. Do not import `dist/` files or
undeclared internal paths.

## Development

From a source checkout, install and build as described under
[Installation](#installation). Run the narrowest relevant tests while iterating:

```sh
pnpm test -- path/to/file.test.ts
```

`pnpm check` runs type checking, tests, build, dataset validation, documentation
validation, and package checks. PRs targeting `main`, including drafts, run the
same checks through the [PR workflow](https://github.com/stripe/forge/blob/main/.github/workflows/pr-checks.yml).
The publishing workflow checks and publishes versioned development snapshots
after pushes to `main`; stable release commits are skipped.

`pnpm check:docs` checks documentation links, export inventories, and structured
snippets. `pnpm check:cases` validates checked-in release datasets and harness
fixtures through the public loader without model calls. Sample release bundles
live under [`datasets`](https://github.com/stripe/forge/tree/main/datasets);
harness inputs live under [`test/fixtures`](https://github.com/stripe/forge/tree/main/test/fixtures).

### Opt-in live tests

The single live suite is separate from `pnpm test` and `pnpm check`. Both modes
require Docker and network access. Setup mode exercises real setup actions and
plugin installation without model credentials or upstream model calls:

```sh
FORGE_LIVE=1 FORGE_LIVE_MODE=setup pnpm test:live
```

Full mode is the default and makes potentially billable calls. Run it with the
provider credentials appropriate to the selected agent:

```sh
FORGE_LIVE=1 ANTHROPIC_API_KEY=your-restricted-key pnpm test:live
```

For an Anthropic-compatible endpoint, use `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN` instead. To exercise Codex:

```sh
FORGE_LIVE=1 FORGE_LIVE_AGENT=codex CODEX_API_KEY=your-restricted-key pnpm test:live
```

Optional `OPENAI_BASE_URL` selects a Responses-compatible endpoint. Codex full
mode uses scripted host completions for multi-turn coverage, so it needs no
Anthropic credential. Set `FORGE_LIVE_AGENT=codex` with setup mode to test Codex
setup without upstream calls.

The live suite can create temporary authenticated host bridges for Codex
Responses requests and loopback Claude endpoints. These require
`host.docker.internal` support, such as Docker Desktop. The real upstream key
stays host-side; the container receives a per-run bridge credential. This is
test-suite behavior: the public CLI creates no bridge and requires endpoints
reachable from the container.

Results default to `results/live`. `FORGE_LIVE_RUN_ID` sets the suite/run ID
prefix; `FORGE_LIVE_RESULTS_ROOT` changes the root; `FORGE_LIVE_TIMEOUT_MS` sets
the positive overall timeout (30 minutes by default); and
`FORGE_DOCKER_EXECUTABLE` selects another Docker CLI.

Forge is Apache-2.0 licensed. Third-party attribution is recorded in `NOTICE`;
ATIF provenance and notices are maintained alongside its implementation.
