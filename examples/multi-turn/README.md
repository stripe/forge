# Forge multi-turn example

This is a complete, manifest-pinned multi-turn benchmark. It keeps the eval
case decoupled from experiment configuration:

- `dataset/cases/examples/release-summary.yaml` defines a deliberate two-step
  handoff, its opening message and role-player context, a turn limit, one success
  guideline, and deterministic filesystem checks. It contains no agent,
  provider, model, runtime, or repetition choice.
- `profile.yaml` selects Claude Code for the coding agent and independently
  selects `claude-sonnet-4-6` through the Anthropic provider for both Ava's
  role-player decisions and guideline judging.

During a run, the configured opening asks Claude Code to request a missing
status sentence before changing files. Ava supplies that sentence on the next
user turn, so a conforming run exercises at least two turns in one persistent
Claude Code session. Forge then seals the workspace and judges the guideline
against the resulting evidence. The exact file check remains deterministic even
though the interaction and guideline assessment use model completions.

## Integrity pins

The checked-in bytes include their final newlines. The dataset manifest records
this exact payload:

| Path | Size | SHA-256 |
| --- | ---: | --- |
| `cases/examples/release-summary.yaml` | 1137 bytes | `fa82c800831105fe9521ed03847d381523d774c706288a53a8082e34241991f3` |

The raw `dataset/manifest.json` digest is
`sha256:acd68e0d7c13dd6d3a46382e802ad2345d0f82de8813ecd239a84ed21d032447`.
`profile.yaml` pins that exact digest, so changing the case or manifest requires
updating the size, payload SHA-256, and profile manifest digest together.

## Validate and inspect the plan

From the repository root:

```sh
pnpm build
node dist/cli.js validate \
  --profile examples/multi-turn/profile.yaml \
  --dataset examples/multi-turn/dataset

node dist/cli.js plan \
  --profile examples/multi-turn/profile.yaml \
  --case-file examples/multi-turn/dataset/cases/examples/release-summary.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6
```

`--case-file` discovers and verifies the dataset manifest, then selects the
case's stable ID from the profile matrix. It does not turn the case into an
unversioned ad hoc experiment.

## Run with Docker and Anthropic

This command builds or reuses the Forge Docker image and makes billable model
calls for the coding agent, Ava role player, and guideline judge:

```sh
ANTHROPIC_API_KEY=your-restricted-key \
node dist/cli.js run \
  --profile examples/multi-turn/profile.yaml \
  --case-file examples/multi-turn/dataset/cases/examples/release-summary.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id multi-turn-001
```

For an Anthropic Messages-compatible endpoint, use the same profile and run
command with an endpoint and bearer token instead:

```sh
ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-restricted-token \
node dist/cli.js run \
  --profile examples/multi-turn/profile.yaml \
  --case-file examples/multi-turn/dataset/cases/examples/release-summary.yaml \
  --agent claude-code \
  --model claude-sonnet-4-6 \
  --output ./results \
  --run-id multi-turn-001
```

Credentials and compatible-endpoint configuration stay in the execution
environment; they are never stored in the case, profile, resolved plan, or
result artifacts.

Repository contributors can run the same selection with post-run conformance
checks by explicitly acknowledging its multiple potentially billable calls:

```sh
FORGE_LIVE=1 \
ANTHROPIC_API_KEY=your-restricted-key \
pnpm test:live
```

The unified live suite also exercises Docker conformance and the one-shot
quickstart. For this example it requires at least two agent turns, a passing
guideline and file check, every canonical audit artifact, and native evidence
bound to the one persistent Claude Code session.
