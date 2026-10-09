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
    ├── experiment.yaml
    └── dataset/
        ├── manifest.json
        └── cases/
            └── payments-onetime.case.yaml
```

The `0.1.0/` directory is the complete release bundle. Its nested `dataset/`
tree is the dataset payload, whose manifest declares identity
`stripe-integration-public-evals@0.1.0`, lists case paths, and inventories every
payload file with its byte size and SHA-256 hash.
The case declares its own stable ID independently of its filename.
`manifest.json` itself is excluded from the file inventory; `experiment.yaml`
and this README sit outside the dataset tree.

The bundled [baseline experiment](0.1.0/experiment.yaml) uses
`dataset.path: ./dataset` and pins the dataset identity and raw manifest digest.
It selects this case once with Claude Code and Sonnet 4.6, using public Anthropic
models for Ava and judging.
Runtime and model choices belong to the experiment rather than the dataset.

## Validate and run

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --experiment datasets/stripe-integration-public-evals/0.1.0/experiment.yaml
node dist/cli.js plan \
  --experiment datasets/stripe-integration-public-evals/0.1.0/experiment.yaml
```

Validation and planning verify the complete inventory and experiment pin without
Docker or credentials. To execute the evaluation, use Docker and an Anthropic key:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment datasets/stripe-integration-public-evals/0.1.0/experiment.yaml \
  --output ./results
```

Execution makes model calls for the agent, Ava, and the criterion judge.
Forge prints the experiment run identity and artifact locations.

## Distribute a bundle

The release bundle is separate from the Forge npm package. This checked-in
sample illustrates a release; it has not been published as a release asset.
To produce a standalone archive with `experiment.yaml` and `dataset/` at its
root:

```sh
tar -czf /tmp/stripe-integration-public-evals-0.1.0.tar.gz \
  -C datasets/stripe-integration-public-evals/0.1.0 .
```

With a compatible Forge CLI installed and `forge` available on your `PATH`,
extract the archive into an empty directory. From that directory, run the
bundled experiment unchanged:

```sh
forge validate --experiment ./experiment.yaml
forge plan --experiment ./experiment.yaml
ANTHROPIC_API_KEY=your-restricted-key \
forge run --experiment ./experiment.yaml --output ./results
```

Keep released dataset bytes intact. Publish changed dataset inputs under a new
dataset version and update the experiment's dataset version and manifest digest.
Relocating the complete bundle preserves `dataset.path: ./dataset`, dataset
identity, and the manifest digest, so extraction needs no path edits.
