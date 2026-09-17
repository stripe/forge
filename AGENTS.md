# AGENTS.md

## Project purpose

`@stripe/forge` is a public, portable execution harness for reproducible
coding-agent evaluations. It owns the benchmark semantics that should be shared
by every host: dataset verification, planning, automated execution, evidence
normalization, one-shot and Ava-driven multi-turn interaction, deterministic
checks, guideline judging, and atomic local results.

The package is also an extension framework. Environment-specific runtimes,
credentials, setup actions, agents, storage, observation, and publication must
integrate through documented public contracts rather than being imported or
discovered by the core.

Read `README.md` and `package.json` before changing behavior or public exports.
The README describes the currently implemented v0.1 capabilities; do not imply
that a reserved schema concept is executable until its implementation and tests
exist.

## Architecture invariants

### Keep cases separate from experiments

- An eval case defines **what** is evaluated: task or initial prompt, context,
  invariant case setup, interaction mode and turn limit, checks, guidelines,
  and example answers.
- A benchmark profile defines **how** cases run: dataset pin, treatments, agents,
  models, runtime, limits, repetitions, retries, and the experiment matrix.
- A run selection chooses one case, treatment, agent/model, and repetition from
  the profile.
- A selected `multi_turn` case requires an explicit `models.role_player`; a
  selected case with non-empty success guidelines requires an explicit
  `models.judge`. Do not infer either from the coding-agent selection or an
  ambient provider default.
- A resolved run plan is the complete, validated, ambient-free input to one run.
  Defaults and provenance belong in the plan, not in runtime-side inference.
- Do not introduce a public format that combines case definitions with
  experiment or environment configuration. Compatibility with legacy combined
  formats belongs in an external migration or projection layer.

Case setup is invariant and always precedes treatment setup. A treatment is one
complete experimental arm; do not model it as a mutable global registry of
independent feature flags.

### Keep the public engine in control

- `executeEval` owns all score-affecting lifecycle ordering.
- Adapters provide mechanisms; they must not reorder setup, interaction,
  quiescence, evidence selection, evaluation, staging, cleanup, or commit.
- Varying authority is supplied explicitly through `ForgeComposition`. Do not
  add global plugin discovery, hidden process-environment fallbacks, or imports
  of host-private implementations.
- Prefer narrow capability interfaces and composition over subclassing or
  environment checks in the shared engine.
- Setup, agent, and completion-provider `requirements()` methods are pure
  preflight declarations. They must not resolve credentials, allocate
  resources, mutate workspaces, perform provider calls, or inspect ambient
  state. A completion provider's optional credential-aware `preflight()` runs
  only during execution, after resolution and before runtime allocation.
- Plans and recorded provenance must truthfully identify the runtime, agent,
  coding-agent model, harness models, providers, and adapter behavior used by
  the run. An injected capability must not silently execute behavior that
  contradicts the plan.
- `AgentAdapter` owns coding-agent execution, persistent sessions, and native
  evidence. `CompletionProvider` owns host-side completion transport for the
  explicit `role_player` and `judge` purposes. It receives no workspace or
  command authority and must not implement or replace Ava.
- Ava's state machine and prompt semantics are engine-owned. Keep its private
  need model out of agent messages and judge inputs. Changes to its bounds,
  retries, terminal decisions, or audit record are score-affecting behavior and
  require coordinated tests and documentation.
- Interactive or human execution is outside the public automated controller,
  but mode-neutral evidence evaluation should remain reusable by such hosts.

### Preserve lifecycle and evidence safety

The required lifecycle order is:

1. Parse, validate, and perform pure capability preflight, including completion
   provider selection and requirements.
2. Resolve only explicitly declared runtime and completion credentials, then
   run optional completion-provider preflight.
3. Prepare the runtime and coding agent.
4. Apply case setup, followed by treatment setup.
5. Run the interaction.
6. Quiesce all mutation and obtain a sealed runtime.
7. Select exact run-owned evidence and normalize it to the pinned ATIF version.
8. Evaluate sealed workspace and transcript evidence, including guideline
   judging when configured.
9. Stage deterministic artifacts.
10. Dispose runtime resources.
11. Commit the completed result atomically.
12. Verify before any caller-owned publication.

