# AGENTS.md

## Project boundary

`@stripe/forge` is a public, portable execution harness for reproducible
coding-agent evaluations. The internal Forge implementation builds on this
package, so changes to its contracts, schemas, lifecycle, exports, or observable
behavior can affect downstream internal consumers.

Forge aims to make evaluation runs auditable. `plan.json` records declared
inputs and Forge producer identity; `setup.json` records bounded, non-sensitive
setup provenance; results bind those records to selected evidence and outcomes.
These records do not guarantee identical reruns or complete capture of external
state.

Keep the public package free of dependencies on Stripe-internal infrastructure,
services, credentials, paths, packages, and unpublished behavior. Public
Stripe-owned names or integrations are acceptable only when they are portable,
documented, and usable outside Stripe. Keep runtime dependencies small,
portable, and suitable for an Apache-2.0 public package; record required
attribution and provenance. Environment-specific behavior must enter through
documented public contracts or explicit, immutable action bundles. Do not add
global implementation discovery, YAML-driven imports, or hidden
process-environment fallbacks; keep private host implementations out of the core.

Before changing behavior or public exports, read `README.md`, `package.json`,
and `docs/architecture.md`. Use `docs/codebase-guide.md` for detailed code
navigation. Those documents, the implementation, and tests are the sources of
truth for feature details; do not duplicate their full specifications here.

## Invariants to preserve

- Cases own tasks, criteria, and invariant setup; experiments own treatments,
  models, and runtime choices.
- Keep core schemas strict under the Forge release and reject unknown fields in
  their owning schemas. Resolve explicit inputs and defaults into canonical,
  cloned, deeply frozen plans without mutating inputs or introducing hidden
  execution defaults.
- Verify exact dataset case inventories, case identities, and experiment pins.
  Case and fixture content integrity is governed outside Forge; add digests
  only for a defined integrity or identity purpose.
- Finish parsing and pure capability preflight before credential lookup,
  provider requests, allocation, or workspace mutation.
- `executeEval` owns lifecycle and scoring order. Apply case setup before
  treatment setup, and stop mutation before evidence selection or evaluation.
- Record bounded, non-sensitive setup receipts for choices Forge explicitly
  resolves; document provenance gaps.
- Select evidence for the exact run and session. Make native-evidence fallback
  and fidelity loss explicit.
- Keep credentials scoped and avoid copying the host environment wholesale.
  Exclude secrets from authored inputs, plans, normalized transcripts, and
  ordinary outputs; keep unredacted native logs restricted.
- Keep core serialization canonical and bounded, verify companion artifacts,
  and commit completed runs atomically. Cleanup, observation, and publication
  must not alter scoring semantics.

See `docs/architecture.md` for the complete lifecycle, trust model, evidence
policy, artifact format, and scoring semantics.

## Testing and verification

Validate changes at the affected boundary. Add or update automated tests when
needed to establish observable behavior or prevent a meaningful regression;
existing coverage can suffice. Avoid tests that merely restate the
implementation. Prose and formatting-only changes do not need new tests.

Place focused unit tests beside source files as `*.test.ts`; put cross-module,
CLI, package, and embedding tests under `test/`. Keep harness test inputs under
`test/fixtures/`. Prefer deterministic fakes for the normal test suite.
Public datasets belong under `release/datasets/<name>/`, holding only the latest
version; earlier versions live in Git history. Keep the manifest, cases, and
fixtures there. Put the runnable experiment at `release/experiment.yaml` and
release documentation at `release/README.md`, outside the dataset payload.
Set `dataset.path` relative to the experiment file so `release/` can be relocated
without rewriting configuration. Cases read fixtures through `forge/write`
`dataset_path` sources.
When a case version changes or a case is added or removed, update the manifest
and bump the dataset version; `pnpm check:cases` enforces this against
`origin/main`.

While iterating, run the narrowest relevant tests, plus applicable type, build,
or package checks from `package.json`:

```sh
pnpm test path/to/file.test.ts
```

Use Biome for formatting, import organization, and linting. Run `pnpm lint`
for code changes; it is also included in `pnpm check`. Use `pnpm lint:fix`
for safe automatic fixes, and preserve the exclusions in `biome.json` for
pinned inputs and assets.

Run `pnpm check` before handing off changes that affect code, public types,
exports, execution, packaging, or release artifacts. For a documentation-only
change, run `pnpm check:docs` and review the affected content. Broaden or repeat
successful checks only when new changes, failures, or unresolved concerns
justify it. Report checks run and their outcomes, relevant checks skipped and
why, and any validation still needed.

Use the opt-in live suite when the changed behavior cannot be established by
fakes and affects the real Docker runtime or assets, Claude Code or Codex
adapters, completion providers, credential or network wiring, plugin
installation, or native evidence collection. Keep live coverage in the single
repository live-suite path.

```sh
FORGE_LIVE=1 FORGE_LIVE_MODE=setup pnpm test:live
```

Both live modes require Docker and network access. Setup mode exercises built-in
setup actions without model credentials or model calls. Full mode is the default,
requires provider credentials, and makes potentially billable model calls; run
it only when the task authorizes credentialed, billable execution. If relevant
live coverage cannot be run, report that validation gap. See
`docs/codebase-guide.md` for mode details, gateway configuration, and agent
variants.

