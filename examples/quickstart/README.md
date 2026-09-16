# Forge quickstart

This example is both a complete, manifest-pinned benchmark and a direct
case-file example. The case contains only the public `EvalCaseV1` schema; agent,
model, runtime, and matrix configuration remain in `profile.yaml`.

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --profile examples/quickstart/profile.yaml \
  --dataset examples/quickstart/dataset

node dist/cli.js plan \
  --profile examples/quickstart/profile.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6
```

Run it with a dedicated Anthropic key:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --profile examples/quickstart/profile.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.yaml \
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
  --profile examples/quickstart/profile.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id quickstart-001
```

The absence of `ANTHROPIC_BASE_URL` selects direct Anthropic and
`ANTHROPIC_API_KEY`. Its presence selects the compatible endpoint and requires
`ANTHROPIC_AUTH_TOKEN`; these values are not part of the checked-in profile.
The endpoint must be reachable from inside the evaluation container; container
loopback does not refer to a gateway process on the host.

`--case-file` walks up to discover `dataset/manifest.json`, verifies the entire
dataset, maps the selected file to its manifest case ID, and then resolves that
case through the profile. It does not accept an unmanifested or legacy combined
eval file.

## Opt-in live checks

From the repository root, `pnpm test:live:docker` exercises the real Docker
lifecycle without credentials or a model call. `pnpm test:live:claude` runs
this quickstart against a model provider and may be billable, so it additionally
requires `FORGE_LIVE_CLAUDE=1` every time.

Use either direct authentication:

```sh
FORGE_LIVE_CLAUDE=1 \
ANTHROPIC_API_KEY=your-restricted-key \
pnpm test:live:claude
```

or an Anthropic-compatible endpoint:

```sh
FORGE_LIVE_CLAUDE=1 \
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
pnpm test:live:claude
```

Live checks are not part of `pnpm test` or `pnpm check`.
