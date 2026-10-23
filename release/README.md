# Stripe integration sample experiment

The `stripe-integration-public-evals` dataset contains one case,
`stripe-integration-public-evals/payments-onetime`: implement hosted Stripe
Checkout for a $50 photography book, a confirmation page, and a webhook handler.
The case retains its task, opening prompt, context, ten-turn limit, and eight
judging criteria. It has no fixture files or setup steps.

## Layout

```text
release/
├── README.md
├── datasets/stripe-integration-public-evals/
│   ├── manifest.json
│   └── cases/
│       └── payments-onetime.case.yaml
└── experiment.yaml
```

The release holds only the latest version; earlier versions live in Git
history. The [dataset payload](./datasets/stripe-integration-public-evals)
contains the manifest, cases, and any fixtures. The manifest lists each case's
ID, version, and path; each case file declares the same ID and version. This
README and the experiment remain outside that payload tree.

The [baseline experiment](experiment.yaml) uses
`dataset.path: ./datasets/stripe-integration-public-evals` and pins the
dataset ID and version. Copy `release/` to run it elsewhere without rewriting
configuration. It selects this case once with Claude Code and Sonnet 4.6,
using public Anthropic models for Ava and judging. Runtime and model choices
belong to the experiment rather than the dataset.

## Validate and run

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --experiment release/experiment.yaml
node dist/cli.js plan \
  --experiment release/experiment.yaml
```

Validation and planning verify the case inventory and experiment pin without
Docker or credentials. To execute the evaluation, use Docker and an Anthropic key:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment release/experiment.yaml \
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
