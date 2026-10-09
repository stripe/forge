# Authoring cases and experiments

Use this guide to create or update evaluation inputs. The
[quickstart](../README.md#run-your-first-experiment) generates a working bundle without
hand-maintained hashes; [running experiments](../README.md#running-experiments)
explains validation, selection, and resume. The
[architecture guide](architecture.md#the-benchmark-data-model) describes how
authored inputs become immutable plans.

A dataset owns cases and fixture bytes. Cases own tasks, invariant setup, and
grading requirements. An experiment independently pins a dataset and selects
treatments, agents, harness models, and runtime settings. Keep credentials and
endpoint configuration in the execution environment rather than these inputs.

## Cases

Each case declares a stable `id`, independent of its filename or location.
Authored IDs use lowercase kebab-case segments separated by `/`, such as
`examples/hello-file`. IDs must be unique within a dataset release.

A one-shot case supplies exactly one of `task` or `initial_prompt` and sends
that text once. It cannot supply `context`. For example:

```yaml
id: examples/hello-file
display_name: Hello file
initial_prompt: Create hello.txt containing exactly "hello, forge!" followed by a newline.
execution_mode: one_shot
setup: []
judging_criteria: []
checks:
  files_created:
    - hello.txt
  file_checks:
    - file: hello.txt
      exists: true
      contains: '^hello, forge!\n(?![\s\S])'
```

The content check uses a JavaScript regular expression. The negative lookahead
at the end requires the end of input, so missing or extra trailing newlines do
not satisfy this task. Existence checks inspect the final workspace; they do
not establish when a path was created. Content checks require captured
regular-file text. This checks-only, one-shot case needs no host completion
models.

A multi-turn case supplies `task`, with optional `context` and
`initial_prompt`:

```yaml
id: examples/design-review
task: Work with the coding assistant to finish the requested design.
context: You are a developer maintaining this project.
execution_mode: multi_turn
max_turns: 6
setup: []
judging_criteria:
  - The assistant implements the requested behavior and explains the tradeoff.
checks: {}
example_answer: A concise reference answer used only to calibrate the judge.
```

`execution_mode` defaults to `multi_turn`. Its `max_turns` defaults to 10 and
cannot exceed 100. When `initial_prompt` is supplied, Forge sends it as the
first user turn, then Ava initializes after the response. Otherwise Ava
generates the opening turn. Ava and the judge use independently selected
host-side models; they are not the coding agent. The optional `example_answer`
is supplied only to the criterion judge. See
[interaction semantics](architecture.md#interaction-architecture) and
[criterion judging](architecture.md#criterion-judging) for their exact policies.

## Datasets and integrity

Keep release documentation and experiment settings outside the exact-manifest
dataset tree:

```text
my-eval/0.1.0/
├── experiment.yaml
└── dataset/
    ├── manifest.json
    ├── cases/
    │   └── examples/
    │       └── hello-file.case.yaml
    └── fixtures/
        └── example.json
```

`manifest.json` contains:

| Field | Meaning |
| --- | --- |
| `dataset.id`, `dataset.version` | Dataset release identity. |
| `cases` | Dataset-relative paths to every case definition. Each case declares its own ID. |
| `files` | Exact inventory of regular payload files, each with `path`, byte `size`, and lowercase SHA-256 hex `sha256`. |

Do not include `manifest.json` itself in `files`. Include every case and fixture
file. Extra, missing, modified, symbolic-link, or special-file payloads make
the dataset invalid. Temporary files, editor backups, and release notes inside
the dataset are payloads too.

Case paths start with `cases/`. Accepted filenames are `case.yaml` or
`<name>.case.yaml`, where the name is nonempty. For example, use
`cases/examples/hello-file.case.yaml` for a flat case, or
`cases/examples/hello-file/case.yaml` for a directory case. Matrix entries use
these complete paths; CLI `--case` filters use the declared IDs.

Payload paths must be canonical relative POSIX paths, without a leading `/`,
`./`, traversal, or backslashes. YAML and JSON inputs use strict schemas:
unknown fields, unsafe names, unknown or version-suffixed setup actions, and
oversized values are rejected. YAML also rejects duplicate keys. The installed
Forge release defines the accepted schemas; an authored input does not carry
a `schema_version` field.

## Experiment configs

An experiment declares its own `id` and `version`. Its `dataset` pin must match
the loaded dataset's ID, version, and SHA-256 digest of the exact raw
`manifest.json` bytes. For the CLI, set `dataset.path: ./dataset`; Forge resolves
that hint relative to the experiment file. Programmatic hosts may omit it and
supply a loaded dataset. The path is excluded from resolved plans and their
checksums, so moving the whole bundle does not change selected semantics.

The installed Forge package version identifies parsing and execution behavior;
dataset and experiment versions identify input definitions. They are separate
identities. Plans and results record their producing Forge version. Official
releases require an exact producer/reader version match; two `X.Y.Z-dev.*`
versions can be read with current strict schemas on a best-effort basis.
To execute inputs with a newer Forge release, resolve a fresh plan. See
[release compatibility](architecture.md#1-parse-and-pure-preflight).

The built-in runtime uses this descriptor:

```yaml
runtime:
  adapter: docker
  image:
    kind: forge
  platform: native
```

`native` materializes the Docker server architecture during planning or
execution. For a benchmark where architecture is part of the definition, pin
`linux/amd64` or `linux/arm64` instead. Omitted Docker resources default to
4 GiB memory, 2 CPUs, and 512 processes; the run timeout defaults to 1,800,000 ms.
Authored defaults become explicit in the resolved plan.

A checks-only, one-shot experiment uses `models: {}`. Add `models.role_player`
for selected multi-turn cases and `models.judge` for selected cases with
nonempty `judging_criteria`:

```yaml
models:
  role_player:
    provider: anthropic
    model: claude-sonnet-4-6
  judge:
    provider: anthropic
    model: claude-sonnet-4-6
```

These coordinates select host completion providers, independently of
`matrix.agents`. Unused harness model settings are excluded from the selected
plan. The public CLI supplies the Anthropic completion provider, which requires
Claude 4.5-or-newer model identifiers for structured output. Codex can be the
coding agent while Ava and judging still use Anthropic.

### Experiment matrices

A flat matrix evaluates every combination of its `cases`, `treatments`, and
`agents`, repeated `repetitions` times. Cases are complete dataset-relative
paths, including `cases/`; each must occur in the manifest.

Use groups when different cases need different treatments or models in the
same experiment. Each group evaluates its own Cartesian product:

<!-- grouped-matrix:start -->
```yaml
matrix:
  repetitions: 2
  retries: 0
  groups:
    - cases:
        - cases/examples/payment.case.yaml
      treatments:
        - baseline
        - payment-plugin
      agents:
        - adapter: claude-code
          provider: anthropic
          model: claude-sonnet-4-6
        - adapter: claude-code
          provider: anthropic
          model: claude-opus-4-6
    - cases:
        - cases/examples/marketplace/case.yaml
      treatments:
        - baseline
        - marketplace-plugin
      agents:
        - adapter: claude-code
          provider: anthropic
          model: claude-opus-4-6
```
<!-- grouped-matrix:end -->

This fragment assumes both case paths are in the manifest and all three
treatments are defined. It produces **12 selections**: eight for payment and
four for marketplace. It never creates combinations across groups.

Choose flat axes or `groups`; mixing them is an error. Every group provides
nonempty `cases`, `treatments`, and `agents`. `repetitions` and `retries` belong
at matrix level. A case may appear in several groups, but duplicate resolved
selections, including materialized agent defaults, are rejected.

Groups flatten into ordinary selections without a group identity in plans,
checkpoints, or reports. Ordering is group, case, treatment, agent, then
zero-based repetition. The current run controller attempts pending entries
once per invocation; `retries` does not trigger automatic attempts.

### Select Codex

To run the [quickstart](../README.md#run-your-first-experiment) with Codex,
replace its `matrix.agents` with the following entries, keeping the other
matrix fields and dataset pin:

```yaml
matrix:
  agents:
    - adapter: codex
      provider: openai
      model: gpt-5.4
      hook_trust: native
```

The model is an explicit experiment choice, subject to provider availability.
Validate the changed experiment, configure the Codex key, and run:

```sh
npx --no-install forge validate --experiment ./quickstart/experiment.yaml
export CODEX_API_KEY=your-restricted-key
npx --no-install forge run \
  --experiment ./quickstart/experiment.yaml \
  --output ./results --run-id codex-001
```

This checks-only run needs no Anthropic credential. `hook_trust: native` lets
Codex enforce its normal hook review requirements. `automation` permits all
enabled hooks, including workspace hooks, to run without review in the isolated
runtime. See [plugin hook policy](plugin-action.md#hook-policy-and-writable-state).

## Setup and treatments

Case setup applies first, followed by selected treatment setup, in authored
order. Put fixtures and prerequisites shared by every treatment on the case.
Put the intervention being compared on its treatment. An explicitly declared
`baseline` treatment must have an empty setup list.

`forge/write` writes inline UTF-8 content or a manifest-listed dataset file to
a workspace-relative target:

```yaml
setup:
  - uses: forge/write
    with:
      target: seed.txt
      source:
        content: "seed data\n"
  - uses: forge/write
    with:
      target: config/example.json
      source:
        dataset_path: fixtures/example.json
```

`forge/command` executes literal argv without implicit shell parsing:

```yaml
setup:
  - uses: forge/command
    with:
      argv: [npm, test]
      cwd: .
      timeout_ms: 120000
```

Request shell behavior explicitly, such as
`argv: [sh, -lc, "printf ready > status.txt"]`. Setup failures stop the run.
This action declares no credentials; its command receives the uncredentialed
environment. A credentialed operation needs a typed setup action supplied by
a trusted embedding host. Setup commands run before the agent: running
`npm test` in setup does not evaluate code the agent later writes. Built-in
deterministic evaluation supports file checks, without post-agent commands.

Use `forge/plugin` for native marketplace plugin treatments; its current
marketplace entry is intentionally resolved during execution. See
[Marketplace plugin treatments](plugin-action.md) for supported agent branches,
sources, verification, and receipts. Trusted hosts can register immutable
[setup action bundles](setup-action-bundles.md). Action IDs use `namespace/name`
without an individual version suffix; built-in meaning comes from the installed
Forge package, while a host bundle has an explicit version and digest pin.

## Updating a dataset release

Treat a released bundle as immutable. For a new definition, copy it to a new
versioned directory, update the dataset and experiment versions as appropriate,
and retain the old bundle for inspection and resume. Keep stable IDs for cases
that still represent the same task; a substantively different task needs an
intentional identity decision.

1. Edit case and fixture bytes, then update the manifest's `cases` list for any
   additions or removals.
2. Recompute the complete `files` inventory, sizes, and hashes.
3. Hash the final manifest bytes and update the experiment's
   `dataset.manifest_sha256`, ID, and version pin. Update every experiment that
   refers to that dataset.
4. Run `forge validate --experiment ./experiment.yaml`, then inspect one
   selected plan before executing. Validation is offline unless `--host` is
   supplied. An edited selected plan cannot resume an existing experiment run
   whose checkpoint binds the original plan checksum.

The following Node.js script proposes a fresh inventory and prints its manifest
pin without modifying your inputs. Save it as `refresh-manifest.mjs` **outside
the dataset tree**. It preserves the existing dataset identity and `cases` list,
so edit those deliberately first.

```js
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, readFile, readdir} from 'node:fs/promises';
import * as path from 'node:path';

if (process.argv.length !== 3) throw new Error('Usage: node refresh-manifest.mjs <dataset>');
const root = path.resolve(process.argv[2]);
const rootStat = await lstat(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root === path.parse(root).root) {
  throw new Error('Choose a real dataset directory, not a filesystem root');
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const files = [];
async function visit(relative = '') {
  const entries = await readdir(path.join(root, relative), {withFileTypes: true});
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const payloadPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (payloadPath === 'manifest.json') continue;
    if (entry.isDirectory()) {
      await visit(payloadPath);
    } else if (entry.isFile()) {
      const hash = createHash('sha256');
      let size = 0;
      for await (const bytes of createReadStream(path.join(root, payloadPath))) {
        size += bytes.length;
        hash.update(bytes);
      }
      files.push({path: payloadPath, size, sha256: hash.digest('hex')});
    } else {
      throw new Error(`Not a regular payload: ${payloadPath}`);
    }
  }
}
await visit();
const output = `${JSON.stringify({...manifest, files}, null, 2)}\n`;
process.stdout.write(output);
process.stderr.write(`manifest_sha256: sha256:${createHash('sha256').update(output).digest('hex')}\n`);
```

Run it from the directory containing your dataset:

```sh
node refresh-manifest.mjs ./dataset > ./manifest.next.json
```

Review `manifest.next.json`, then replace `dataset/manifest.json` with those
exact bytes and copy the printed pin into the experiment. Keep the candidate
outside `dataset/`, and leave no temporary payloads inside it. The script
computes integrity records; `forge validate` establishes that the resulting
inventory, cases, and experiment satisfy Forge's schemas and references.
