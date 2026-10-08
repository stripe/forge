# Forge quickstart

This example is both a complete, manifest-pinned benchmark and a direct
case-file example. The case contains only the public `EvalCaseV1` schema; agent,
model, runtime, and matrix configuration remain in `experiment.yaml`.

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --experiment examples/quickstart/experiment.yaml

node dist/cli.js plan \
  --experiment examples/quickstart/experiment.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.case.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6
```

Run it with a dedicated Anthropic key:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment examples/quickstart/experiment.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.case.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id quickstart-001
```

When using an Anthropic-compatible endpoint, run the same command with
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` instead:

```sh
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
node dist/cli.js run \
  --experiment examples/quickstart/experiment.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.case.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id quickstart-001
```

The absence of `ANTHROPIC_BASE_URL` selects direct Anthropic and
`ANTHROPIC_API_KEY`. Its presence selects the compatible endpoint and requires
`ANTHROPIC_AUTH_TOKEN`; these values are not part of the checked-in experiment
config.
The endpoint must be reachable from inside the evaluation container; container
loopback does not refer to a gateway process on the host.

The experiment's `dataset.path` locates the pinned dataset relative to the
experiment file. `--case-file` selects a manifest-listed case within that
dataset. Each invocation creates a new experiment run; eval run artifacts are
under `results/experiments/<experiment-run-id>/runs/quickstart-001/`.
Use `--resume <experiment-run-id>` to retry execution errors or unfinished
entries while preserving completed scores. See the root README's
[experiment run workflow](../../README.md#running-and-resuming-an-experiment).

## Opt-in live checks

Repository contributors exercise this quickstart as part of the single live
suite. It also checks Docker conformance and the multi-turn example, so it may
make several billable calls and requires an explicit acknowledgement:

```sh
FORGE_LIVE=1 \
ANTHROPIC_API_KEY=your-restricted-key \
pnpm test:live
```

An Anthropic Messages-compatible endpoint uses the same command:

```sh
FORGE_LIVE=1 \
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
pnpm test:live
```

The suite verifies this run's checks, native Claude evidence, canonical
artifacts, and absence of unexpected host completion calls. Live checks are not
part of `pnpm test` or `pnpm check`.
