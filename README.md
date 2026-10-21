# Stripe Forge

Forge runs and compares coding agents, models, and plugins on versioned tasks.
Each evaluation runs in an isolated environment, checks the agent's output,
and saves results and transcripts for inspection. Claude Code and Codex are
built in.

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
| Dataset | A versioned collection of cases and fixtures, with an exact inventory of their sizes and hashes. |
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
| Claude Code with Ava or judging criteria | `ANTHROPIC_API_KEY` | Uses the same Anthropic configuration |
| Codex, one-shot with checks only | `CODEX_API_KEY` | None |
| Codex with Ava or judging criteria | `CODEX_API_KEY` | Independently configured Anthropic credential |
| `validate` or `plan` | None | None |

Export the required variables in your shell or credential manager before
running or resuming pending work. Use restricted, short-lived keys with
appropriate account limits: the evaluated agent receives its credential and
outbound network access. Keep secrets outside dataset and experiment files.

The built-in Ava/judge provider is Anthropic and requires Claude 4.5-or-newer
model identifiers with strict structured-output support. Selecting Codex as
coding agent does not change that provider.

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
The public CLI creates no host bridge; supply an endpoint reachable from
the container. The development live suite has separate
[gateway bridge support](docs/codebase-guide.md#opt-in-live-tests).

The runtime installs pinned Claude Code and Codex CLI releases from npm.
Their use remains subject to their providers' terms.

### Stripe merchant

Declare `merchant` when the agent needs a Stripe account. It is the only source
of `STRIPE_API_KEY`: agent code and the
[Stripe plugin treatment](docs/plugin-action.md) read that variable, and the
plugin requires a merchant.

```yaml
# experiment.yaml excerpt
merchant:
  recipe: default
treatments:
  baseline:
    setup: []
  stripe-plugin:
    setup:
      - uses: forge/plugin
        with:
          plugin: stripe
```

`recipe` names the account state the experiment expects and defaults to
`default`. It starts with a lowercase letter or digit, continues with lowercase
letters, digits, `.`, `_`, or `-`, is at most 128 characters, and is recorded
in each plan.

The CLI does not create, prepare, or clean up accounts. Export a Stripe secret
key, such as a sandbox key from [docs.stripe.com](https://docs.stripe.com) or
your account's Dashboard, before running. Plugin treatments need an Agent API
key, which their MCP connection requires.

```sh
export STRIPE_API_KEY=sk_test_...
npx --no-install forge run --experiment ./my-eval/experiment.yaml
```

To read another host variable, pass
`--credential-env stripe-merchant:default=STRIPE_TEST_KEY`; the agent still
receives `STRIPE_API_KEY`. The CLI rejects bindings that match no planned
merchant, including `env:STRIPE_API_KEY`. Every run in the experiment uses the
same key, so state created by one run is visible to later runs. The key reaches
only agent commands, and Forge redacts its value from outputs.

Embedding hosts can provision a fresh merchant for each run instead:

```ts
import { createMerchantCredentialResolver } from '@stripe/forge';

const credentialResolver = createMerchantCredentialResolver({
  // Called once per eval run attempt, before its runtime is allocated.
  async provision(recipe, { runId, signal }) {
    return createMerchantApiKey({ recipe, runId, signal });
  },
  // Resolves every other credential, such as model keys.
  fallback: baseCredentialResolver,
});
```

Pass the resolver as `composition.credentialResolver` to `executeEval`. A failed
or empty provision fails the run before its runtime is allocated. Retries
provision again, and the host owns cleanup, including attempts that fail after
provisioning.

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

This action adds requirements without adding automatic host bindings. It
rejects `STRIPE_API_KEY`, which only the [Stripe merchant](#stripe-merchant)
supplies.

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

Dataset releases include an experiment and its dataset bundle. Run the
supplied experiment with the released inputs. For a working example, copy
`experiment.yaml` and the complete `dataset/` directory from the
[Stripe integration sample release](https://github.com/stripe/forge/tree/main/datasets/stripe-integration-public-evals/0.1.0)
into `my-eval/` in the project where you installed Forge:

```text
my-eval/
├── experiment.yaml
└── dataset/
    ├── manifest.json
    └── cases/payments-onetime.case.yaml
```

The sample evaluates a Stripe Checkout integration using Claude Code, Ava,
and a criterion judge. All three use the configured Anthropic credential.
The bundle is separate from the installed Forge package; preserve its dataset
bytes and keep `experiment.yaml` beside `dataset/`.

Validate without Docker allocation or model credentials, then run with your
Anthropic key configured:

```sh
npx --no-install forge validate --experiment ./my-eval/experiment.yaml
export ANTHROPIC_API_KEY=your-restricted-key
npx --no-install forge run \
  --experiment ./my-eval/experiment.yaml \
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

The bundled experiment defines the available cases, treatments, and agents.
CLI case filters use the IDs declared inside the released case files.
`dataset.path` resolves relative to the experiment file.

`run` executes every matching matrix selection. These optional filters
select existing combinations; `plan` requires exactly one match:

```text
--case <case-id>                 --case-file <path-to-listed-case-file>
--treatment <treatment-id>        --agent <adapter-id>
--provider <provider-id>          --model <model-id>
--repetition <zero-based-index>
```

`--case` and `--case-file` are mutually exclusive. For example:

```sh
npx --no-install forge run \
  --experiment ./my-eval/experiment.yaml \
  --case stripe-integration-public-evals/payments-onetime --treatment baseline --agent claude-code
```

`--run-id` names an **eval run** and requires one matching selection. Omit it
for an automatically generated ID. Experiment runs receive their own IDs.

### Concurrency and resume

Use `--jobs <count>` (or `-j`) to limit concurrent eval runs; the default is 1:

```sh
npx --no-install forge run --experiment ./my-eval/experiment.yaml --jobs 4
```

Each run owns its runtime and artifacts. Size concurrency for host resources
and provider rate limits. A failed execution is recorded while other selections
continue. Each invocation attempts pending selections once; `matrix.retries`
does not schedule automatic retries.

To resume, use the printed experiment run ID and original output root, with
credentials configured again if work remains:

```sh
npx --no-install forge run \
  --experiment ./my-eval/experiment.yaml \
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
and one `runs` row per saved selection. With optional `jq`:

```sh
jq '.cases[] | {case_id, treatment, agent, completed, errored, judge_errors, pass_rate, judging_score, criteria_by_requirement}' \
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

### Inspect evidence

Runs may also contain `workspace-evidence.json`, `judge-evidence.json`, and
`native/<adapter>/session.jsonl`. The **native log is unredacted and restricted**;
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
