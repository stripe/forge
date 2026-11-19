# Stripe Forge

In a multi-turn case, a simulated developer named Ava turns the task into
private needs and asks follow-up questions, and a separate judge model scores
the coding agent's recorded work against the case's criteria.

Forge is an evaluation harness for coding agents. It runs real agents (Claude
Code, Codex, and an experimental OpenCode adapter) inside isolated Docker
containers on realistic integration tasks. Ava holds private requirements and
reveals them over the conversation. The judge grades the result against a
MUST/SHOULD rubric. Experiments run the same cases under different arms, such
as with and without a plugin, so you can compare them on matched tasks.

Forge is in early development. See the
[current limitations](docs/architecture.md#current-limitations) before
designing a benchmark on it.

## Why Forge exists

Forge grades the decisions that make an integration correct: choosing the
right API, getting money semantics and safety right, and warning about designs
that are unsafe or unsupported.

Forge complements test-based evaluation; it does not replace it. It does not
execute the agent's code after the session, so a judgment can be wrong in ways
a passing test would not be.

### What the judge sees

The judge receives the recorded transcript of the agent's session, including
its tool calls and their results, bounded text from the workspace, the one
criterion being judged, and an optional example answer. It does not receive
Ava's private needs or her decision history, the agent's private reasoning,
system or copied-context steps, or raw subagent traces. Ava's private needs
are not the rubric; the criteria are written in the case.

Ava stopping because her needs look met is her own assessment. It is not
verified task success, and it does not change the score; only the judge's
verdicts and any deterministic checks do.

## Quickstart

You need:

- Node.js 22.13 or newer, and pnpm 11.6.0. On Node versions that bundle
  Corepack, `corepack enable` provides the pinned pnpm. Node 25 and later do
  not bundle it; install pnpm with `npm install -g pnpm@11.6.0` instead.
- Git.
- Docker that can run `linux/amd64` containers. The sample experiment pins that
  platform, so on an ARM host Docker needs x86 emulation.
- An Anthropic key for the coding agent (Claude Code) and an OpenAI key for Ava
  and the judge, which default to an OpenAI model. A run makes billable model
  calls.
- [`jq`](https://jqlang.github.io/jq/), only for the commands that read the
  results.

Clone and build Forge:

```sh
git clone https://github.com/stripe/forge.git
cd forge
corepack enable # skip if pnpm 11.6.0 is already installed
pnpm install --frozen-lockfile
pnpm build
```

Check the sample experiment. This needs no Docker and no keys:

```sh
node dist/cli.js validate --experiment release/experiment.yaml
```

Run one case, `payments-onetime`, which asks the agent for a hosted Stripe
Checkout integration:

```sh
export ANTHROPIC_API_KEY=your-restricted-key
export OPENAI_API_KEY=your-openai-key
node dist/cli.js run \
  --experiment release/experiment.yaml \
  --credential-env ANTHROPIC_API_KEY \
  --credential-env OPENAI_API_KEY \
  --output ./results --run-id payments-001 > run-summary.json
```

Forge reads a key from your environment only when you grant it with
`--credential-env`. The first run builds a runtime image, so it needs network
access. Progress goes to stderr. `run-summary.json` records where the results
were saved.

Read the evaluation and the report:

```sh
jq .evaluation "$(jq -r .location run-summary.json)/runs/payments-001/result.json"
jq '.cases[] | {case_id, treatment, agent, completed, errored, judge_errors, pass_rate, criterion_scores}' \
  "$(jq -r .report run-summary.json)"
```

Exit code 0 means the run finished and the report was saved, whatever the
scores were.

## Core concepts

- **Case.** One task: a prompt, whether it runs one-shot or multi-turn, any
  setup, and the judging criteria. A dataset is a versioned set of cases with a
  manifest.
- **Criterion.** One statement the judge marks as passed or failed. Each has a
  requirement level: `MUST` (required), `SHOULD` (recommended, the default), or
  `OPTIONAL` (recorded but not scored).
- **Treatment (arm).** Setup applied after the case's own setup, such as
  installing a plugin. A `baseline` treatment adds nothing. Comparing
  treatments on the same cases is how Forge measures an effect.
- **Experiment file.** A YAML file that pins a dataset and chooses the
  treatments, agents and models, runtime, and which cases to run. Cases say
  what is evaluated; the experiment says how.
- **Run record and result.** For each run, `plan.json` records the resolved
  inputs and `setup.json` records what setup did. `trajectory.json` and
  `interaction.json` hold the transcript and turn history. `result.json` holds
  the evaluation and binds those files together; it is written last, so a run
  without one did not complete.
- **Role-player (Ava).** The simulated developer in multi-turn cases. Ava
  derives up to six private needs from the case. After each agent response it
  either stops or sends a follow-up that addresses one remaining need, until
  the needs are met or the turn limit is reached.
- **Judge.** A model that grades each criterion on its own against the
  transcript and the workspace text (see [what the judge sees](#what-the-judge-sees)),
  then returns pass or fail with an explanation. An experiment can instead
  select [verbalized sampling](docs/architecture.md#verbalized-sampling-judging),
  where the judge writes several candidate answers per criterion and Forge
  aggregates them; setup is in the
  [reference](docs/reference.md#requirements--credentials). Ava and the judge
  use host-side models chosen separately from the coding agent.

## What a result looks like

Each run's `result.json` has an `evaluation` with a score, a status, counts of
criteria, one entry per criterion, and the deterministic check results. A
criterion entry has this shape (`label` is optional):

```json fragment
{
  "requirement_level": "SHOULD",
  "criterion": "Has cancel_url configured",
  "passed": false,
  "explanation": "No cancel_url is set on the session."
}
```

| Field | Meaning |
| --- | --- |
| `score` | The fraction of valid `MUST` and `SHOULD` judgments that passed. `OPTIONAL` criteria are not scored. |
| `status` | `passed`, `partial`, `failed`, or `judge_error` when a `MUST` or `SHOULD` criterion could not be judged. |
| `judging_criteria_passed`, `judging_criteria_total`, `judging_criteria_errored` | Counts of scored criteria. |
| `judging_criteria` | Each criterion's text, level, `passed` (`null` if it could not be judged), and explanation. |
| `checks` | Results of deterministic file and tool-call checks. |

`report.json` aggregates all runs in the experiment into a `summary`, one entry
per case, treatment, and agent in `cases`, and one row per run in `runs`. Each
`cases` entry reports `completed`, `errored`, `judge_errors`, `pass_rate`, and
`criterion_scores` for the `required` (`MUST`) and `recommended` (`MUST` plus
`SHOULD`) sets, plus a `blend` score. Scores can be `null` when a criterion
could not be judged. The formulas, including how they aggregate across runs,
are in the
[scores section of the reference](docs/reference.md#understand-scores).

## Where to go next

- [Reference](docs/reference.md): credentials, installation, running and
  resuming experiments, selecting cases, OpenCode setup, scores, evidence, and
  regrading saved runs with a different judge.
- [Architecture](docs/architecture.md): the lifecycle, trust model, evidence
  policy, artifact format, and current limitations.
- [Codebase guide](docs/codebase-guide.md): how the source is organized and
  where a change belongs.
- [Stripe plugin treatment](docs/plugin-action.md): comparing a baseline with
  the Stripe plugin.
- [Dataset and sample experiment](https://github.com/stripe/forge/tree/main/release):
  the 69 cases in
  [`stripe-integration-public-evals`](https://github.com/stripe/forge/tree/main/release/datasets/stripe-integration-public-evals).
- [Contributing](https://github.com/stripe/forge/blob/main/CONTRIBUTING.md):
  how to report bugs and request features.

## Limits

- **Judge variance.** Criteria are graded by a model, so the same evidence can
  be judged differently by different judge models, and a rerun of the agent can
  produce different work. Forge records its inputs for audit but does not
  promise identical reruns. `forge regrade` re-judges saved evidence with
  another judge, and the matrix `repetitions` setting repeats a case.
- **No execution of the agent's code.** Forge does not run the agent's code
  after the session or run post-agent test commands. Its deterministic checks
  cover file creation, existence, regex content, and tool-call names and
  arguments. The judge can read the commands the agent ran and their output in
  the transcript, but Forge does not independently verify runtime behavior.
- **One domain.** The bundled dataset has 69 cases, all Stripe integrations
  across Connect, Payments, and Subscriptions. Results say little about other
  kinds of work until you add cases of your own.
- **Early development.** The built-in runtime is Docker only and execution is
  local. See the [current limitations](docs/architecture.md#current-limitations).

## License

Apache-2.0. See [LICENSE](LICENSE).
