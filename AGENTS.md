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
documented public contracts; do not import or discover private host
implementations from the core.

Before changing behavior or public exports, read `README.md`, `package.json`,
and `docs/architecture.md`. Use `docs/codebase-guide.md` for detailed code
navigation. Those documents, the implementation, and tests are the sources of
truth for feature details; do not duplicate their full specifications here.

## Invariants to preserve

- Cases define the task, invariant setup, and evaluation; experiments define
  treatments and execution choices. Keep runtime, model, and host configuration
  out of case definitions.
- Do not mutate parsed inputs. Resolve declared inputs, defaults, and explicit
  host choices into canonical, cloned, deeply frozen plans. Do not infer omitted
  semantic settings during execution.
- Record bounded, non-sensitive receipts in `setup.json` for setup choices Forge
  explicitly resolves. Keep provenance claims within the recorded facts and
  document material gaps.
- Keep core wire formats strict and governed by the Forge package release.
  Reject unknown authored fields in their owning schemas.
- Preserve dataset integrity checks: verify the exact manifest inventory,
  declared file sizes and hashes, and experiment dataset pins.
- Complete parsing and pure capability preflight before resolving credentials,
  allocating resources, making provider requests, or mutating a workspace.
- `executeEval` owns score-affecting lifecycle ordering. Adapters provide
  mechanisms and must not redefine benchmark semantics.
- Apply case setup before treatment setup. Stop mutation before selecting or
  evaluating evidence.
- Select evidence for the exact run and session. If native evidence is
  unavailable or incomplete, make fallback and fidelity loss explicit.
- Treat credentials as scoped capabilities. Keep secret values out of authored
  inputs, plans, events, errors, normalized transcripts, and ordinary artifacts.
  Keep unredacted native logs explicitly restricted, and never copy the ambient
  host environment wholesale into a runtime.
- Calculate a content digest for an expected-content comparison, artifact
  verification, or a documented identity workflow such as comparing installed
  plugin snapshots. Avoid redundant digests and fingerprints without a defined use.
- Keep core serialization canonical and bounded, describe and verify companion
  bytes, and commit completed runs atomically. Cleanup, observation, and
  publication must not alter scoring semantics.
- Add host-specific capabilities through narrow public interfaces or explicit,
  immutable action bundles. Do not add global discovery, YAML-driven imports,
  or hidden process-environment fallbacks.

See `docs/architecture.md` for the complete lifecycle, trust model, evidence
policy, artifact format, and scoring semantics.

## Testing and verification

Every code change must have relevant automated test coverage. Place focused
unit tests beside source files as `*.test.ts`; put cross-module, CLI, package,
and embedding tests under `test/`. Keep harness test inputs under `test/fixtures/`.
Versioned public release bundles belong under `datasets/<name>/<version>/`,
with a runnable `experiment.yaml` beside the exact-manifest `dataset/` tree.
Use `dataset.path: ./dataset` so the complete bundle can be moved or archived
without rewriting its experiment. Keep release documentation outside the
exact-manifest dataset tree.
Prefer deterministic fakes for the normal test suite.

Use the narrowest relevant test while iterating:

```sh
pnpm test -- path/to/file.test.ts
pnpm typecheck
pnpm test
pnpm build
pnpm test:types
pnpm test:package
pnpm check:docs
pnpm check
```

Run `pnpm check` before handing off changes that affect code, public types,
exports, execution, packaging, or release artifacts. For a documentation-only
change, run `pnpm check:docs`.
Always report which checks were run and any checks that could not be run.

Use the opt-in live suite when the changed behavior cannot be established by
fakes and affects the real Docker runtime or assets, Claude Code or Codex
adapters, completion providers, credential or network wiring, plugin
installation, or native evidence collection. Keep live coverage in the single
repository live-suite path.

```sh
FORGE_LIVE=1 ANTHROPIC_API_KEY=... pnpm test:live
```

The live suite requires Docker and network access. Its default full mode also
requires provider credentials and makes potentially billable model calls; run
that mode only when appropriate to the changed surface and the task permits
credentialed, billable execution. `FORGE_LIVE_MODE=setup` exercises built-in
setup actions without model credentials or model calls. If relevant live
coverage cannot be run, say so explicitly in the handoff. See the README for
setup, gateway, and Codex variants.

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
- Keep one source of truth: `README.md` owns user workflows and current
  limitations; `docs/architecture.md` owns stable boundaries and lifecycle;
  `docs/codebase-guide.md` owns contributor navigation; feature documents own
  their exact current contracts; `AGENTS.md` owns repository instructions.
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
  subpath export tests, the package smoke test, and the README.
- When changing checked-in dataset snapshots or eval fixtures, update dependent
  sizes and SHA-256 digests in dataset manifests and experiment configs, plus
  mirrored README snippets.
- When changing packaged Docker assets or tool pins, update their recorded
  digests, runtime metadata, and tests.
- Keep ATIF changes tied to a specific upstream version and update provenance,
  conformance tests, and notices together.
- Update the README for changes to CLI syntax, schemas, public entry points,
  security properties, requirements, or current limitations. Keep public
  documentation free of private infrastructure details and migration-only
  formats.
