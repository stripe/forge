export type { PluginMcpServerId } from './plugins.ts';

import type { ForgeBuildIdentity } from '../version.ts';

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

/** One case definition file and the identity it declares. */
export interface DatasetManifestCaseV1 {
  id: CaseId;
  version: string;
  path: DatasetRelativePath;
}

export interface DatasetManifestV1 {
  dataset: DatasetIdentityV1;
  cases: DatasetManifestCaseV1[];
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
  source: { content: string } | { dataset_path: DatasetRelativePath };
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

export interface CredentialsSetupWithV1 extends JsonObject {
  /** Agent environment names; the host resolves each opaque env:<NAME> reference. */
  env: string[];
}

export interface CredentialsSetupStepV1
  extends SetupStepV1<CredentialsSetupWithV1> {
  uses: 'forge/credentials';
  with: CredentialsSetupWithV1;
}

/** Native distribution supplied to an agent's plugin installer. */
export interface PluginSelectionV1 extends JsonObject {
  /** Agent-native qualified identity, such as `stripe@claude-plugins-official`. */
  plugin: string;
  /** GitHub owner/repository whose current default-branch entry is installed. */
  marketplace: string;
}

export interface PluginSetupWithV1 extends JsonObject {
  /** Forge resolves the compatible native distribution for the selected agent. */
  plugin: 'stripe';
}

export interface PluginSetupStepV1 extends SetupStepV1<PluginSetupWithV1> {
  uses: 'forge/plugin';
  with: PluginSetupWithV1;
}

/** Closed union for consumers which intentionally handle only package built-ins. */
export type BuiltInSetupStepV1 =
  | WriteSetupStepV1
  | CommandSetupStepV1
  | CredentialsSetupStepV1
  | PluginSetupStepV1;

/**
 * Metadata for tool call checks. `label` is a repeatable category like a
 * criterion label. An omitted level is SHOULD; OPTIONAL results are recorded
 * but do not affect the score or status.
 */
export interface CheckMetadataV1 {
  label?: string;
  requirement_level?: RequirementLevelV1;
}

export interface FilesystemCheckV1 {
  description?: string;
  file: string;
  exists: boolean;
  contains?: string;
}

/** Scalar or nested partial-match values for tool call arguments. */
export interface ToolCallCheckInputsV1 {
  [key: string]: JsonPrimitive | ToolCallCheckInputsV1;
}

/**
 * Asserts on tool calls in the root ATIF trajectory. Subagent trajectories are
 * not searched. `tool` is a regular expression matched against the whole name.
 */
export interface ToolCallCheckV1 extends CheckMetadataV1 {
  tool: string;
  inputs?: ToolCallCheckInputsV1;
}

export interface ChecksV1 {
  files_created?: string[];
  file_checks?: FilesystemCheckV1[];
  tool_call_checks?: ToolCallCheckV1[];
}

export type RequirementLevelV1 = (typeof REQUIREMENT_LEVELS)[number];

export const REQUIREMENT_LEVELS = Object.freeze([
  'MUST',
  'SHOULD',
  'OPTIONAL',
] as const);

export const DEFAULT_REQUIREMENT_LEVEL = 'SHOULD' as const;

/** Authored shorthand and objects; parsing materializes the requirement level. */
export type JudgingCriterionInputV1 =
  | string
  | {
      value: string;
      label?: string;
      requirement_level?: RequirementLevelV1;
    };

/** One assertable criterion with an explicit requirement and scoring policy. */
export interface JudgingCriterionV1 {
  value: string;
  label?: string;
  /** Parsing defaults omitted input to SHOULD; OPTIONAL does not affect scoring. */
  requirement_level: RequirementLevelV1;
}

/**
 * The benchmark case defines what is evaluated, never which agent runs it.
 * Prompt fields intentionally preserve the imported case semantics.
 */
export interface EvalCaseV1 {
  id: CaseId;
  version: string;
  display_name?: string;
  task?: string;
  initial_prompt?: string;
  context?: string;
  execution_mode: 'multi_turn' | 'one_shot';
  max_turns?: number;
  setup: SetupStepV1[];
  judging_criteria: JudgingCriterionV1[];
  interview_questions?: string[];
  checks?: ChecksV1;
  example_answer?: string;
  tags?: Record<string, string>;
}

export interface ModelRefV1 {
  provider: string;
  model: string;
}

export interface AgentSelectionV1 extends ModelRefV1 {
  adapter: string;
  /** Codex hook review: native by default; automation permits all enabled hooks. */
  hook_trust?: 'native' | 'automation';
  /** Explicit model limits and capabilities; required by OpenCode. */
  model_profile?: {
    limit: { context: number; output: number };
    reasoning: boolean;
    temperature: boolean;
    attachment: boolean;
  };
  /** Claude gateway compatibility; omit to retain the native beta behavior. */
  disable_experimental_betas?: true;
}

export interface TreatmentV1 {
  setup: SetupStepV1[];
}

export interface DockerResourcesV1 {
  memory_bytes: number;
  cpu_count: number;
  process_count: number;
}

/** An authored pin selects only a matching explicit host build bundle. */
export type DockerImageV1 =
  | { kind: 'forge' }
  | { kind: 'build'; id: string; sha256: `sha256:${string}` };

export interface ForgeDockerRuntimeV1 {
  adapter: 'docker';
  image: DockerImageV1;
  platform: 'linux/amd64' | 'linux/arm64';
  resources: DockerResourcesV1;
}

/** Docker authoring form; `native` is materialized before a run plan exists. */
export interface ForgeDockerRuntimeConfigV1 {
  adapter: 'docker';
  image: DockerImageV1;
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
interface ExperimentMatrixAxesV1 {
  /** Manifest-listed case YAML paths, relative to the dataset root. */
  cases: DatasetRelativePath[];
  treatments: TreatmentId[];
  agents: AgentSelectionV1[];
}

export interface ExperimentMatrixGroupV1 extends ExperimentMatrixAxesV1 {
  id?: string;
}

export interface FlatExperimentMatrixV1 extends ExperimentMatrixAxesV1 {
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
    /** CLI dataset location, relative to the experiment file; not run semantics. */
    path?: string;
  };
  /** Required only when the experiment uses host-supplied setup actions. */
  forge?: { action_bundles: SetupActionBundleReferenceV1[] };
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
  manifest: DatasetManifestV1;
  cases: ReadonlyMap<CaseId, LoadedEvalCaseV1>;
  /**
   * Payload files and nonempty ancestor directories discovered at load time.
   * Hosts omitting this index own setup-source existence checks.
   */
  inputPaths?: ReadonlySet<DatasetRelativePath>;
}

export interface LoadedExperimentConfigV1 {
  path: string;
  root: string;
  raw: string;
  config: ExperimentConfigV1;
}

export interface RunSelection {
  group_id?: string;
  case_id: CaseId;
  treatment: TreatmentId;
  agent: AgentSelectionV1;
  /** Zero-based sample index, bounded by matrix.repetitions. */
  repetition: number;
}

export type InitialPromptSourceV1 = 'case.task' | 'case.initial_prompt';

export interface ResolvedRunPlanV1 {
  selection: RunSelection;
  provenance: {
    dataset: DatasetIdentityV1;
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
  treatment: { id: TreatmentId; setup: SetupStepV1[] };
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
    judging_criteria: JudgingCriterionV1[];
    checks?: ChecksV1;
    example_answer?: string;
    judge?: ModelRefV1;
  };
  role_player?: ModelRefV1;
  agent: AgentSelectionV1;
  runtime: ForgeRuntimeV1;
  limits: { run_timeout_ms: number };
}
