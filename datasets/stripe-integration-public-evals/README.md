# Stripe integration sample dataset

This representative `0.1.0` snapshot contains one case,
`stripe-integration-public-evals/payments-onetime`: implement hosted Stripe
Checkout for a $50 photography book, a confirmation page, and a webhook handler.
The case retains its task, opening prompt, context, ten-turn limit, and eight
judging criteria. It has no fixture files or setup steps.

## Release layout

```text
datasets/stripe-integration-public-evals/
├── README.md
└── 0.1.0/
    ├── manifest.json
    └── cases/
        └── payments-onetime.case.yaml

experiments/stripe-integration-public-evals/
└── experiment.yaml
```

The `0.1.0/` directory is the complete dataset payload. Its manifest declares
dataset identity `stripe-integration-public-evals@0.1.0`, lists case paths,
and inventories every payload file with its byte size and SHA-256 hash.
The case declares its own stable ID independently of its filename.
`manifest.json` itself is excluded from the file inventory.

The separate [baseline experiment](../../experiments/stripe-integration-public-evals/experiment.yaml)
pins the dataset identity and raw manifest digest. It selects this case once
with Claude Code and Sonnet 4.6, using public Anthropic models for Ava and judging.
Runtime and model choices belong to the experiment rather than the dataset.

## Validate and run

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml
node dist/cli.js plan \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml
```

Validation and planning verify the complete inventory and experiment pin without
Docker or credentials. To execute the evaluation, use Docker and an Anthropic key:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment experiments/stripe-integration-public-evals/experiment.yaml \
  --output ./results
```

Execution makes model calls for the agent, Ava, and the criterion judge.
Forge prints the experiment run identity and artifact locations.

## Distribute a snapshot

The dataset is separate from the Forge npm package. This checked-in snapshot
illustrates a dataset release; it has not been published as a release asset.
To produce a standalone archive with `manifest.json` at its root:

```sh
tar -czf /tmp/stripe-integration-public-evals-0.1.0.tar.gz \
  -C datasets/stripe-integration-public-evals/0.1.0 .
```

Keep a released snapshot's bytes intact. Publish changed inputs under a new
dataset version and update the consuming experiment's path, version, and
manifest digest. A consumer may relocate an unchanged snapshot by adjusting
`dataset.path`; its identity and manifest digest remain the same.
