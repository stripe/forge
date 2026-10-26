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
- Credentials for the selected coding agent and any Ava/judge models.
  Execution makes potentially billable model calls; ordinary validation does not.

| Workload | Required grants |
| --- | --- |
| Claude Code, one-shot with checks only | `--credential-env ANTHROPIC_API_KEY` |
| Claude Code with default Ava or judge models | `--credential-env ANTHROPIC_API_KEY --credential-env OPENAI_API_KEY` |
| Codex, one-shot with checks only | `--credential-env OPENAI_API_KEY` |
| Codex with default Ava or judge models | `--credential-env OPENAI_API_KEY` |
| OpenCode, one-shot with checks only | `--credential-env OPENCODE_API_KEY` |
| OpenCode with default Ava or judge models | `--credential-env OPENCODE_API_KEY --credential-env OPENAI_API_KEY` |
| `validate` or `plan` | None |

Export the required variables in your shell or credential manager and grant
each one explicitly when running or resuming pending work. Exporting a variable
or selecting an agent, provider, or plugin does not authorize access to secrets.
`--credential-env NAME` authorizes only selected agent and setup declarations that
request that runtime variable, including custom declarations, plus built-in
Ava/judge providers that use it. One `--credential-env OPENAI_API_KEY` therefore
covers Codex, Ava, and the judge when all use OpenAI. Reusing a credential
reference under a different requested variable name needs its own grant.
Grants do not forward undeclared variables or bind unused providers.
Use restricted, short-lived keys with appropriate account limits: the evaluated
agent receives its credential and outbound network access. Keep secrets outside
dataset and experiment files.

Ava and the judge each default to `provider: openai`, `model: gpt-6.1-sol`
when their model is omitted. Both leave sampling at the model default and
request no temperature. Override either independently with
`models.role_player` or `models.judge`; the other keeps its default. Both
accept `provider: anthropic` or `provider: openai`. Selecting a coding agent
does not change either host model. For example, to use Sonnet for both:

```yaml
models:
  role_player: { provider: anthropic, model: claude-sonnet-4-6 }
  judge: { provider: anthropic, model: claude-sonnet-4-6 }
```

OpenAI Ava/judge models use `--credential-env OPENAI_API_KEY`. They use the
Responses API with strict JSON Schema and `store: false`. `OPENAI_BASE_URL`
optionally sets the complete API root, including `/v1`; Forge appends
`/responses`. GPT-5 and later and o-series model identifiers receive an output
budget of at least 16,000 tokens to allow for reasoning.
Reasoning blocks are excluded from completion text.

Anthropic Ava/judge models use `--credential-env ANTHROPIC_API_KEY` and require
Claude Haiku, Sonnet, or Opus 4.5-or-newer model identifiers with strict
structured-output support. Claude Fable is not supported yet as the judge or
Ava model; Forge rejects it during pure preflight, before credential lookup
or model requests. Coding-agent model selection is separate.
Haiku, Sonnet, and Opus models at version 5 or newer always think, and thinking
tokens share the output budget with answer text. Forge gives them at least
16,000 output tokens and excludes thinking blocks from completion text.

For an Anthropic-compatible service, set both `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`. When the URL is present,
`--credential-env ANTHROPIC_AUTH_TOKEN` covers selected Claude Code and
Anthropic Ava/judge models. The CLI requires that token instead of selecting
`ANTHROPIC_API_KEY`. The service must support the APIs used by Claude Code and
host-side `/v1/messages`, including structured output.

