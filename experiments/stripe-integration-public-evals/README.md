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
└── experiment.yaml
```

The dataset directory holds only the latest version; earlier versions live in
Git history. Its manifest declares identity and lists each case's ID, version,
and path. Each case file declares the same ID and version as its manifest
entry. This README and the experiment sit outside the dataset tree, because
every file inside it is dataset payload.

The [baseline experiment](experiment.yaml) points at the dataset with
`dataset.path` and pins the dataset ID and version. It selects one case
(`payments-onetime`) once with Claude Code and Sonnet 4.6, using public
Anthropic models for Ava and judging — the matrix picks a single
representative case rather than running the whole dataset. Runtime and model
choices belong to the experiment rather than the dataset.

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
Docker or credentials. To execute the evaluation, use Docker and an Anthropic key:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml \
  --output ./results
```

Execution makes model calls for the agent, Ava, and the criterion judge.
Forge prints the experiment run identity and artifact locations.

## Update the dataset

A case uses fixtures through the `dataset_path` sources of its `forge/write`
setup. When a case version changes or a case is added or removed, update the
manifest, bump the dataset version, and update the experiment's dataset
version. From a Forge checkout, `pnpm check:cases` fails if the
dataset version bump is missing.
