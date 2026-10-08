import type {ForgeBuildIdentity} from '../version.js';

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_DOCKER_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_DOCKER_CPU_COUNT = 2;
export const DEFAULT_DOCKER_PROCESS_COUNT = 512;

/** Types are aliases rather than brands so parsed values remain plain data. */
export type Sha256Hex = string;
export type Sha256Digest = `sha256:${string}`;
export type DatasetRelativePath = string;
export type CaseId = string;
export type TreatmentId = string;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface DatasetIdentityV1 {
  id: string;
  version: string;
}

export interface DatasetManifestCaseV1 {
  id: CaseId;
  path: DatasetRelativePath;
}

export interface DatasetManifestFileV1 {
  path: DatasetRelativePath;
  size: number;
  sha256: Sha256Hex;
}

export interface DatasetManifestV1 {
  dataset: DatasetIdentityV1;
  cases: DatasetManifestCaseV1[];
  files: DatasetManifestFileV1[];
}

/** Exact host-supplied implementation identity for one setup-action namespace. */
export interface SetupActionBundleReferenceV1 {
  namespace: string;
  version: string;
  sha256: Sha256Digest;
}

/** Common JSON wire envelope understood before an action implementation is selected. */
export interface SetupStepV1<TWith extends JsonObject = JsonObject> {
  uses: string;
  with: TWith;
}

export interface WriteSetupWithV1 extends JsonObject {
  target: string;
  source: {content: string} | {dataset_path: DatasetRelativePath};
}

export interface WriteSetupStepV1 extends SetupStepV1<WriteSetupWithV1> {
  uses: 'forge/write';
  with: WriteSetupWithV1;
}

export interface CommandSetupWithV1 extends JsonObject {
  argv: string[];
  cwd?: string;
  timeout_ms?: number;
}

export interface CommandSetupStepV1 extends SetupStepV1<CommandSetupWithV1> {
  uses: 'forge/command';
  with: CommandSetupWithV1;
}

/** One agent's marketplace-backed native plugin selection. */
export interface PluginSelectionV1 extends JsonObject {
  /** Agent-native qualified identity, such as `stripe@claude-plugins-official`. */
  plugin: string;
  /** GitHub owner/repository whose current default-branch entry is installed. */
  marketplace: string;
}

export interface PluginSetupWithV1 extends JsonObject {
  /** Adapter ID to native selection. Only the selected branch is realized. */
  agents: Record<string, PluginSelectionV1>;
}

export interface PluginSetupStepV1 extends SetupStepV1<PluginSetupWithV1> {
  uses: 'forge/plugin';
  with: PluginSetupWithV1;
}

/** Closed union for consumers which intentionally handle only package built-ins. */
export type BuiltInSetupStepV1 =
  | WriteSetupStepV1
  | CommandSetupStepV1
  | PluginSetupStepV1;

export interface FilesystemCheckV1 {
  description?: string;
  file: string;
  exists: boolean;
  contains?: string;
}

export interface ChecksV1 {
  files_created?: string[];
  file_checks?: FilesystemCheckV1[];
}

/**
 * The benchmark case defines what is evaluated, never which agent runs it.
 * Prompt fields intentionally preserve the imported case semantics.
 */
export interface EvalCaseV1 {
  id: CaseId;
  display_name?: string;
  task?: string;
  initial_prompt?: string;
  context?: string;
  execution_mode: 'multi_turn' | 'one_shot';
  max_turns?: number;
  setup: SetupStepV1[];
  judging_criteria: string[];
  checks?: ChecksV1;
  example_answer?: string;
}

export interface ModelRefV1 {
  provider: string;
  model: string;
}

export interface AgentSelectionV1 extends ModelRefV1 {
  adapter: string;
  /** Codex hook review: native by default; automation permits all enabled hooks. */
  hook_trust?: 'native' | 'automation';
}

export interface TreatmentV1 {
  setup: SetupStepV1[];
}

export interface DockerResourcesV1 {
  memory_bytes: number;
  cpu_count: number;
  process_count: number;
}

export interface ForgeDockerRuntimeV1 {
  adapter: 'docker';
  image: {kind: 'forge'};
  platform: 'linux/amd64' | 'linux/arm64';
  resources: DockerResourcesV1;
}

/** Docker authoring form; `native` is materialized before a run plan exists. */
export interface ForgeDockerRuntimeConfigV1 {
  adapter: 'docker';
  image: {kind: 'forge'};
  platform: ForgeDockerRuntimeV1['platform'] | 'native';
  resources: DockerResourcesV1;
}