## Pull requests and review

Every PR must receive an independent review from a separate subagent with a
fresh context before handoff. Give the reviewer the task requirements,
repository instructions, and final PR diff, with access to relevant code,
documentation, and tests. Do not inherit the implementation conversation.
Keep the reviewer read-only, address actionable findings, and obtain another
review when fixes materially change the reviewed diff.

### PR descriptions

Write for an experienced engineer who is unfamiliar with this part of Forge.
Lead with the concrete observed problem, giving the system context needed to
understand it, then the resulting behavior; define Forge-specific terms when
they first matter. Explain the main workflow and the conditions that let a
reviewer predict its outcomes: what starts work, when results are reused, what
counts as success, and what can remain afterward.

Ground every behavioral claim in the current diff and the relevant
implementation, tests, and config — not in prior PR prose or discussion. Keep
material conditions next to the claims they limit, and distinguish inferred
intent from observed behavior. Use plain, direct language and precise
technical names; cut secondary topics rather than packing them into dense
sentences. Scale detail to the change — simple PRs can be brief.

Every PR description uses these sections and subheadings, in this order. Keep
each subheading visible, even when its content is one sentence; don't fold the
parts into unlabeled prose under the section headings.

```markdown
## Context
### Observed problem
### Impact
## Changes
### Changes
### Why this is the right fix
## Validation
### How to test it
### Rollout/revert plan
```

- **Observed problem** says why the PR needs to exist: what goes wrong on
  `main` today, or what `main` can't do, and for whom. Give the input or
  situation, what the system does, and how that was observed (a run, a
  reproduction, a test). Lead with this, not with how the code works.
- **Impact:** who or what it hurts and how much. Keep measured impact separate
  from inferred impact.
- **Changes:** the changed behavior, the main workflow, and its important
  boundaries and consequential decisions. Use a before/after or a table when it
  helps, and a diagram when it materially improves understanding.
- **Why this is the right fix:** why this approach and not the obvious
  alternatives — name them and say why they lose — and how the change
  degrades, rather than breaks, when its inputs are missing or malformed, plus
  what it deliberately doesn't do.
- **How to test it:** the exact commands a reviewer can run and what they
  should see; which tests fail without the fix; the commands actually run and
  their results; and any proposed check that adds signal beyond routine CI.
  Code containing a test is not proof it passed — state when results are
  unavailable, and label proposed checks as proposed. Note any remaining
  validation gaps.
- **Rollout/revert plan:** activation, compatibility with saved runs and
  older builds, and what a revert leaves behind. Write "No rollout steps; a
  revert has no lasting effect" when that's true.

Include only the validation and compatibility details that apply, and say
briefly when one doesn't. Documentation-only changes need no new tests, but
still report the documentation check (`pnpm check:docs`) and its result, or why
it wasn't run.

Before submitting, challenge the description's consequential claims. Look for
a permitted input, state change, or failure path that would contradict each
one, especially words like "only," "every," and "always." Distinguish an
attempted action from a verified outcome, and narrow or qualify claims the
code permits a counterexample to. Keep the description proportional to the
change and focused on the final implementation.

## Documentation maintenance

Documentation describes current public behavior. It is not a changelog, design
journal, rollout plan, test inventory, or exhaustive copy of the implementation.

- Review documentation impact for every behavioral change. Internal refactors
  need no documentation edit unless they change a public contract or contributor
  workflow.
- Before editing a document, read it end to end and search `README.md`,
  `AGENTS.md`, and `docs/` for overlapping coverage.
- Update or replace existing material instead of appending by default. Remove
  stale or redundant text in the same change.
- Keep one source of truth: `README.md` owns user workflows;
  `docs/architecture.md` owns stable boundaries, lifecycle, and current
  limitations; `docs/codebase-guide.md` owns contributor workflows and navigation;
  feature documents own their exact current contracts; `AGENTS.md` owns
  repository instructions.
- Link to authoritative material instead of copying schemas, inventories,
  constants, or implementation details between documents.
- Add a document or major section only for a distinct audience that cannot be
  served cleanly by an existing source of truth.
- Keep growth proportional. If documentation grows materially, explain why
  consolidation or replacement was insufficient.
- Run `pnpm check:docs` and report which documents were reviewed, changed, or
  intentionally left unchanged.

## Coupled changes

- When changing a wire format, update its TypeScript model, parser,
  serialization, tests, and public documentation together.
- When adding or changing an entry point, update `package.json`, root and
  subpath export tests, the package smoke test, and `docs/architecture.md`.
- When changing case versions or membership in a checked-in dataset manifest,
  bump the manifest's dataset version and the `dataset.version` of dependent
  experiment configs, plus mirrored README snippets.
- When changing packaged Docker assets or tool pins, update their recorded
  digests, runtime metadata, and tests.
- Keep ATIF changes tied to a specific upstream version and update provenance,
  conformance tests, and notices together.
- Update the README for changes to CLI syntax, requirements, or user workflows;
  update the authoritative guides for schemas, public entry points, security
  properties, or current limitations. Keep public documentation free of private
  infrastructure details and migration-only formats.
