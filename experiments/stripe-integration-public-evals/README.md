# Stripe integration sample dataset

The `stripe-integration-public-evals` dataset contains 73 cases covering
Stripe Connect, Payments, and Subscriptions integration scenarios — for
example `stripe-integration-public-evals/payments-onetime`: implement hosted
Stripe Checkout for a $50 photography book, a confirmation page, and a
webhook handler. Each case declares its own task, opening prompt, optional
context, ten-turn limit, and judging criteria, each criterion carrying an
explicit `requirement_level` (`MUST`, `SHOULD`, or `OPTIONAL`). None of the
cases use fixture files or setup steps.

## Layout

```text
datasets/stripe-integration-public-evals/
├── manifest.json
└── cases/
    ├── payments-onetime.case.yaml
    ├── subscriptions-fixed.case.yaml
    └── ... (73 cases total)
experiments/stripe-integration-public-evals/
├── README.md
├── experiment.yaml
└── plugin-experiment.yaml
```

The dataset directory holds only the latest version; earlier versions live in
Git history. Its manifest declares identity and lists each case's ID, version,
and path. Each case file declares the same ID and version as its manifest
entry. This README and the experiment sit outside the dataset tree, because
every file inside it is dataset payload.

The [baseline experiment](experiment.yaml) points at the dataset with
`dataset.path` and pins the dataset ID and version. It selects one case
(`payments-onetime`) once with Claude Code and Sonnet 4.6, using the
[default host models](../../README.md#requirements--credentials) for Ava and
judging. The matrix picks a single representative case rather than running
the whole dataset. Runtime and model choices belong to the experiment rather
than the dataset.

## Validate and run

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml
node dist/cli.js plan \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml
```

Validation and planning verify the case inventory and experiment pin without
Docker or credentials. To execute the evaluation, use Docker, an Anthropic key
for Claude Code, and an OpenAI key for Ava and judging:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
OPENAI_API_KEY=your-openai-key \
node dist/cli.js run \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml \
  --output ./results
```

Execution makes model calls for the agent, Ava, and the criterion judge.
Forge prints the experiment run identity and artifact locations.

The [plugin experiment](plugin-experiment.yaml) uses the same dataset with
Stripe's plugin, HTTP MCP bearer auth, and both Claude Code and Codex. It keeps
the bundled public MCP endpoint. Export a Stripe Agent API key as
`STRIPE_API_KEY`, then check setup and tool discovery:

```sh
node dist/cli.js validate --host \
  --experiment experiments/stripe-integration-public-evals/plugin-experiment.yaml
```

This check makes no model calls and does not test model authentication. To run
the payment eval, export `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, and
`OPENAI_API_KEY`, then use `run` with that experiment and `--output ./results`.
Use `--agent claude-code` or `--agent codex` to select one. Ava and judging use the default host models;
set `models.role_player` or `models.judge` in the experiment to override either.
Prepare the account or merchant outside Forge; any account accepted by the
plugin's endpoint uses the same credential interface.

## Update the dataset

A case uses fixtures through the `dataset_path` sources of its `forge/write`
setup. When a case version changes or a case is added or removed, update the
manifest, bump the dataset version, and update the experiment's dataset
version. From a Forge checkout, `pnpm check:cases` fails if the
dataset version bump is missing.