/** Explicit, fully materialized configuration for a host-supplied runtime. */
export interface ForgeExternalRuntimeV1 {
  /** Namespaced adapter identity. Built-in Docker identities are reserved. */
  adapter: string;
  platform: 'linux/amd64' | 'linux/arm64';
  /** Public, bounded JSON only; credentials remain composition capabilities. */
  config: JsonObject;
}

export type ForgeRuntimeV1 = ForgeDockerRuntimeV1 | ForgeExternalRuntimeV1;
export type ForgeRuntimeConfigV1 =
  | ForgeDockerRuntimeConfigV1
  | ForgeExternalRuntimeV1;

/** One authored Cartesian product; selections never cross group boundaries. */
export interface ExperimentMatrixGroupV1 {
  /** Manifest-listed case YAML paths, relative to the dataset root. */
  cases: DatasetRelativePath[];
  treatments: TreatmentId[];
  agents: AgentSelectionV1[];
}

export interface FlatExperimentMatrixV1 extends ExperimentMatrixGroupV1 {
  groups?: never;
  /** Number of independent samples; selections use a zero-based index. */
  repetitions: number;
  /** Experiment run retry policy; a retry does not change the run selection. */
  retries: number;
}

export interface GroupedExperimentMatrixV1 {
  groups: ExperimentMatrixGroupV1[];
  cases?: never;
  treatments?: never;
  agents?: never;
  /** Number of independent samples for every group. */
  repetitions: number;
  /** Experiment run retry policy; a retry does not change the run selection. */
  retries: number;
}

export type ExperimentMatrixV1 =
  | FlatExperimentMatrixV1
  | GroupedExperimentMatrixV1;

export interface ExperimentConfigV1 {
  id: string;
  version: string;
  dataset: DatasetIdentityV1 & {
    manifest_sha256: Sha256Digest;
    /** CLI dataset location, relative to the experiment file; not run semantics. */
    path?: string;
  };
  /** Required only when the experiment uses host-supplied setup actions. */
  forge?: {action_bundles: SetupActionBundleReferenceV1[]};
  runtime: ForgeRuntimeConfigV1;
  models: {
    role_player?: ModelRefV1;
    judge?: ModelRefV1;
  };
  treatments: Record<TreatmentId, TreatmentV1>;
  matrix: ExperimentMatrixV1;
  limits: {
    run_timeout_ms: number;
  };
}

export interface LoadedEvalCaseV1 {
  definition: EvalCaseV1;
  path: string;
}

export interface LoadedDatasetV1 {
  root: string;
  manifestPath: string;
  manifestRaw: string;
  manifestSha256: Sha256Digest;
  manifest: DatasetManifestV1;
  cases: ReadonlyMap<CaseId, LoadedEvalCaseV1>;
}

export interface LoadedExperimentConfigV1 {
  path: string;
  root: string;
  raw: string;
  config: ExperimentConfigV1;
}

export interface RunSelection {
  case_id: CaseId;
  treatment: TreatmentId;
  agent: AgentSelectionV1;
  /** Zero-based sample index, bounded by matrix.repetitions. */
  repetition: number;
}

export type InitialPromptSourceV1 =
  | 'case.task'
  | 'case.initial_prompt';

export interface ResolvedRunPlanV1 {
  selection: RunSelection;
  provenance: {
    dataset: DatasetIdentityV1 & {manifest_sha256: Sha256Digest};
    experiment: {
      id: string;
      version: string;
    };
    case: {
      id: CaseId;
      path: DatasetRelativePath;
    };
    forge: ForgeBuildIdentity & {
      action_bundles?: SetupActionBundleReferenceV1[];
    };
  };
  case: EvalCaseV1;
  treatment: {id: TreatmentId; setup: SetupStepV1[]};
  /** Invariant case setup followed by the selected treatment setup. */
  setup: SetupStepV1[];
  interaction: {
    mode: 'multi_turn' | 'one_shot';
    task?: string;
    context?: string;
    initial_prompt?: string;
    initial_prompt_source: InitialPromptSourceV1;
    effective_prompt: string;
    max_turns: number;
  };
  evaluation: {
    judging_criteria: string[];
    checks?: ChecksV1;
    example_answer?: string;
    judge?: ModelRefV1;
  };
  role_player?: ModelRefV1;
  agent: AgentSelectionV1;
  runtime: ForgeRuntimeV1;
  limits: {run_timeout_ms: number};
}
