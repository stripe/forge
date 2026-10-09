# Embedding Forge

Use Forge's public APIs when your application needs its own runtime, credential
resolver, command interface, or publication workflow. Forge still owns setup
ordering, interaction, evidence selection, evaluation, and the commit boundary.
The host supplies mechanisms through a `ForgeComposition`; an immutable
`ForgeEngine` selects setup semantics. See
[engines and compositions](architecture.md#engines-action-registries-and-compositions)
for those boundaries.

Depend on an exact `@stripe/forge` version and use its documented ESM exports.
The README covers [installation](../README.md#installation),
[authoring inputs](../README.md#authoring-cases-and-experiments),
[running experiments](../README.md#running-experiments), and
[results and scores](../README.md#results-and-scores).
Do not import `dist/` files or undeclared internal paths. CommonJS applications
can load the package with `await import('@stripe/forge')`.

## Execute one selection

This example uses the checks-only, one-shot quickstart inputs. Save it as
`run.mjs` in the directory containing `dataset/` and `experiment.yaml`, then run
it with `ANTHROPIC_API_KEY` configured. It makes potentially billable agent
calls and requires Docker. For cases that use Ava or criterion judging, also
register [completion providers](#completion-providers).

```js
import {
  createArtifactStore,
  createDirectoryRunInputProvider,
  createEnvironmentCredentialResolver,
  executeEval,
  expandExperiment,
  loadDataset,
  loadExperimentConfig,
  resolveRunPlan,
  verifyCompletedRun,
} from '@stripe/forge';
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';
import {
  createDockerRuntimeAdapter,
  detectDockerRuntimePlatform,
} from '@stripe/forge/runtime/docker';

const [dataset, experiment] = await Promise.all([
  loadDataset('./dataset'),
  loadExperimentConfig('./experiment.yaml'),
]);
const selections = expandExperiment(experiment, dataset);
if (selections.length !== 1) throw new Error('Choose exactly one selection');

const runtimePlatform = experiment.config.runtime.adapter === 'docker'
  && experiment.config.runtime.platform === 'native'
  ? await detectDockerRuntimePlatform()
  : undefined;
const plan = resolveRunPlan({
  dataset, experiment, selection: selections[0],
  ...(runtimePlatform === undefined ? {} : {runtimePlatform}),
});
const claude = createClaudeCodeAdapter();
const composition = {
  runtime: createDockerRuntimeAdapter(),
  agents: new Map([[claude.id, claude]]),
  credentialResolver: createEnvironmentCredentialResolver({
    bindings: {'anthropic.api-key': 'ANTHROPIC_API_KEY'},
  }),
  inputProvider: await createDirectoryRunInputProvider(dataset.root, {
    manifest: dataset.manifest,
  }),
  artifactStore: createArtifactStore({root: './results'}),
};
const completed = await executeEval({runId: 'hello-001', plan, composition});
await verifyCompletedRun(completed.location);
console.log(completed.location);
```

Pass the verified manifest to `createDirectoryRunInputProvider` so later setup
reads recheck file sizes, hashes, and the exact directory inventory. A root-only
provider offers path-safe access without content pinning. Programmatic hosts
can supply a loaded dataset directly without `dataset.path`; that field is a
CLI location hint, not part of the resolved plan.

`expandExperiment` supports flat and grouped matrices. `ExperimentMatrixV1` is
the union of `FlatExperimentMatrixV1` and `GroupedExperimentMatrixV1`;
`getMatrixGroups(matrix)` exposes either as a read-only list of
`ExperimentMatrixGroupV1` axes. Expansion resolves manifest-listed case paths
to their declared IDs and returns ordinary selections for either form.

An authored Docker `platform: native` must be materialized before planning,
as above. Hosts using a remote or wrapped Docker executable can pass the same
executable or an explicit host command runner to `detectDockerRuntimePlatform`.
The public CLI performs this step automatically.

Use `verifyCompletedRun` to validate a stored run and its companion artifacts
before consuming or publishing it. Standalone companion parsers require the
producer version obtained from the parsed result:

```js check
import {parseRunResult, parseSetupArtifact} from '@stripe/forge';

function parseStoredSetup(resultJson, setupJson) {
  const result = parseRunResult(resultJson);
  return parseSetupArtifact(setupJson, {forgeVersion: result.forge.version});
}
```

`parseInteractionArtifact` and `parseJudgeEvidence` use the same
`ForgeArtifactParseContext`. Companion files inherit the result's Forge release;
`verifyCompletedRun` supplies this context and verifies their bindings for you.

## Run and resume batches

`@stripe/forge/experiment` supplies the shared local run loop. This example
reuses the input loading, composition, and `runtimePlatform` above. Replace the
single-selection guard, plan construction, and execution with the following
code to run a batch with any number of selections.

```js
import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {defaultForgeEngine} from '@stripe/forge';
import {readExperimentRunSelections, runExperiment} from '@stripe/forge/experiment';

const engine = defaultForgeEngine; // Or the host's immutable custom engine.
const resumeId = undefined; // Set to an existing experiment run ID to resume.
const experimentRunId = resumeId ?? randomUUID();
const root = path.resolve('results', 'experiments', experimentRunId);
const selected = resumeId === undefined
  ? expandExperiment(experiment, dataset)
  : await readExperimentRunSelections(root);
const plans = selected.map((selection) => engine.resolveRunPlan({
  dataset, experiment, selection,
  ...(runtimePlatform === undefined ? {} : {runtimePlatform}),
}));
const summary = await runExperiment({
  root,
  plans,
  engine,
  composition: {...composition, artifactStore: createArtifactStore({root})},
  resume: resumeId !== undefined,
  jobs: 4,
  signal: new AbortController().signal,
  execute: (input) => engine.executeEval(input),
  runIdFactory: randomUUID,
  progress: (event) => console.error(event),
});
console.log(summary);
```

`runExperiment` preflights every plan with the supplied engine and composition
before writing checkpoints or invoking `execute`. Use that same engine for
loading, planning, execution, and verification when it includes action bundles.
The execution callback may acquire per-eval host resources and construct another
composition, but must honor its signal and finish cleanup in `finally` before
settling. Its full lifetime occupies a job slot. The artifact store must commit
at `<root>/runs/<eval-run-id>` so the controller can verify results.

Progress callbacks are synchronous. Throwing stops scheduling and cancels active
work. Optional synchronous `onOutcome(outcome, selectionIndex)` collects bounded,
verified outcomes, including selections skipped on resume; throwing has the
same scheduling effect. `ExperimentRunOptions`, `ExperimentRunProgressEvent`,
`ExperimentRunSummary`, and `ExperimentRunOutcome` are exported from this subpath.

Resume restores the saved selections and requires their original plan checksums.
Valid completed evaluations, including failed or partial scores, are skipped;
execution errors and missing or invalid artifacts are retried with new eval run
IDs. Cancellation drains active callbacks before releasing the checkpoint lock.
See [running experiments](../README.md#running-experiments) for output layout,
concurrency, retry, and recovery behavior.

`runExperiment` and `runExperimentCommand` automatically write `report.json`
and return its path as `summary.report`. `parseExperimentRunReport` validates
producer compatibility and agreement between run rows and aggregate statistics.
`ExperimentRunReportV1` and its evaluation, run, statistics, and case types are
exported from `@stripe/forge/experiment`. On normal-completion reporting failure,
`runExperiment` rejects with `ExperimentRunReportError`, carrying the report path
and original cause. `runExperimentCommand` wraps it as the cause of an
`ExperimentCommandError`; saved evaluations remain resumable.

### Build a command host

`@stripe/forge/experiment/cli` provides shared `--jobs`/`-j`, `--resume <id>`,
`--output`/`-o`, and `--run-id` handling. `runExperimentCommand` selects the
experiment run ID and root, restores saved selections before loading inputs,
and delegates to `runExperiment`. Hosts own their argument grammar, input
format, validation, and loader. The public `forge run` uses this same stage.

This example is an embedding pattern: `prepareInputs` and `publish` are
host-supplied functions.

```js
import {runExperimentCommand} from '@stripe/forge/experiment/cli';

async function runHostCommand(argv, {engine, prepareInputs, publish}) {
  const result = await runExperimentCommand(argv, {
    engine,
    hostOptions: {
      experiment: {type: 'string', short: 'e'},
      case: {type: 'string'},
      upload: {type: 'boolean'},
    },
    selectorOptions: ['case'],
    validateHostArgs({values}) {
      if (!values.experiment) throw new Error('--experiment is required');
    },
    loadExperiment: async (context) => {
      // On resume, reproduce context.savedSelections in their original order.
      const inputs = await prepareInputs(context);
      return {
        plans: inputs.plans,
        composition: inputs.preflightComposition,
        execute: (request) => inputs.execute(request),
        dispose: () => inputs.dispose(),
      };
    },
  });
  if (result.arguments.values.upload) await publish(result.outcomes);
  return result;
}
```

The outer router owns commands, help, and version handling. Compose its parser
with `createExperimentCliOptions(hostOptions)` or use `parseExperimentArgs`;
forward shared run flags through that parser. Long-name and short-alias
collisions are rejected. `allowPositionals: true` lets `validateHostArgs` enforce
host-specific positional grammar, including rejection of positional selectors
on resume. `suppliedOptions` lists explicit options independently of defaults.
Explicit options in `selectorOptions` are forbidden on resume: the loader must
restore saved selections and reproduce their original plan checksums.

A pinned dependency upgrade exposes compatible operational flags; flags needing
new host inputs or capabilities still require integration. Loading may parse
and materialize inputs, but must defer credentials, bridges, runtime allocation,
and tool preparation until `execute`, after every plan passes pure preflight.
The loader owns partial cleanup if it throws before returning. After it returns,
the wrapper awaits `dispose` exactly once after callbacks drain, preserving the
primary error if disposal also fails. Cancellation during disposal still rejects
the command after cleanup. Input disposal and per-run cleanup must operate
independently of an aborted execution signal. Shared host resources must support
the chosen concurrency.

The result contains the experiment run reference, counts, parsed arguments,
and one outcome per selection in original order. Outcomes contain the plan
digest, latest eval run ID, execution state/error code, and, when verified, a
local artifact reference with evaluation status/score and a bounded failure code.
The host owns publication and the final exit policy.

`runCli` from `@stripe/forge/cli` is another option for wrappers that retain the
public command grammar: provide both the engine and a `compositionFactory`.
The factory receives the selected descriptor in `options.runtime`, letting the
host choose its runtime implementation explicitly.

### Publish and inspect saved outcomes

Publish only after the shared stage finishes. Keep destination-specific upload
state outside `experiment.json`, keyed by immutable run/artifact identity and
destination. Use idempotent publication or a publication lock, include verified
skipped outcomes, and keep uploads out of execution and outcome callbacks.
An upload failure must not rerun an eval.

`inspectExperimentRun({root, engine, signal?})` from `@stripe/forge/experiment`
verifies the latest attempt for every saved selection without loading inputs,
acquiring execution credentials, or changing the checkpoint. Both the saved
selection and plan digest must match the verified commit. This permits
publication-only retries even when original sources have changed.

Inspection derives effective state from artifacts as resume does: a running or
errored checkpoint with a valid successful commit is reported completed. It
returns no historical attempts; unstarted selections remain pending, and missing
or invalid artifacts have no publishable reference. Inspection is a snapshot
and does not wait for active execution. After a failed command stage drains and
disposes inputs, `ExperimentCommandError.reference` identifies its experiment
run for inspection. Its caller-owned `cause` must not be persisted wholesale.
The wrapper performs no publication after cancellation or other failure.

Publishers must enforce access controls for descriptors marked
`sensitivity: restricted`. Exact native session logs are deliberately retained
unredacted and may contain sensitive data. See
[security and auditability](../README.md#security-and-auditability).

## Completion providers

An `AgentAdapter` drives the coding agent inside the runtime and collects its
session evidence. A `CompletionProvider` makes host-side structured-output calls
for Ava (`role_player`) and criterion judging (`judge`). It receives neither a
workspace nor command authority, and cannot replace Ava's state machine.

`requirements()` is a pure declaration checked during composition preflight.
During execution, Forge resolves the declared credentials by purpose, calls the
provider's optional credential-aware `preflight()`, and invokes `complete()`
with the model, purpose, system prompt, message history, strict response schema,
and abort signal. Prompts are redacted before dispatch, responses before parsing
or persistence, and only safe call summaries enter `result.json`.

Register providers by ID, or use a `CompletionProviderResolver` for model routing:

```js
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '@stripe/forge';
import {createAnthropicCompletionProvider} from '@stripe/forge/providers/anthropic';

const anthropicCompletions = createAnthropicCompletionProvider({
  credential: credentialReference('anthropic.api-key'),
});
const credentialResolver = createEnvironmentCredentialResolver({
  bindings: {'anthropic.api-key': 'ANTHROPIC_API_KEY'},
});
const completionProviders = new Map([
  [anthropicCompletions.id, anthropicCompletions],
]);
```

Add `completionProviders` and `credentialResolver` to the composition. Providers
in `models.role_player` and `models.judge` must match resolved provider IDs.
Completion providers are optional only when the plan needs neither Ava nor
judging. Codex is an agent adapter; multi-turn or judged Codex experiments still
need independently configured host completions. The built-in Anthropic provider
requires Claude 4.5-or-newer model identifiers for strict structured output.

Built-in adapters and providers use the Forge package version; independent
integrations supply their own `version`. Optional `AgentAdapter.metadata`
contains only `endpoint_mode` and `layout_mode`; `CompletionProvider.metadata`
contains only `endpoint_mode`. Each value is `default` or `custom`. Forge
validates and freezes snapshots during pure preflight and persists them under
`agent.metadata` and `completion_calls[].provider_metadata`.

### Configure an Anthropic-compatible endpoint

The built-in provider uses Node.js 22's native `fetch` and appends `/v1/messages`
to its explicit `baseUrl`. HTTPS is required except for loopback development
endpoints; host-side requests reject redirects with `http_error`. The provider
does not read ambient credentials. An embedding host configures both agent and
completions explicitly:

```js
import {
  createEnvironmentCredentialResolver,
  credentialReference,
} from '@stripe/forge';
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';
import {createAnthropicCompletionProvider} from '@stripe/forge/providers/anthropic';

const gatewayBaseUrl = process.env.ANTHROPIC_BASE_URL;
if (!gatewayBaseUrl) throw new Error('ANTHROPIC_BASE_URL is required');
const gatewayClaude = createClaudeCodeAdapter({
  id: 'claude-code-gateway',
  provider: 'anthropic-compatible',
  baseUrl: gatewayBaseUrl,
  credential: credentialReference('anthropic.gateway-token'),
  credentialEnvironmentName: 'ANTHROPIC_AUTH_TOKEN',
});
const gatewayCompletions = createAnthropicCompletionProvider({
  id: 'anthropic-compatible',
  baseUrl: gatewayBaseUrl,
  auth: 'bearer',
  credential: credentialReference('anthropic.gateway-token'),
});
const credentialResolver = createEnvironmentCredentialResolver({
  bindings: {'anthropic.gateway-token': 'ANTHROPIC_AUTH_TOKEN'},
});
```

Register these in the composition and select matching experiment coordinates:

```yaml
models:
  role_player:
    provider: anthropic-compatible
    model: claude-sonnet-4-6
  judge:
    provider: anthropic-compatible
    model: claude-sonnet-4-6
matrix:
  agents:
    - adapter: claude-code-gateway
      provider: anthropic-compatible
      model: claude-sonnet-4-6
```

The endpoint must implement the APIs expected by Claude Code and the provider,
including structured output, and be reachable from both host and runtime.
A loopback URL points at the container when used by the coding agent. Private
CAs, special proxying, mounts, and network policy require an explicit custom
runtime. Keep tokens out of authored inputs, plans, logs, and metadata; results
record endpoint mode without endpoint URLs or credentials.

## Agent adapters and runtime layouts

Register `createCodexAdapter` from `@stripe/forge/agents/codex` in the agent map
to use Codex. Options include explicit `id`, `provider`, `executable`,
`expectedVersion`, `credential`, `credentialEnvironmentName`, `baseUrl`, and
`layout`. `baseUrl` is a Responses-compatible API root, rather than a Chat
Completions endpoint. Changing the CLI version requires validating its stream
and rollout formats against the adapter.

Both built-in adapters accept a fixed runtime-visible layout:

```js
import {createClaudeCodeAdapter} from '@stripe/forge/agents/claude-code';

const claude = createClaudeCodeAdapter({
  layout: {
    workspace: '/run/example/workspace',
    home: '/run/example/home',
    configDirectory: '/run/example/session',
  },
});
```

Choose run-owned paths in trusted host code before constructing the adapter;
the runtime creates them during preparation and must report matching home and
workspace paths. Layouts are validated and snapshotted without filesystem
access. Claude config, plugins, and project logs share the configuration root,
including when it differs from `HOME`; Codex's configuration directory is its
run-owned `CODEX_HOME`. `ClaudeCodeLayout` is exported from the Claude subpath.
Custom layouts record `layout_mode: custom`; standard layouts record `default`.

The built-in agents disable their own approvals and sandbox inside the isolated
runtime, so a custom runtime must provide suitable isolation. Plugin installation
uses the narrow `AgentPluginInstaller` capability; consult the
[plugin contract](plugin-action.md) for native sources, Codex hook policy,
writable state, and installation-time receipts.

## External runtimes

Supply a `RuntimeAdapter` through `composition.runtime` and a fully specified
descriptor in the experiment. The stock CLI cannot execute an external
descriptor without a host-supplied implementation.

```yaml
runtime:
  adapter: acme/process
  platform: linux/amd64
  config:
    profile: isolated-worker
    tool_build: immutable-build-123
    network_policy: approved-egress
```

The adapter owns `config` semantics. Forge validates a strict envelope and
bounded plain JSON (at most 1 MiB serialized), rejects unsafe keys, and adds no
defaults or transformations. Keep credentials and infrastructure clients in the
composition; configuration records declared resources, network policy, and
immutable tool identity rather than private host paths or inferred settings.
A namespaced adapter ID and platform are required; `docker` and `forge/docker`
are reserved. Supply the implementation explicitly, without global discovery
or imports named by YAML.

Implement synchronous, pure `preflight({plan, requirements, environment})`.
It must reject unknown configuration fields, missing effective settings,
unsupported requirements, and incompatible limits before credentials resolve
or resources are allocated. It cannot inspect ambient state, normalize defaults,
allocate, or return a promise. Host checks belong in `prepare()`. A runtime with
host imports may defer physical executable checks until imports finish, but
must complete them after setup command authority closes and before interaction.
The Docker runtime requires regular files executable by its final non-root user.

The preflight environment contains plain variables and opaque credential names,
references, and scopes; resolved values arrive only at `prepare()`. The adapter
ID must match the plan exactly. The full descriptor contributes to the plan
checksum. Offline verification checks recorded identity and artifacts without
loading the adapter, and cannot establish private configuration semantics or
actual isolation enforcement.

### State, host imports, and conformance

State requirements retain `containerPath` as the field name; it means an
absolute path visible to commands in the selected runtime. Expose exactly the
declared state directories and enforce mutable, setup-finalized, sealed, and
disposed boundaries. Reject `sealAfterSetup: true` during preflight if it cannot
be enforced. Forge calls `finalizeSetup()` once after all setup operations succeed
and before opening the agent session. Docker seals selected state by replacing
the setup container with one whose selected mounts are read-only.

Trusted hosts can use optional `PreparedRuntime.importHostFile` to install a
large file into declared state without buffering it all in Node. Supply an
absolute source path, one safe filename at the state root, a byte limit, and the
expected SHA-256. Docker streams and verifies staged bytes before publishing
them atomically. `verifyAfterSetup: true` rechecks the file as setup ends and
requires sealed state. The capability is host-only, unavailable to YAML, setup
actions, or agents. Custom runtimes may omit it. Docker permits state mounts
under `/home/forge`, or under `/opt` when sealed after setup.

Import verification establishes transfer integrity but currently emits no core
receipt for the installed digest, size, mode, or destination. If those bytes
affect evaluation, their missing persisted identity is a provenance gap. Pinning
an expected digest in resolved runtime configuration strengthens declared intent.
Runtime metadata may record actual build or deployment identity, but Forge does
not guarantee complete capture of material runtime state or external systems.

Use `assertRuntimeAdapterConforms` from `@stripe/forge/testing` to exercise an
adapter. Optional `commandProbes` test scoped results with synthetic credentials;
`cancellationProbe` uses a ready line and bounded abort deadline. The helper also
checks state bytes and revocation of mutable and command handles. Real runtimes
must additionally test process cleanup, background writers, filesystem boundaries,
and isolation; test doubles cannot establish those guarantees. The
[external-runtime example](https://github.com/stripe/forge/blob/main/examples/external-runtime/README.md) demonstrates
the ordinary execution and verification lifecycle offline with test adapters.

## Credentials and lifecycle authority

Declare executable, state-directory, variable, and credential requirements
before allocation. Credentials are opaque references until the resolver receives
only those requested by the selected plan. Completion credentials stay host-side
unless an agent or setup capability independently declares the same reference.
Forge derives setup or agent scope from the declaration source; handlers do not
assign raw scope metadata. For example, an agent declaration receives agent scope:

```ts fragment
requirements() {
  return {
    executables: ['acme-agent'],
    environment: {
      credentials: {
        ACME_TOKEN: {reference: credentialReference('acme.agent-token')},
      },
    },
    stateDirectories: [],
  };
}
```

Environment declarations are strict JSON-like objects: arrays, explicit `null`,
unknown fields, and extra credential-binding fields fail pure preflight. Runtime
command projections separate plain variables (`uncredentialed`), setup-declared
secrets (`setup`), and agent-declared secrets (`agent`). Preparation gets only
uncredentialed commands; an open session gets only agent commands. Each prepared
setup operation gets exactly its declared setup credentials and state directories.

Only `executeEval` retains `quiesce()` and `dispose()` authority. Evidence
collection receives read-only sealed workspace and run-owned state, with no
commands or cleanup authority. An agent's pure `evidenceIdentity()` declares its
coding-agent name/version for fallback ATIF. After quiescence, `collectEvidence()`
returns only an exact-session native candidate or an explicit unavailable reason.
Adapters must translate native read/normalization failures into that reason;
malformed data labeled `available` is a contract violation. The engine reconciles
evidence with completed turns and owns fallback selection.

Add trusted setup semantics through [action bundles](setup-action-bundles.md),
registered before engine construction. Built-in actions remain owned by the
installed Forge release. Actions should return bounded non-sensitive resolutions
for material choices made during setup; a receipt does not guarantee complete
capture of runtime state or make changing external dependencies replayable.

Artifact contributors write only below `extensions/<contributor-id>/` and their
output is scanned for resolved secrets. They are trusted host JavaScript and
cannot replace canonical artifacts. Observer failures never change scoring;
publication follows commit and remains host-owned. See the
[execution lifecycle](architecture.md#execution-lifecycle) and
[security boundaries](architecture.md#security-and-trust-boundaries) for the
full contracts.