Codex optionally accepts `OPENAI_BASE_URL`, a complete Responses-compatible
API root such as `https://gateway.example.com/v1`. Grant
`--credential-env OPENAI_API_KEY`. Remote endpoints must use HTTPS and be
reachable from the container; host-side completions must
also reach their endpoint. A host loopback address points at the
container when used by the agent, including names ending in `.localhost`.
A successful host-side request does not prove coding-agent connectivity.
The public CLI creates no host bridge; supply an endpoint reachable from
the container. The development live suite has separate
[gateway bridge support](docs/codebase-guide.md#opt-in-live-tests).

For the [Stripe plugin treatment](docs/plugin-action.md), use
`with: {plugin: stripe}`, export `STRIPE_API_KEY` with an Agent API key, and
grant `--credential-env STRIPE_API_KEY`. To use a different host variable, pass
`--credential-env env:STRIPE_API_KEY=STRIPE_TEST_KEY`; the agent still receives
`STRIPE_API_KEY`.
Forge selects the distribution for the run's agent and configures its bundled
MCP connection. The token reaches only agent commands; prepare the account or
merchant outside Forge.

OpenCode requires `OPENCODE_BASE_URL`, a Chat Completions API root such as
`https://gateway.example.com/v1`, and an explicit
`--credential-env OPENCODE_API_KEY` grant. This supports the
protocol used by LiteLLM and other compatible gateways; each selected model
must support the configured tools and capabilities. Responses endpoints use
the separate Codex route. See [OpenCode setup](#opencode-setup).

The runtime installs pinned Claude Code, Codex, and OpenCode CLI releases from npm.
Their use remains subject to their providers' terms.

### Advanced credential bindings

Use `--credential-env reference=HOST_VAR` to bind every use of one credential
reference to a host variable. The text before `=` always names a
reference, even when it looks like an environment variable name. For example,
Codex and OpenAI Ava/judge models can use different exported variables:

```sh
npx --no-install forge run --experiment ./experiment.yaml \
  --credential-env openai.api-key=CODEX_KEY \
  --credential-env openai.completion-api-key=EVAL_KEY
```

Codex receives `CODEX_KEY` as `OPENAI_API_KEY`; only Ava and the judge receive
`EVAL_KEY`. Anthropic's corresponding completion references are
`anthropic.completion-api-key` and, for a compatible service,
`anthropic.completion-auth-token`. Conflicting bindings are rejected: a
same-name grant cannot also bind one of its selected consumers to a different
host variable. Use explicit reference bindings for each consumer when keys differ.

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
The CLI requires an explicit grant for each credential. For the sample's Claude
Code and default OpenAI Ava/judge models, with `API_TOKEN` declared as above:

```sh
npx --no-install forge run --experiment ./my-eval/experiment.yaml \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
  --credential-env API_TOKEN
```

Export `API_TOKEN` before running. To read `EVAL_API_TOKEN` instead, replace its
grant with `--credential-env env:API_TOKEN=EVAL_API_TOKEN`. The agent and its child
processes receive the value as `API_TOKEN`; setup commands do not. Missing
grants or values fail before runtime allocation. `validate` and `plan` require
neither grants nor secret values. Embedding hosts resolve the opaque reference
`env:API_TOKEN` through their credential resolver.

If a selected agent or plugin already declares a runtime name, there is no need
to repeat it in `forge/credentials`. Duplicate declarations for one runtime name
can combine when every reference is explicitly authorized to the same host
variable, including declarations from custom setup actions. Different host
variables conflict even if their values happen to match. Validation checks
declarations and known aliases without reading secrets; custom references need
nonsecret compatibility information from the embedding host when they differ.
Successful validation does not establish that a future run has grants or values.

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

Released datasets ship with experiments that run them. Copy the contents of
[`release/`](https://github.com/stripe/forge/tree/main/release) into `my-eval/`
in the project where you installed Forge:

```text
my-eval/
├── README.md
├── datasets/stripe-integration-public-evals/
│   ├── manifest.json
│   └── cases/ (69 case files)
└── experiment.yaml
```

The dataset has 69 cases covering Connect, Payments, and Subscriptions. Copy
the whole `cases/` directory; dataset loading requires every listed case file.
The sample experiment selects `payments-onetime`, a Stripe Checkout integration,
using Claude Code, Ava, and a criterion judge. Claude Code uses the Anthropic
credential; Ava and the judge use the default Sol model and the OpenAI
completion credential.
The release inputs are separate from the installed Forge package; preserve
their bytes. The experiment's
`dataset.path: ./datasets/stripe-integration-public-evals` resolves relative
to the experiment file. Copy the whole release directory so configuration
needs no rewriting.

Validate without Docker allocation or model credentials, then run with your
Anthropic and OpenAI keys configured:

```sh
npx --no-install forge validate --experiment ./my-eval/experiment.yaml
export ANTHROPIC_API_KEY=your-restricted-key
export OPENAI_API_KEY=your-openai-key
npx --no-install forge run \
  --experiment ./my-eval/experiment.yaml \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
  --output ./results --run-id payments-001 > run-summary.json
```

Execution uses Docker and makes model calls. Progress goes to stderr;
`run-summary.json` contains the experiment run ID, output location, and
checkpoint/report paths. Every invocation without `--resume` starts a new
experiment run. See [Results and Scores](#results-and-scores) to inspect it.

To inspect the resolved plan before execution:

```sh
npx --no-install forge plan --experiment ./my-eval/experiment.yaml
```

Planning with `platform: native` queries the Docker server's architecture
without building or allocating a runtime. `validate --host` additionally
builds the runtime image and probes the host without making model calls.

### Select from an experiment

The released experiment defines the available cases, treatments, and agents.
CLI case filters use the IDs declared inside the released case files.
`dataset.path` resolves relative to the experiment file.

`run` executes every matching matrix selection. These optional filters
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
  --experiment ./my-eval/experiment.yaml \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
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

Declare the model's actual limits and capabilities once on the agent selection,
so every treatment uses the same definition:

```yaml
matrix:
  agents:
    - adapter: opencode
      provider: openai-compatible
      model: gateway-code
      model_profile:
        limit: { context: 32000, output: 4000 }
        reasoning: false
        temperature: true
        attachment: false
```

`model_profile` is required for OpenCode. Limits must be positive safe integers,
with output no greater than context; all three capabilities are explicit
booleans. Unknown fields are rejected. Claude Code and Codex reject this field.
The adapter sets `tool_call: true`, so the model must support tools. A workspace
`opencode.json` is ignored. API routing and credentials stay outside the
experiment:

```sh
export OPENCODE_BASE_URL=https://gateway.example.com/v1
export OPENCODE_API_KEY=your-restricted-key
export OPENAI_API_KEY=your-openai-key
npx --no-install forge run --experiment ./my-eval/experiment.yaml --agent opencode \
  --credential-env OPENCODE_API_KEY \
  --credential-env OPENAI_API_KEY
```

For a plugin comparison, select `baseline` and `stripe-plugin` in the matrix.
Keep `baseline.setup: []`; add `uses: forge/plugin` with
`with: {plugin: stripe}` only to `stripe-plugin`. Both use the model profile
above. If both arms need Stripe account access, declare `forge/credentials`
with `env: [STRIPE_API_KEY]` in case setup and pass
`--credential-env env:STRIPE_API_KEY=STRIPE_API_KEY`.

OpenCode loads skills and MCP from the same Claude-format Stripe plugin used
by Claude Code and Codex. It does not load Claude-specific hooks, commands, or
agents. As with Codex, the Stripe marketplace is the trust root: Forge fetches
its catalog at unpinned HEAD and trusts its source SHA and the bundle's MCP URL.
The agent sends the `STRIPE_API_KEY` bearer to that URL; Forge does not restrict
its host or require HTTPS. The receipt records the catalog commit and installed
contents, but does not pin future installs. See the
[plugin contract](docs/plugin-action.md) for installation provenance and source
selection.

The CLI credential reference is `opencode.api-key`; use
`--credential-env opencode.api-key=MY_GATEWAY_KEY` to bind another environment
variable. Ava and judging keep their independent host-model configuration;
the example grants OpenAI access for their defaults. One-shot cases with only
deterministic checks need no host-model credential.
See the [adapter contract and limitations](docs/architecture.md#coding-agent-adapters)
for configuration isolation and native evidence behavior.

### Concurrency and resume

Use `--jobs <count>` (or `-j`) to limit concurrent eval runs; the default is 1:

```sh
npx --no-install forge run --experiment ./my-eval/experiment.yaml \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
  --jobs 4
```

Each run owns its runtime and artifacts. Size concurrency for host resources
and provider rate limits. A failed execution is recorded while other selections
continue. Each invocation attempts pending selections once; `matrix.retries`
does not schedule automatic retries.

To resume, use the printed experiment run ID and original output root, with
credentials configured and granted again if work remains:

```sh
npx --no-install forge run \
  --experiment ./my-eval/experiment.yaml \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
  --output ./results --resume EXPERIMENT_RUN_ID --jobs 2
```

Resume restores the saved selections and filters. Omit selection options and
`--run-id`; bare `--resume` is a usage error. The resolved plans and Forge
producer identity must match; operational concurrency may change.

Forge verifies completed artifacts before skipping them. Failed or partial
evaluations remain completed; execution errors and missing or invalid artifacts
are retried with fresh eval run IDs. Earlier attempts remain saved. Only one
process may execute an experiment run at a time. Resume can also rebuild a
missing or corrupt report without rerunning valid completed evals. When every
eval is verified complete, resume needs no credential grants or secret values.

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
and one `runs` row per saved selection. With optional `jq`:

```sh
jq '.cases[] | {case_id, treatment, agent, completed, errored, judge_errors, pass_rate, criterion_scores}' \
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
`evaluation`, the overall summary, and each case/configuration group. These
views keep judge errors separate from failures through `judge_errors`. Strict
is `null` for an empty set or any errored judgment in that set. Avg uses only
valid pass/fail judgments and is `null` when none remain.
For fully judged, nonempty sets:

| Criteria set | `strict` | `avg` |
| --- | --- | --- |
| `required`: MUST | `1` if all MUST pass, else `0` | Passed MUST / total MUST |
| `recommended`: MUST + SHOULD | `1` if all MUST and SHOULD pass, else `0` | Passed MUST and SHOULD / total MUST and SHOULD |

For example, passing one MUST and failing one SHOULD gives Required Strict and
Avg of `1`, Recommended Strict of `0`, and Recommended Avg of `0.5`. OPTIONAL
and file checks do not affect these scores. An empty set has `null` scores.
For summary and case groups, `strict` is the fraction of fully judged, nonempty
evaluations where all relevant criteria passed. `avg` pools passed/valid counts,
including valid judgments from partly judged evaluations, so each criterion
result has equal weight across runs. Each set's `evaluations` counts completed
evaluations containing that set, including those with judge errors; it is not
the Strict or Avg denominator. Empty sets, pending runs, and execution errors
contribute to neither score. Each score is `null` when its denominator is zero.

`criterion_scores.blend.score` combines a hard MUST gate with the SHOULD average.
Any judged MUST failure gives `0`, even alongside MUST errors. Otherwise, any
MUST error leaves the gate unresolved and Blend is `null`. Once all MUST pass,
the score is passed SHOULD / valid SHOULD. For example, passing all MUST and
half the valid SHOULD gives `0.5`; failing one MUST gives `0` even if every
SHOULD passes. SHOULD-only cases use their valid pass fraction; MUST-only
cases get `1` when all MUST pass. After a passing MUST gate, a nonempty but
all-error SHOULD set gives `null`. An empty view is `null`. OPTIONAL criteria
and file checks do not affect Blend.

Summary and case groups average the non-null per-evaluation Blend scores with
equal weight, including zeros from failed MUST gates. Their `blend.evaluations`
counts those completed evaluations; unresolved scores, pending runs, and
execution errors are excluded. Blend is a report view; saved
evaluation `score`, `status`, and `pass_rate` retain the rules above.

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
and `report.json` run rows. When available, the attempt's `diagnostic` records
the phase, a timeout/cancellation/failure reason, and a bounded,
credential-redacted message, even if the run failed before saving artifacts.
The attempt's optional `error_phase` retains the known phase independently of
message detail. Only the engine mints execution diagnostics; host-added ones
are ignored, and malformed diagnostics are dropped before checkpoint writes.
After credentials are resolved, any `Error.message` can become a redacted
diagnostic. Custom adapters and providers must keep sensitive data other than
resolved credentials out of error messages.
Attempt diagnostics and stderr progress can include role-player provider error
text. Report rows retain only the stable `error_code` and `diagnostic.phase`,
without diagnostic messages or reasons. Older attempts and plain host callback
failures may have only `error_code`; host-thrown Forge errors also retain a valid
phase, without trusting host-authored diagnostic text. For a committed Ava failure,
`result.json.failure.message` records the final request or output rejection
reason; raw rejected responses are not saved.

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
use current strict schemas on a best-effort basis. Report readers and writers
must use matching shapes, including after a rollout or revert: readers that
require `criterion_scores` reject reports missing it, and earlier readers
reject the added fields. For compatible saved plans and results, `--resume`
regenerates the report without rerunning verified completed evals. Reports are
derived snapshots and can be stale after interruption.

See the [evidence and artifact architecture](docs/architecture.md#evidence-architecture)
for verification, judge-visible projections, and fidelity limits.

When using Forge as a library, you can
[supply your own Dockerfile](docs/architecture.md#custom-docker-images) while
reusing its container lifecycle. The CLI uses the packaged image.

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

Compare saved verdicts and scores with the source run without model calls or
credentials:

```sh
npx --no-install forge regrade diff \
  --experiment-run ./results/experiments/EXPERIMENT_RUN_ID \
  --regrade ./regrades/opus-4-6
```

The diff prints verdict agreement overall and by MUST, SHOULD, and OPTIONAL,
each run's score change (regrade minus source), the mean change, flipped
criteria, and judge errors on either side. Agreement counts only criteria with
pass/fail verdicts on both sides; two errors do not count as agreement. OPTIONAL
verdicts count toward agreement but keep their usual exclusion from scores.
Null scores do not enter the mean change. Empty denominators display as `n/a`
(`null` in JSON). Add `--json` for structured output.

Missing regrades are listed separately, and checks-only runs are not compared.
The command reads the latest verified completed attempts and does not use the
reports, which may be stale. Regrades must match their source result digest and
ordered criterion definitions, and must all use the same judge. Differences,
judge errors, and missing regrades still exit with status 0; invalid input or
mismatched artifacts exit nonzero.

Library hosts can call `regradeCompletedRun`, `regradeExperimentRun`, and
`diffRegradeExperimentRun` from `@stripe/forge/regrade`. `compareRegradeResults`
provides the pure comparison over loaded source evaluations, result digests,
and regrades.

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
