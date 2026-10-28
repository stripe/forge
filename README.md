# Stripe Forge

Forge runs and compares coding agents, models, and plugins on versioned tasks.
Each evaluation runs in an isolated environment, checks the agent's output,
and saves results and transcripts for inspection. Claude Code, Codex, and an
experimental OpenCode Chat Completions adapter are built in.

Forge is in early development. See the
[architecture and current limitations](docs/architecture.md#current-limitations)
when designing a benchmark.

- [Concept](#concept)
- [Requirements & Credentials](#requirements--credentials)
- [Installation](#installation)
- [Running Experiments](#running-experiments)
- [Results and Scores](#results-and-scores)
- [Development](#development)

## Concept

| Concept | What it means |
| --- | --- |
| Case | One task, its shared setup, interaction mode, checks, and judging criteria. |
| Dataset | A versioned collection of cases and fixtures, with a manifest listing each case's ID, version, and path. |
| Treatment | Setup applied after case setup, such as installing a plugin. A baseline has no additional setup. |
| Experiment | A dataset pin, treatments, agents/models, runtime choices, and a matrix of cases to evaluate. |
| Experiment run | One resumable execution of the selected matrix, with a checkpoint and report. |
| Eval run | One execution attempt for one case, treatment, agent, and repetition. Retries receive new eval run IDs. |

A flat matrix runs every combination of its cases, treatments, and agents.
Grouped matrices let different cases use different treatments or models in
one experiment. Forge resolves each selection into an immutable plan before
execution; running the experiment again creates a separate experiment run.

One-shot cases send a task to the coding agent once. Multi-turn cases use Ava,
Forge's role player, to act as the developer talking to the agent. Ava and the
criterion judge use host-side models independently of the coding agent.

Forge aims to make runs auditable: plans record declared inputs and Forge
identity, setup receipts record selected execution-time resolutions, and
results bind those records to evidence and outcomes. These records do not
promise identical reruns or complete capture of external state.

## Requirements & Credentials

For the built-in CLI, you need:

- Node.js 22 or newer, npm, and Git for installation from source. Forge is ESM-only.
- Git access to this repository. If access is restricted, authenticate Git
  with your GitHub account before installation.
- A running Linux Docker server and Docker CLI supporting `linux/amd64` or
  `linux/arm64`. `platform: native` selects the server's architecture.
- Network access to GitHub and npm for installation, and Docker Hub and npm
  for the first runtime image build. Marketplace treatments also need access
  to their public GitHub marketplace and selected source.
- Capacity for each concurrent eval run. Default runtime limits are 4 GiB
  memory, 2 CPUs, and 512 processes.
- Credentials for the selected coding agent and any host completion models.
  Execution makes potentially billable model calls; ordinary validation does not.

| Workload | Coding-agent credential | Ava/judge credential |
| --- | --- | --- |
| Claude Code, one-shot with checks only | `ANTHROPIC_API_KEY` | None |
| Claude Code with Ava or judging criteria | `ANTHROPIC_API_KEY` | Selected host provider credential |
| Codex, one-shot with checks only | `CODEX_API_KEY` | None |
| Codex with Ava or judging criteria | `CODEX_API_KEY` | Selected host provider credential |
| OpenCode with an OpenAI-compatible endpoint | `OPENCODE_API_KEY` | Selected host provider credential when Ava or judging is used |
| `validate` or `plan` | None | None |

Export the required variables in your shell or credential manager before
running or resuming pending work. Use restricted, short-lived keys with
appropriate account limits: the evaluated agent receives its credential and
outbound network access. Keep secrets outside dataset and experiment files.

Ava and the judge each default to `provider: openai`, `model: gpt-6.1-sol`
when their model is omitted. Override either independently with
`models.role_player` or `models.judge`; the other keeps its default. Both
accept `provider: anthropic` or `provider: openai`. Selecting a coding agent
does not change either host model. For example, to use Sonnet for both:

```yaml
models:
  role_player: { provider: anthropic, model: claude-sonnet-4-6 }
  judge: { provider: anthropic, model: claude-sonnet-4-6 }
```

OpenAI host completions use the Responses API with strict JSON Schema,
`store: false`, and `OPENAI_API_KEY` (credential reference
`openai.completion-api-key`). `OPENAI_BASE_URL` optionally sets the complete
API root, including `/v1`; Forge appends `/responses`. Codex uses the same
endpoint setting but its separate `CODEX_API_KEY` credential. Neither key
falls back to the other. GPT-5 and later and o-series model identifiers omit
`temperature` and receive an output budget of at least 16,000 tokens to allow
for reasoning. Reasoning blocks are excluded from completion text.

The Anthropic provider requires Claude 4.5-or-newer model identifiers with
strict structured-output support. Opus 4.7 and later
and the Claude 5 generation reject explicit sampling parameters, so Forge
omits Ava's and the judge's `temperature` for them and those models use their
default sampling. Claude 5 models always think and thinking counts toward
the output limit, so Forge raises Ava's and the judge's limits to at least
16,000 tokens for them and ignores the returned thinking blocks.

For an Anthropic-compatible service, set both `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`. When the URL is present, the CLI requires that token
instead of selecting `ANTHROPIC_API_KEY`. The service must support the APIs
used by Claude Code and host-side `/v1/messages`, including structured output.

Codex optionally accepts `OPENAI_BASE_URL`, a complete Responses-compatible
API root such as `https://gateway.example.com/v1`. The CLI reads
`CODEX_API_KEY`, without falling back to `OPENAI_API_KEY`. Remote endpoints
must use HTTPS and be reachable from the container; host-side completions
must also reach their endpoint. A host loopback address points at the
container when used by the agent, including names ending in `.localhost`.
A successful host-side request does not prove coding-agent connectivity.
The public CLI creates no host bridge for model endpoints; supply an endpoint
reachable from the container. The development live suite has separate
[gateway bridge support](docs/codebase-guide.md#opt-in-live-tests).

For the [Stripe plugin treatment](docs/plugin-action.md), use
`with: {plugin: stripe}` and export `STRIPE_API_KEY` with an Agent API key.
To use a different host variable, pass
`--credential-env env:STRIPE_API_KEY=STRIPE_TEST_KEY`. Forge keeps this key on
the host and routes the bundled MCP connection through a run-owned credential
relay. The container receives a temporary relay token. Plugin runs need a local
Docker daemon with host reachability; see the [relay contract](docs/plugin-action.md#credentials-and-limitations).
Prepare the account or merchant outside Forge.

OpenCode requires `OPENCODE_BASE_URL`, a Chat Completions API root such as
`https://gateway.example.com/v1`, and `OPENCODE_API_KEY`. This supports the
protocol used by LiteLLM and other compatible gateways; each selected model
must support the configured tools and capabilities. Responses endpoints use
the separate Codex route. See [OpenCode setup](#opencode-setup).

Claude gateways that reject experimental beta headers can opt in with
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Forge records this as
`disable_experimental_betas: true` on each selected Claude agent, includes it
in resume checks, and passes the setting to Claude. `0` clears the override.
The gateway must still support the agent and host judge APIs; validate this
with a complete eval in that environment.

The runtime installs pinned Claude Code, Codex, and OpenCode CLI releases from npm.
Their use remains subject to their providers' terms.

### Additional API credentials

Use `forge/credentials` when agent code needs an API credential independently of
a plugin. Declare variable names in case setup when every treatment, including
baseline, needs them:

```yaml
# case.yaml excerpt
setup:
  - uses: forge/credentials
    with:
      env:
        - API_TOKEN
```

For access specific to one treatment, put the same action in the experiment:

```yaml
# experiment.yaml excerpt
treatments:
  baseline:
    setup: []
  authenticated-api:
    setup:
      - uses: forge/credentials
        with:
          env:
            - API_TOKEN
```

`env` accepts 1–128 unique names matching `[A-Za-z_][A-Za-z0-9_]*`, each at most
255 characters. Supply names only; values stay outside authored files and plans.
The CLI requires an explicit host binding for each additional credential, even
when the host and runtime names match:

```sh
npx --no-install forge run --experiment ./my-eval/experiment.yaml \
  --credential-env env:API_TOKEN=EVAL_API_TOKEN
```

Export `EVAL_API_TOKEN` before running. The agent and its child processes receive
the value as `API_TOKEN`; setup commands do not. Missing bindings or values fail
before runtime allocation. `validate` and `plan` do not read secret values.
Embedding hosts resolve `env:API_TOKEN` through their credential resolver.

This action adds requirements without adding automatic host bindings. Existing
bindings still apply: selecting `forge/plugin` with `plugin: stripe` already
binds `STRIPE_API_KEY` for its host relay. Declaring that key for command
environments in the same run is rejected.

## Installation

Install Forge directly from GitHub source in your consuming project:

```sh
npm install --save-dev git+https://github.com/stripe/forge.git
```

The installation builds the package from source. Commit `package-lock.json`
to retain the resolved Git commit, or append `#<commit-sha>` to the source URL
to select an explicit revision. Keep the same Forge revision when comparing
runs or reading saved artifacts.

The examples below use the locally installed `npx --no-install forge` command.
We plan to publish Forge to npm so it can be installed by package name;
the supported installation path here is GitHub source.

For work on Forge itself, see [Development](#development).

## Running Experiments

### Run your first experiment

Datasets ship with an experiment that runs them. For a working example, copy
the [Stripe integration sample experiment](https://github.com/stripe/forge/tree/main/experiments/stripe-integration-public-evals)
and [dataset](https://github.com/stripe/forge/tree/main/datasets/stripe-integration-public-evals)
into `my-eval/` in the project where you installed Forge, keeping their
relative layout:

```text
my-eval/
├── experiments/stripe-integration-public-evals/experiment.yaml
└── datasets/stripe-integration-public-evals/
    ├── manifest.json
    └── cases/ (73 cases, including payments-onetime.case.yaml)
```

Copy the whole `cases/` directory — the manifest lists all 73 case paths and
`loadDataset` requires each to exist, so a partial copy fails validation even
though the bundled experiment only selects `payments-onetime`. The sample
evaluates a Stripe Checkout integration using Claude Code, Ava, and a
criterion judge. Claude Code uses the Anthropic credential; Ava and the
judge use the default Sol model and the OpenAI completion credential.
The dataset is separate from the installed Forge package; preserve its bytes.
The experiment's `dataset.path` resolves relative to the experiment file.

Validate without Docker allocation or model credentials, then run with your
Anthropic and OpenAI keys configured:

```sh
npx --no-install forge validate --experiment ./my-eval/experiments/stripe-integration-public-evals/experiment.yaml
export ANTHROPIC_API_KEY=your-restricted-key
export OPENAI_API_KEY=your-openai-key
npx --no-install forge run \
  --experiment ./my-eval/experiments/stripe-integration-public-evals/experiment.yaml \
  --output ./results --run-id payments-001 > run-summary.json
```

Execution uses Docker and makes model calls. Progress goes to stderr;
`run-summary.json` contains the experiment run ID, output location, and
checkpoint/report paths. Every invocation without `--resume` starts a new
experiment run. See [Results and Scores](#results-and-scores) to inspect it.

To inspect the resolved plan before execution:

```sh
npx --no-install forge plan --experiment ./my-eval/experiments/stripe-integration-public-evals/experiment.yaml
```

Planning with `platform: native` queries the Docker server's architecture
without building or allocating a runtime. `validate --host` additionally
builds and starts temporary runtimes, installs the selected setup, and checks
configured plugin MCP servers through each agent's native client. It initializes
MCP and discovers tools without invoking them or making model calls. It requires
the required MCP keys, and reports model authentication as untested. Failures
name the stage; temporary runtimes are disposed after success or failure.

For a payment case with Stripe MCP and both agents, use the portable
[plugin experiment](https://github.com/stripe/forge/blob/main/experiments/stripe-integration-public-evals/plugin-experiment.yaml);
its `dataset.path` locates the dataset relative to the experiment file:

```sh
export STRIPE_API_KEY=your-agent-api-key
npx --no-install forge validate --host --experiment ./my-eval/plugin-experiment.yaml
export ANTHROPIC_API_KEY=your-anthropic-key
export OPENAI_API_KEY=your-openai-key
export CODEX_API_KEY=your-codex-key
npx --no-install forge run --experiment ./my-eval/plugin-experiment.yaml --output ./results
```

Use `--agent claude-code` or `--agent codex` to select one adapter. Host-side Ava
and judging use the experiment’s `models` configuration for either agent.

### Docker networking

Docker's normal network is the default. To reach services bound to the host,
set `runtime.network: host` in the experiment, or export
`FORGE_DOCKER_NETWORK=host`. Image builds have a separate opt-in:
`runtime.build_network: host` or `FORGE_DOCKER_BUILD_NETWORK=host`. An explicit
`default` environment value clears the matching authored option.

Set `FORGE_HTTP_PROXY`, `FORGE_HTTPS_PROXY`, and `FORGE_NO_PROXY` when builds
and container commands need a proxy. Forge passes these explicit settings as
standard Docker proxy build args and command environment variables, without
changing image assets. Ambient host proxy variables are not forwarded. URL
credentials are unsupported; these nonsecret addresses are saved in the plan.
They can also be authored as `runtime.proxy.http`, `.https`, and `.no_proxy`.
An empty override clears that proxy field.

These effective settings are saved in the plan; changing them prevents resume
from reusing the old configuration. Host networking shares the host's network
namespace, including ports and loopback. It requires Linux Docker or Docker
Desktop 4.34+ with host networking enabled. Concurrent runs can compete for
ports. See the [runtime boundary](docs/architecture.md#built-in-docker-runtime).

### Select from an experiment

The bundled experiment defines the available cases, treatments, and agents.
CLI case filters use the IDs declared inside the released case files.
`dataset.path` resolves relative to the experiment file.

`run` and `validate` check every matching matrix selection. These optional filters
select existing combinations; `plan` requires exactly one match:

```text
--case <case-id>                 --case-file <path-to-listed-case-file>
--treatment <treatment-id>        --agent <adapter-id>
--provider <provider-id>          --model <model-id>
--repetition <zero-based-index>
--group <group-id>
```

`--case` and `--case-file` are mutually exclusive. For example:

```sh
npx --no-install forge run \
  --experiment ./my-eval/experiments/stripe-integration-public-evals/experiment.yaml \
  --case stripe-integration-public-evals/payments-onetime --treatment baseline --agent claude-code
```

Groups may declare a unique optional `id`; see the
[grouped matrix contract](docs/architecture.md#matrix-expansion-and-selection).
Use `--group <id>` to select that group's combinations, intersected with any
other filters. Unknown IDs and filters matching no combinations are errors.
Plans, results, checkpoints, and report run rows retain `selection.group_id`
for named groups. Omit `--group` on resume; the saved group scope is restored.

`--run-id` names an **eval run** and requires one matching selection. Omit it
for an automatically generated ID. Experiment runs receive their own IDs.

### OpenCode setup

OpenCode support is experimental. Select `adapter: opencode`,
`provider: openai-compatible`, and the exact gateway model alias in your
experiment matrix. Embedded slashes in the model name are preserved.

Supply `opencode.json` with ordinary case or treatment setup. Its
`provider.forge.models` entry must match the experiment's `model`, with
explicit limits and capabilities. For example, a treatment for an endpoint
that exposes `gateway-code` could contain:

```yaml
setup:
  - uses: forge/write
    with:
      target: opencode.json
      source:
        content: |
          {"provider":{"forge":{"models":{"gateway-code":{
            "limit":{"context":32000,"output":4000},
            "reasoning":false,"temperature":true,
            "attachment":false,"tool_call":true
          }}}}}
```

Use the model's actual limits and capabilities. The adapter requires tool
support and controls API routing and credentials separately from this authored
configuration. Keep keys and endpoints out of the setup file:

```sh
export OPENCODE_BASE_URL=https://gateway.example.com/v1
export OPENCODE_API_KEY=your-restricted-key
npx --no-install forge run --experiment ./my-eval/experiment.yaml --agent opencode
```

For a plugin comparison, use two named treatments, `no-plugin` and
`stripe-plugin`, with the same model configuration above in each. Add
`uses: forge/plugin` with `with: {plugin: stripe}` only to `stripe-plugin`.
The plugin arm receives account access through MCP. Use `forge/credentials`
only for arms that need direct API access; that action exposes its declared
key to tool shells and cannot share the plugin relay key. Keep shared treatment
setup out of the reserved `baseline`, which requires an empty setup list.

OpenCode loads Stripe's standard skills-and-MCP bundle from the source commit
selected by the same official marketplace used for Codex. It does not load
Claude-specific hooks or commands. See the [plugin contract](docs/plugin-action.md)
for installation provenance and the catalog's rolling revision semantics.

To send some OpenCode models to a different endpoint than the rest, set a
host-side routing table. `OPENCODE_MODEL_ROUTES` maps exact experiment model
names to endpoint names; each endpoint reads its API root from
`OPENCODE_ENDPOINT_<NAME>_BASE_URL` and its key from
`OPENCODE_ENDPOINT_<NAME>_API_KEY` (credential reference
`opencode.endpoint.<name>.api-key`). Unlisted models keep `OPENCODE_BASE_URL`
and `OPENCODE_API_KEY`:

```sh
export OPENCODE_MODEL_ROUTES='qwen/qwen4-coder=openrouter,kimi-k3=openrouter'
export OPENCODE_ENDPOINT_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
export OPENCODE_ENDPOINT_OPENROUTER_API_KEY=your-openrouter-key
```

Routing is host configuration: experiment files and saved plans do not record
which endpoint served a model, so keep the same routing when resuming.

The CLI credential reference is `opencode.api-key`; use
`--credential-env opencode.api-key=MY_GATEWAY_KEY` to bind another environment
variable. Ava and judging keep their independent `models` configuration.
See the [adapter contract and limitations](docs/architecture.md#coding-agent-adapters)
for configuration isolation and native evidence behavior.

### Concurrency and resume

Use `--jobs <count>` (or `-j`) to limit concurrent eval runs; the default is 1:

```sh
npx --no-install forge run --experiment ./my-eval/experiments/stripe-integration-public-evals/experiment.yaml --jobs 4
```

Each run owns its runtime and artifacts. Size concurrency for host resources
and provider rate limits. A failed execution is recorded while other selections
continue. Each invocation attempts pending selections once; `matrix.retries`
does not schedule automatic retries.

To resume, use the printed experiment run ID and original output root, with
credentials configured again if work remains:

```sh
npx --no-install forge run \
  --experiment ./my-eval/experiments/stripe-integration-public-evals/experiment.yaml \
  --output ./results --resume EXPERIMENT_RUN_ID --jobs 2
```

Resume restores the saved selections and filters. Omit selection options and
`--run-id`; bare `--resume` is a usage error. The resolved plans and Forge
producer identity must match; operational concurrency may change.

Forge verifies completed artifacts before skipping them. Failed or partial
evaluations remain completed; execution errors and missing or invalid artifacts
are retried with fresh eval run IDs. Earlier attempts remain saved. Only one
process may execute an experiment run at a time. Resume can also rebuild a
missing or corrupt report without rerunning valid completed evals.

Exit code 0 means execution completed and the report was saved, regardless of
evaluation scores. Exit code 1 means execution errors remain or report generation
failed. See [recovery semantics](docs/architecture.md#failure-cancellation-and-cleanup-semantics)
for interruption and cleanup details.

## Results and Scores

Artifacts are saved under the experiment run ID:

```text
results/experiments/<experiment-run-id>/
├── experiment.json
├── report.json
└── runs/<eval-run-id>/
    ├── result.json
    ├── plan.json
    ├── setup.json
    ├── trajectory.json
    └── interaction.json
```

| File | Purpose |
| --- | --- |
| `experiment.json` | Checkpoint, selected plans, and attempt history used for resume. |
| `report.json` | Scorecard across the saved experiment selections. |
| `result.json` | Evaluation at `.evaluation`, provenance, and companion artifact descriptors. |
| `plan.json` | Resolved input for one eval run. |
| `setup.json` | Ordered, bounded setup receipts. |
| `trajectory.json` | Normalized, credential-redacted ATIF transcript. |
| `interaction.json` | Turn history and stop reason, including Ava's private audit data. |

For the first experiment, print its evaluation:

```sh
node --input-type=module <<'JS'
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
const summary = JSON.parse(await readFile('run-summary.json', 'utf8'));
const result = JSON.parse(await readFile(
  path.join(summary.location, 'runs', 'payments-001', 'result.json'), 'utf8',
));
console.log(result.evaluation);
JS
```

### Understand scores

Numeric `score` is the fraction of valid MUST and SHOULD judgments that passed.
Judge errors are excluded; the score is `null` if every scored criterion errored.
`requirement_level` classifies each criterion as `MUST` (required),
`SHOULD` (recommended), or `OPTIONAL` (non-scoring telemetry). Omitted values
default to `SHOULD`. Both MUST and SHOULD contribute equally to the score;
OPTIONAL judgments are retained but affect neither score nor evaluation status.
File checks are additional pass/fail constraints and do not change the fraction.

Criteria may be strings or objects; a string becomes an unlabeled SHOULD
criterion. MUST criteria must use uppercase `MUST` or `MUST NOT` in their text.
This writing guardrail does not infer or change the requirement level. See
[criterion authoring](docs/architecture.md#criterion-judging) for the format.

| Outcome | Meaning |
| --- | --- |
| `passed` | All checks and scored criteria passed. A checks-only pass has score `0`. |
| `partial` | Some scored criteria passed, or checks passed while scored criteria did not all pass. |
| `failed` | The completed evaluation did not establish a pass or partial success. |
| `judge_error` | At least one scored criterion could not be judged; valid judgments and checks remain recorded. |
| Execution error | The selection did not complete successfully and can be retried. |

For nine scored criteria, six passes, two failures, and one judge error give a
score of `0.75` and status `judge_error`. Each errored criterion records
`passed: null` and an `error` with its type, attempt count, and diagnostic
message; `judging_criteria_errored` counts MUST and SHOULD errors.
Interaction stop reasons are separate from evaluation status: reaching
`max_turns` can still produce a pass.

`report.json` contains an overall `summary`, per-case/configuration `cases`,
and one `runs` row per saved selection. Codex MCP dispatch refusals appear as
warnings in saved results and report rows, even when native evidence falls back.
Codex reports missing counts as unavailable. The absence of a warning does not
prove that tools work.
See the [artifact contract](docs/architecture.md) for scope and format.
With optional `jq`:

```sh
jq '.cases[] | {case_id, treatment, agent, completed, errored, judge_errors, pass_rate, judging_score, criterion_scores, criteria_by_requirement}' \
  results/experiments/EXPERIMENT_RUN_ID/report.json
```

`coverage` is completed selections divided by all saved selections.
`pass_rate` is passed evaluations divided by completed evaluations without
scored judge errors, or `null` when none qualify. `judging_score.mean` includes
completed evaluations with at least one valid scored judgment; checks-only
runs contribute to pass rate. `judge_errors` separately counts affected
evaluations and errored criteria in the summary and each case/configuration,
including errors on OPTIONAL criteria.
These errors remain committed outcomes on resume; they do not rerun the coding
agent. Ratios range from 0 to 1. Only the latest verified effective outcome
contributes for each selection, so retries do not add scores. Compare treatments
on matched cases and agent configurations. See
[scoring semantics](docs/architecture.md#evaluation-and-scoring).

`criterion_scores` reports Required and Recommended scores in each run's
`evaluation`, the overall summary, and each case/configuration group:

| Criteria set | `strict` | `avg` |
| --- | --- | --- |
| `required`: MUST | `1` if all MUST pass, else `0` | Passed MUST / total MUST |
| `recommended`: MUST + SHOULD | `1` if all MUST and SHOULD pass, else `0` | Passed MUST and SHOULD / total MUST and SHOULD |

For example, passing one MUST and failing one SHOULD gives Required Strict and
Avg of `1`, Recommended Strict of `0`, and Recommended Avg of `0.5`. OPTIONAL
and file checks do not affect these scores. An empty set has `null` scores.
For summary and case groups, `strict` is the fraction of eligible evaluations
where all relevant criteria passed. `avg` pools their passed/total counts, so
each criterion result has equal weight across runs. Each set's `evaluations`
counts completed evaluations with at least one relevant criterion; empty sets,
pending runs, and execution errors do not enter either denominator.

`criterion_scores.blend.score` combines a hard MUST gate with the SHOULD average.
Any failed MUST gives `0`; otherwise the score is passed SHOULD / total SHOULD.
For example, passing all MUST and half the SHOULD gives `0.5`; failing one MUST
gives `0` even if every SHOULD passes. Without MUST, Blend is the SHOULD average.
Without SHOULD, it is `1` if all MUST pass, else `0`. With neither, it is `null`.
OPTIONAL criteria and file checks do not affect Blend.

Summary and case groups average the per-evaluation Blend scores with equal
weight, including zeros from failed MUST gates. Their `blend.evaluations` counts
completed evaluations with any MUST or SHOULD; empty, pending, and errored runs
are excluded. Blend is a report view; saved evaluation `score`, `status`, and
`pass_rate` retain the rules above.

Judge errors never count as failures. A set containing an errored criterion has
`null` Strict for that evaluation and casts no Strict vote in aggregates; Avg
counts only judged criteria. A judged MUST failure still gives Blend `0`; MUST
errors without one leave Blend `null`, and SHOULD errors drop out of its SHOULD
fraction. Groups average Blend over evaluations whose Blend is not `null`.

`criteria_by_requirement` breaks out MUST, SHOULD, and OPTIONAL in the summary,
case groups, and run rows, retaining passed, total, and errored criterion counts.
Aggregate `evaluations` counts completed evaluations containing that group.
`fully_judged_evaluations` counts those with no errors in that group;
`strict_pass_rate` is the fraction of them where every criterion in the group
passed. `judged_evaluations` counts evaluations with at least one valid judgment
in the group; `average_pass_rate` is their mean fraction of valid judgments that
passed, giving each evaluation equal weight. Rates are `null` when no evaluations
qualify. These group rates ignore file checks. MUST failures identify unmet
requirements; SHOULD failures identify unmet recommendations. OPTIONAL
statistics are telemetry and do not enter either scored group.

Execution errors appear in the experiment's `experiment.json` attempt history
and `report.json` run rows. When available, `diagnostic` records the phase,
a timeout/cancellation/failure reason, and a bounded, credential-redacted message,
even if the run failed before saving artifacts. The same detail appears in
stderr progress events. Older attempts and custom host callback failures may
have only `error_code`. For a committed Ava failure, `result.json.failure.message`
records the final request or output rejection reason; raw rejected responses
are not saved.

### Inspect evidence

Runs may also contain `workspace-evidence.json`, `judge-evidence.json`, and
`native/<adapter>/session.*` (JSON for OpenCode, JSONL for Claude Code and Codex).
The **native log is unredacted and restricted**;
preserve its access controls when copying or publishing artifacts. Normalized
transcripts redact exact resolved secret values, without detecting transformed
or partial leaks.

`result.json` is the atomic commit marker. Its descriptors identify companion
sizes and digests; programmatic consumers use `verifyCompletedRun(location)`
before trusting them. Saved artifacts record their producing Forge version:
official releases require an exact reader version, while development versions
use current strict schemas on a best-effort basis. Reports are derived
snapshots and can be stale after interruption.

See the [evidence and artifact architecture](docs/architecture.md#evidence-architecture)
for verification, judge-visible projections, and fidelity limits.

### Regrade saved runs

`forge regrade` judges a saved experiment run again with a different judge,
without re-running any coding agent or Ava turn. Each completed run is verified
first. Its transcript is projected from the saved `trajectory.json`, and its
workspace text comes from the saved `judge-evidence.json`, so the new judge
receives the same evidence and prompt as the original judge:

```sh
npx --no-install forge regrade \
  --experiment-run ./results/experiments/EXPERIMENT_RUN_ID \
  --judge-provider anthropic --judge-model claude-opus-4-6 \
  --output ./regrades/opus-4-6 --jobs 4
```

The source experiment run is only read; `--output` must be a new location
outside it. Each regrade is written to `runs/<run-id>.json` there, with the
judge, the new evaluation, its completion calls, and digests of the saved
inputs. `report.json` aggregates the regraded evaluations with the standard
report format, and `regrade.json` summarizes the invocation. Rerunning the same
command reuses regrades for the same judge and committed result, so an
interrupted regrade can be continued. An output that already holds regrades
from another judge reports those runs as failed instead of mixing judges.

Deterministic file checks are not re-run, because the workspace is gone after
a run; each regrade keeps the run's original check results. The judge sees
only the bounded workspace excerpts captured at run time. Runs without judging
criteria keep their checks-only evaluation. Runs that could not be regraded
appear as pending in the regrade report, and the command exits with status 1.
Library hosts can call `regradeCompletedRun` and `regradeExperimentRun` from
`@stripe/forge/regrade`.

## Development

Development requires Node.js 22.12 or newer. From a source checkout with
dependencies installed, run tests, type-check, and run Biome:

```sh
pnpm test
pnpm run typecheck
pnpm biome check .
```

Use `pnpm test path/to/file.test.ts` to select tests or `pnpm test:watch`
for Vitest watch mode.

See [development and verification](docs/codebase-guide.md#development-and-verification)
for setup, tests, automatic fixes, and the full check suite.
