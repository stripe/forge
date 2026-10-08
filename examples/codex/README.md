# Codex quickstart

This experiment runs the existing [quickstart dataset](../quickstart/dataset)
with Codex. Cases and dataset hashes are unchanged; the agent choice lives in
this experiment, not in the case.

From the repository root, build, validate, and inspect the plan without any
credentials or Docker allocation:

```sh
pnpm build
node dist/cli.js validate \
  --experiment examples/codex/experiment.yaml

node dist/cli.js plan \
  --experiment examples/codex/experiment.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.case.yaml
```

To run, start Docker and supply a restricted API key. This command makes
potentially billable model calls:

```sh
CODEX_API_KEY=your-restricted-key \
node dist/cli.js run \
  --experiment examples/codex/experiment.yaml \
  --case-file examples/quickstart/dataset/cases/examples/hello-file.case.yaml \
  --agent codex \
  --model gpt-5.4 \
  --output ./results \
  --run-id codex-001
```

The example selects `gpt-5.4`; change the experiment model if your account or
compatible service requires another Codex-supported model. Model availability
is controlled by that provider. On an intentionally ARM64 benchmark, also
change `runtime.platform` to `linux/arm64`.

`CODEX_API_KEY` is bound to the opaque `openai.api-key` reference. An explicit
`--credential-env openai.api-key=MY_KEY_VARIABLE` can select a different host
variable. Forge does not use your host Codex login or `~/.codex` directory.
Set `OPENAI_BASE_URL` to use a Responses-compatible API root, including `/v1`
when that service requires it. The endpoint must be reachable from the
container; container loopback is not the host.

This one-shot, checks-only case needs no Anthropic key. Multi-turn cases use
the same Codex session through exact-ID resume, but require an explicit
`models.role_player`; judging criteria similarly require `models.judge`. The public
CLI currently uses the Anthropic completion provider for those two roles,
independently of the Codex agent and its key. Codex supports native
[`forge/plugin` treatments](../../docs/plugin-action.md). Set `hook_trust` on
its `matrix.agents` entry: `native` is the default; `automation` permits all
enabled hooks, including workspace hooks, without review on initial and
resumed turns.

The experiment uses `dataset.path: ../quickstart/dataset`. Each CLI invocation
creates a new execution ID; resume a specific execution with
`--resume <experiment-run-id>`. Its eval artifacts are under
`results/experiments/<experiment-run-id>/runs/codex-001/`.

The committed run includes normalized `trajectory.json`, driver
`interaction.json`, and deterministic `workspace-evidence.json`. When the exact
rollout is available, it also includes `native/codex/session.jsonl`, an
unredacted restricted artifact that may contain sensitive data. Use
`verifyCompletedRun` to verify the result and artifact inventory.

## Opt-in live suite

Run native setup, plugin, hook, MCP, resume, and evidence fixtures without
model credentials or upstream model calls:

```sh
FORGE_LIVE=1 FORGE_LIVE_MODE=setup FORGE_LIVE_AGENT=codex pnpm test:live
```

Run those fixtures, Docker conformance, this experiment, and artifact
verification through the same live suite:

```sh
FORGE_LIVE=1 \
FORGE_LIVE_AGENT=codex \
CODEX_API_KEY=your-restricted-key \
OPENAI_BASE_URL=https://gateway.example.com/v1 \
pnpm test:live
```

The endpoint must support Codex's Responses requests. Omit `OPENAI_BASE_URL` for
direct OpenAI. This mode makes potentially billable calls for the example;
the plugin fixtures use local scripted Responses and host completions. It
keeps the upstream key in a temporary host bridge
and gives the container an ephemeral token instead. Docker must provide
`host.docker.internal`; connectivity is checked before inference. Results are
written below `results/live` unless `FORGE_LIVE_RESULTS_ROOT` selects another
directory.