Do not read mutable workspace or session evidence before quiescence. Evidence
code receives sealed, read-only capabilities. If exact native evidence is
unavailable or incomplete, use the completed driver turns as an explicit
fallback and record the loss of completeness; never silently select the newest
unrelated session. A role-player failure before the first agent turn uses the
explicit system-only fallback trajectory and a null session identity.

`interaction.json` is a post-run audit artifact, never an execution input or
judge input. The canonical redacted `trajectory.json` remains the full selected
audit trajectory and may retain normalized private reasoning. Guideline judges
receive a deterministic projection of its root ATIF steps which removes only
the typed `reasoning_content` and `reasoning_effort` fields; visible messages,
tool calls, tool results, and identically named keys inside opaque payloads must
remain intact. `judge-evidence.json` exists only when guidelines were judged and
must record the prompt version, exact transcript-projection policy, and exact
bounded workspace evidence made available to the judge. The canonical artifact
descriptors in `result.json` already bind the stored trajectory bytes. Derive
the projection only after credential redaction.
Changing its root-step scope, excluded fields, or serialization requires a new
projection version. Final completion-prompt redaction must be a no-op for a
judge request; fail closed before dispatch rather than silently rewrite the
selected transcript or recorded workspace evidence.
Collect judge workspace text only from the sealed runtime and preserve all
truncation/unavailability warnings.

Every completed run contains `result.json`, `plan.json`, `trajectory.json`, and
`interaction.json`. Emit `workspace-evidence.json` only when at least one
deterministic file check is configured, and `judge-evidence.json` only when at
least one guideline is judged. Evaluation lives only in
`result.json.evaluation`; do not reintroduce a duplicate `evaluation.json`.
Host-contributed supplemental files must remain below
`extensions/<contributor-id>/`. Keep this inventory synchronized across the
producer, verifier, documentation, and live assertions.

Cleanup must run after failure or cancellation and must not depend on an already
aborted execution signal. Uncommitted artifact transactions must be rolled back.
Observers are non-authoritative and may not affect the run result.

### Treat credentials and inputs as capabilities

- Profiles, plans, events, and results contain opaque credential references,
  never secret values.
- Never copy the ambient host environment wholesale into a runtime.
- Keep setup and agent credential scopes separate.
- Keep completion-provider credentials host-side and purpose-specific. They do
  not become runtime environment values unless a runtime capability separately
  declares the same opaque reference.
- Avoid secrets in argv, errors, logs, transcripts, and artifacts. Preserve the
  existing redaction and secret-scanning boundaries across completion prompts
  and responses, transcripts, interaction audit, judge evidence, and results
  when adding new outputs.
- Dataset inputs must remain manifest-listed, hash-verified, bounded, regular
  files. Do not weaken traversal, symlink, special-file, or extra-file checks.
- Commands use argv vectors. Shell semantics must be requested explicitly by
  invoking a shell.
- Custom setup action IDs are versioned as `owner/action@N`; the `forge/`
  namespace is reserved for built-in actions.

### Keep results deterministic and atomic

- Canonical JSON, resolved plans, and artifact inventories must be stable and
  digestible.
- Stage artifacts out of sight and expose a completed run through one atomic
  commit boundary.
- A cleanup warning learned after staging belongs in the final result.
- Publication is downstream of a successful, verified local commit. The public
  execution engine must not call a host-specific remote publisher.
- Extensions must not overwrite canonical artifacts or bypass path, size,
  collision, digest, or secret validation.
- Preserve scoring semantics unless a versioned format change explicitly alters
  them: score is the guideline pass ratio, while a checks-only passing run has
  `status: passed` and numeric `score: 0`.
- Preserve interaction failure semantics: Ava exhaustion commits
  `role_player_error`; malformed judge output exhausts retries and fails that
  guideline closed; exhausted judge transport failures abort without a
  completed commit. Profile-level `retries` remains distinct from these fixed
  completion-attempt policies.

## Public API and TypeScript conventions

- The package requires Node.js 22 or newer and is ESM-only.
- TypeScript uses `module` and `moduleResolution` set to `NodeNext`. Relative
  source imports must include their emitted `.js` suffix.
