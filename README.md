# Stripe Forge

Forge is an evaluation harness for coding agents. It runs real agents (Claude
Code, Codex, and an experimental OpenCode adapter) inside isolated Docker
containers on realistic integration tasks. A simulated developer named Ava
holds private requirements and reveals them over a multi-turn conversation. An
LLM judge then grades the result against a MUST/SHOULD rubric, using the
conversation transcript and the files the agent left in its workspace.
Experiments run the same cases under different arms, such as with and without
a plugin, so you can compare them on matched tasks.

Forge is in early development. See the
[current limitations](docs/architecture.md#current-limitations) before
designing a benchmark on it.

## Why Forge exists

Most coding benchmarks check whether code passes tests or reaches an expected
end state. Forge grades the decisions that make an integration correct:
choosing the right API, getting money semantics and safety right, and warning
about designs that are unsafe or unsupported.

Forge complements test-based evaluation; it does not replace it. It does not
execute the agent's code after the session. The judge reads the transcript and
a bounded snapshot of the workspace text, so a judgment can be wrong in ways a
passing test would not be.

## Quickstart

You need Node.js 22.12 or newer, Git, Docker with a Linux `amd64` or `arm64`
server, and two API keys: an Anthropic key for the coding agent (Claude Code) and an OpenAI
key for Ava and the judge, which default to an OpenAI model. A run makes
billable model calls.

Clone and build Forge:

```sh
git clone https://github.com/stripe/forge.git
cd forge
corepack enable
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

Read the evaluation and the report with [`jq`](https://jqlang.github.io/jq/):

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
  transcript and the workspace text, then returns pass or fail with an
  explanation. Ava and the judge use host-side models chosen separately from
  the coding agent.

## What a result looks like

Each run's `result.json` has an `evaluation`. The values below are
illustrative; the fields are the ones Forge writes (shown for a case with
four `MUST` and four `SHOULD` criteria, with the list cut to two entries):

```json fragment
{
  "score": 0.875,
  "status": "partial",
  "judging_criteria_passed": 7,
  "judging_criteria_total": 8,
  "judging_criteria_errored": 0,
  "judging_criteria": [
    {
      "requirement_level": "MUST",
      "criterion": "MUST: Has success_url configured for the post-payment redirect",
      "passed": true,
      "explanation": "The checkout session is created with a success_url."
    },
    {
      "requirement_level": "SHOULD",
      "criterion": "Has cancel_url configured",
      "passed": false,
      "explanation": "No cancel_url is set on the session."
    }
  ],
  "checks": []
}
```

The score is the fraction of valid `MUST` and `SHOULD` judgments that passed.
Status is `passed`, `partial`, `failed`, or `judge_error` when a criterion
could not be judged.

`report.json` aggregates all runs in the experiment. One entry of `cases`
looks like this for a single completed run (illustrative values):

```json
{
  "case_id": "stripe-integration-public-evals/payments-onetime",
  "treatment": "baseline",
  "agent": {
    "adapter": "claude-code",
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
  },
  "completed": 1,
  "errored": 0,
  "judge_errors": { "evaluations": 0, "criteria": 0 },
  "pass_rate": 0,
  "criterion_scores": {
    "required": { "strict": 1, "avg": 1, "evaluations": 1 },
    "recommended": { "strict": 0, "avg": 0.875, "evaluations": 1 },
    "blend": { "score": 0.75, "evaluations": 1 }
  }
}
```

Required covers `MUST` criteria and Recommended covers `MUST` plus `SHOULD`.
`strict` is 1 only when every criterion in the set passed, and `avg` is the
fraction of valid judgments that passed. `blend` is 0 if any `MUST` fails, and
otherwise the fraction of valid `SHOULD` judgments that passed. The exact formulas are in the
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
  arguments. The judge sees bounded text from the workspace, not behavior.
- **One domain.** The bundled dataset has 69 cases, all Stripe integrations
  across Connect, Payments, and Subscriptions. Results say little about other
  kinds of work until you add cases of your own.
- **Early development.** The built-in runtime is Docker only and execution is
  local. See the [current limitations](docs/architecture.md#current-limitations).

## License

Apache-2.0. See [LICENSE](https://github.com/stripe/forge/blob/main/LICENSE).