- Preserve strict typing, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Prefer `unknown` plus validation over `any`.
- Use `import type` for type-only imports.
- Wire formats are strict and versioned. Update the TypeScript model, Zod parser,
  serialization, tests, and documentation together. Unknown authored fields
  should remain errors rather than being discarded.
- Do not mutate parsed input objects. Resolved plans should remain cloned and
  deeply frozen.
- Root exports come from `src/index.ts`; specialized implementations use
  documented subpaths. When adding or changing an entry point, update
  `package.json`, root/subpath export tests, the package smoke test, and README.
- Keep the built-in host completion transport on
  `@stripe/forge/providers/anthropic`; provider-specific request and
  authentication details do not belong in the root completion contract.
- Consumers must not depend on undeclared `dist/` paths.
- Do not add a bundler merely to build the library. The package builds with
  `tsc`; `dist/` is generated output and must not be edited by hand.
- Keep runtime dependencies small, portable, and suitable for a public
  Apache-2.0 package. Record required attribution and provenance.

## Repository map

- `src/model`: versioned wire types, strict parsing, hashes, paths, and loaders.
- `src/planning`: matrix expansion, case-file selection, and resolved plans.
- `src/contracts`: host-supplied capability interfaces.
- `src/execution`: the shared automated lifecycle and phase/error semantics.
- `src/interaction`: the engine-owned Ava role player, conversation loop,
  prompts, and interaction audit semantics.
- `src/agents`: public agent adapters and native-evidence normalization.
- `src/evidence`: engine-owned native-evidence validation, structural
  reconciliation, and driver-fallback construction.
- `src/providers`: public host-side completion transports, currently Anthropic
  Messages and compatible endpoints.
- `src/atif`: the pinned ATIF surface and upstream provenance.
- `src/runtime`: portable runtime mechanics and the public Docker adapter.
- `src/setup`: built-in actions and ordered setup execution.
- `src/evaluation`: evidence collection, checks, judging, and scoring.
- `src/results`: result schemas, transactional storage, and verification.
- `src/testing`: public fakes, fixtures, and adapter conformance helpers.
- `test`: package-level and end-to-end orchestration tests.
- `examples`: checked-in runnable datasets and profiles.

## Testing and verification

Place focused unit tests beside source files as `*.test.ts`. Put cross-module,
CLI, package, or example tests under `test/`. Prefer deterministic fake adapters
for the normal test suite; tests requiring Docker, credentials, or network access
must be explicitly opt-in.

Useful commands:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test -- path/to/file.test.ts
pnpm build
pnpm test:types
pnpm test:package
pnpm check
# Explicitly opt in and provide provider credentials before running:
FORGE_LIVE=1 ANTHROPIC_API_KEY=... pnpm test:live
```

Do not run a live Docker/agent example unless the task explicitly requires it.
Live runs need network access and credentials, and model calls may incur cost.
Keep Docker conformance, one-shot execution, multi-turn interaction, judging,
and artifact verification in the repository's single live-suite path.

Run the narrowest relevant test while iterating. Run `pnpm check` before handing
off a change that affects public types, exports, execution, packaging, or release
artifacts.

Changes should test successful behavior and the important failure boundary:
validation before authority, cancellation, bounded I/O, cleanup, rollback,
artifact collision/path safety, secret handling, and exact-session fallback.
For Ava and judging, cover zero-turn role-player failure, persistent session
identity, final-turn assessment, retry exhaustion, fail-closed malformed judge
output, transport abort, bounded sealed-workspace evidence, completion-call
summaries, and conditional canonical artifacts.

When changing checked-in examples, update all dependent file sizes and SHA-256
digests in the dataset manifest and profile, plus any mirrored README snippets.
When changing packaged Docker assets or tool pins, update and test their recorded
digests and runtime metadata. ATIF changes must remain tied to a specific
upstream version and update provenance, conformance tests, and notices together.

## Documentation expectations

- Update the README whenever CLI syntax, schemas, public entry points, security
  properties, requirements, or current limitations change.
- Describe current behavior separately from future architecture.
- Include an end-to-end example for new user-facing behavior.
- Keep public documentation free of private repository paths, credentials,
  infrastructure details, and migration-only formats.
