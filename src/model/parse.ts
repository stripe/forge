import {parseDocument} from 'yaml';
import {z} from 'zod';

import {
  BenchmarkModelError,
  type BenchmarkModelErrorCode,
} from './errors.js';
import {isSha256Digest, isSha256Hex} from './hashes.js';
import {
  isSafeActionIdentifier,
  isSafeCaseId,
  isSafeDatasetRelativePath,
  isSafeMetadata,
  isSafeSimpleIdentifier,
  isSafeVersion,
  isSafeWorkspaceRelativePath,
} from './paths.js';
import {
  BENCHMARK_SCHEMA_VERSION,
  DEFAULT_DOCKER_CPU_COUNT,
  DEFAULT_DOCKER_MEMORY_BYTES,
  DEFAULT_DOCKER_PROCESS_COUNT,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUN_TIMEOUT_MS,
  type ExperimentConfigV1,
  type DatasetManifestV1,
  type EvalCaseV1,
  type JsonValue,
  type ResolvedRunPlanV1,
  type RunSelection,
  type SetupStepV1,
} from './types.js';

export const MAX_BENCHMARK_YAML_BYTES = 1024 * 1024;
export const MAX_DATASET_MANIFEST_BYTES = 4 * 1024 * 1024;

const MAX_GRAPH_NODES = 20_000;
const MAX_GRAPH_DEPTH = 64;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SETUP_STEPS = 1_000;
const MAX_RESOLVED_SETUP_STEPS = MAX_SETUP_STEPS * 2;
const MAX_COMMAND_ARGUMENTS = 256;
const MAX_CHECK_REGEX_BYTES = 1_024;
const MAX_SUCCESS_GUIDELINE_CHARACTERS = 64 * 1024;

const FiniteNumberSchema = z.number().finite();
const PositiveIntegerSchema = FiniteNumberSchema.int().safe().positive();
const NonnegativeIntegerSchema = FiniteNumberSchema.int().safe().nonnegative();
const TrimmedTextSchema = z.string().trim().min(1).refine(isBoundedText);
const SuccessGuidelineSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SUCCESS_GUIDELINE_CHARACTERS)
  .refine(isBoundedText);
const MetadataSchema = z.string().trim().min(1).refine(isSafeMetadata);
const SimpleIdentifierSchema = z
  .string()
  .refine(isSafeSimpleIdentifier, 'must be a safe identifier');
const VersionSchema = z
  .string()
  .refine(isSafeVersion, 'must be a safe version');
const CaseIdSchema = z
  .string()
  .refine(isSafeCaseId, 'must be a canonical dataset-relative case ID');
const DatasetPathSchema = z
  .string()
  .refine(
    isSafeDatasetRelativePath,
    'must be a canonical dataset-relative POSIX path',
  );
const WorkspacePathSchema = z
  .string()
  .refine(
    isSafeWorkspaceRelativePath,
    'must be a canonical workspace-relative POSIX path',
  );
const WorkspaceDirectorySchema = z
  .string()
  .refine(
    (value) => isSafeWorkspaceRelativePath(value, {allowRoot: true}),
    'must be a canonical workspace-relative POSIX directory',
  );

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    FiniteNumberSchema,
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema).superRefine(rejectUnsafeObjectKeys),
  ]),
);
const JsonObjectSchema = z
  .record(z.string(), JsonValueSchema)
  .superRefine(rejectUnsafeObjectKeys);

const WriteSetupWithSchema = z
  .object({
    target: WorkspacePathSchema,
    source: z.union([
      z.object({content: z.string().refine(isBoundedText)}).strict(),
      z.object({dataset_path: DatasetPathSchema}).strict(),
    ]),
  })
  .strict();

const CommandSetupWithSchema = z
  .object({
    argv: z
      .array(z.string().min(1).refine(isBoundedText))
      .min(1)
      .max(MAX_COMMAND_ARGUMENTS),
    cwd: WorkspaceDirectorySchema.optional(),
    timeout_ms: PositiveIntegerSchema.max(60 * 60 * 1000).optional(),
  })
  .strict();

const SetupStepEnvelopeSchema = z
  .object({
    uses: z.string(),
    with: JsonObjectSchema,
  })
  .strict()
  .superRefine((step, context) => {
    if (step.uses === 'forge/write@1') {
      addNestedIssues(WriteSetupWithSchema.safeParse(step.with), context, [
        'with',
      ]);
      return;
    }
    if (step.uses === 'forge/command@1') {
      addNestedIssues(CommandSetupWithSchema.safeParse(step.with), context, [
        'with',
      ]);
      return;
    }
    if (!isSafeActionIdentifier(step.uses)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uses'],
        message: 'uses must be a namespaced, positive-version action ID',
      });
      return;
    }
    const firstPartyNamespace = ['forge', 'stripe'].find((namespace) =>
      step.uses.startsWith(`${namespace}/`),
    );
    if (firstPartyNamespace !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uses'],
        message: `unknown actions in the reserved ${firstPartyNamespace} namespace are invalid`,
      });
    }
  });

const FilesystemCheckSchema = z
  .object({
    description: TrimmedTextSchema.optional(),
    file: WorkspacePathSchema,
    exists: z.boolean().default(true),
    contains: z
      .string()
      .refine(
        (pattern) => Buffer.byteLength(pattern, 'utf8') <= MAX_CHECK_REGEX_BYTES,
        `contains must not exceed ${MAX_CHECK_REGEX_BYTES} bytes`,
      )
      .superRefine((pattern, context) => {
        try {
          RegExp(pattern);
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'contains must be a valid regular expression',
          });
        }
      })
      .optional(),
  })
  .strict();

const ChecksSchema = z
  .object({
    files_created: z.array(WorkspacePathSchema).max(1_000).optional(),
    file_checks: z.array(FilesystemCheckSchema).max(1_000).optional(),
  })
  .strict();

const EvalCaseSchema = z
  .object({
    schema_version: z.literal(BENCHMARK_SCHEMA_VERSION),
    id: CaseIdSchema,
    display_name: TrimmedTextSchema.optional(),
    task: TrimmedTextSchema.optional(),
    initial_prompt: TrimmedTextSchema.optional(),
    context: z.string().refine(isBoundedText).optional(),
    execution_mode: z.enum(['multi_turn', 'one_shot']).default('multi_turn'),
    max_turns: PositiveIntegerSchema.max(100).optional(),
    setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS).default([]),
    success_guidelines: z
      .array(SuccessGuidelineSchema)
      .max(1_000)
      .default([]),
    checks: ChecksSchema.optional(),
    example_answer: z.string().refine(isBoundedText).optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const hasTask = definition.task !== undefined;
    const hasInitialPrompt = definition.initial_prompt !== undefined;
    if (definition.execution_mode === 'multi_turn' && !hasTask) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'task is required in multi_turn mode',
      });
    }
    if (definition.execution_mode === 'one_shot') {
      if (!hasTask && !hasInitialPrompt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['initial_prompt'],
          message: 'one_shot requires task or initial_prompt',
        });
      }
      if (hasTask && hasInitialPrompt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['initial_prompt'],
          message: 'one_shot cannot combine task and initial_prompt',
        });
      }
      if (definition.context !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['context'],
          message: 'context is only supported in multi_turn mode',
        });
      }
    }
  });

const DatasetIdentitySchema = z
  .object({
    id: SimpleIdentifierSchema,
    version: VersionSchema,
  })
  .strict();

const ManifestCaseSchema = z
  .object({
    id: CaseIdSchema,
    path: DatasetPathSchema.refine(
      (value) => value.startsWith('cases/') && value.endsWith('.yaml'),
      'case definitions must be YAML files below cases/',
    ),
  })
  .strict();

const ManifestFileSchema = z
  .object({
    path: DatasetPathSchema,
    size: NonnegativeIntegerSchema,
    sha256: z.string().refine(isSha256Hex, 'must be lowercase SHA-256 hex'),
  })
  .strict();

const DatasetManifestSchema = z
  .object({
    schema_version: z.literal(BENCHMARK_SCHEMA_VERSION),
    dataset: DatasetIdentitySchema,
    cases: z.array(ManifestCaseSchema).min(1).max(10_000),
    files: z.array(ManifestFileSchema).min(1).max(50_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.cases.map(({id}) => id),
      context,
      ['cases'],
      'id',
    );
    addDuplicateIssues(
      manifest.cases.map(({path}) => path),
      context,
      ['cases'],
      'path',
    );
    addDuplicateIssues(
      manifest.files.map(({path}) => path),
      context,
      ['files'],
      'path',
    );
    const files = new Set(manifest.files.map(({path}) => path));
    for (const [index, entry] of manifest.cases.entries()) {
      if (!files.has(entry.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cases', index, 'path'],
          message: 'case path must be present in the file manifest',
        });
      }
    }
  });

const ModelRefSchema = z
  .object({
    provider: SimpleIdentifierSchema,
    model: MetadataSchema,
  })
  .strict();

const AgentSelectionSchema = ModelRefSchema.extend({
  adapter: SimpleIdentifierSchema,
}).strict();

const RunSelectionSchema = z
  .object({
    case_id: CaseIdSchema,
    treatment: SimpleIdentifierSchema,
    agent: AgentSelectionSchema,
    repetition: NonnegativeIntegerSchema,
  })
  .strict();

const TreatmentSchema = z
  .object({
    setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS).default([]),
  })
  .strict();

const RuntimeSchema = z
  .object({
    adapter: z.literal('docker'),
    image: z.object({kind: z.literal('forge')}).strict(),
    platform: z.enum(['linux/amd64', 'linux/arm64']),
    resources: z
      .object({
        memory_bytes: PositiveIntegerSchema.max(1024 ** 4).default(
          DEFAULT_DOCKER_MEMORY_BYTES,
        ),
        cpu_count: FiniteNumberSchema.positive()
          .max(1_024)
          .default(DEFAULT_DOCKER_CPU_COUNT),
        process_count: PositiveIntegerSchema.max(1_000_000).default(
          DEFAULT_DOCKER_PROCESS_COUNT,
        ),
      })
      .strict()
      .default({}),
  })
  .strict();

const ExperimentConfigSchema = z
  .object({
    schema_version: z.literal(BENCHMARK_SCHEMA_VERSION),
    id: CaseIdSchema,
    version: VersionSchema,
    dataset: DatasetIdentitySchema.extend({
      manifest_sha256: z
        .string()
        .refine(isSha256Digest, 'must be a sha256: digest'),
    }).strict(),
    forge: z.object({version: VersionSchema}).strict(),
    runtime: RuntimeSchema,
    models: z
      .object({
        role_player: ModelRefSchema.optional(),
        judge: ModelRefSchema.optional(),
      })
      .strict()
      .default({}),
    treatments: z.record(z.string(), TreatmentSchema).default({}),
    matrix: z
      .object({
        cases: z.array(CaseIdSchema).min(1).max(10_000),
        treatments: z.array(z.string()).min(1).max(1_000),
        agents: z.array(AgentSelectionSchema).min(1).max(1_000),
        repetitions: PositiveIntegerSchema.max(10_000).default(1),
        retries: NonnegativeIntegerSchema.max(100).default(0),
      })
      .strict(),
    limits: z
      .object({
        run_timeout_ms: PositiveIntegerSchema.max(24 * 60 * 60 * 1000).default(
          DEFAULT_RUN_TIMEOUT_MS,
        ),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, context) => {
    for (const treatment of Object.keys(config.treatments)) {
      if (!isSafeSimpleIdentifier(treatment)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['treatments'],
          message: 'treatment names must be safe identifiers',
        });
      }
    }
    const baseline = config.treatments.baseline;
    if (baseline !== undefined && baseline.setup.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['treatments', 'baseline', 'setup'],
        message:
          'baseline setup must be empty; invariant setup belongs to the case',
      });
    }
    addDuplicateIssues(config.matrix.cases, context, ['matrix', 'cases']);
    addDuplicateIssues(
      config.matrix.treatments,
      context,
      ['matrix', 'treatments'],
    );
    addDuplicateIssues(
      config.matrix.agents.map(agentKey),
      context,
      ['matrix', 'agents'],
    );
    const treatmentNames = new Set([
      'baseline',
      ...Object.keys(config.treatments),
    ]);
    for (const [index, treatment] of config.matrix.treatments.entries()) {
      if (!isSafeSimpleIdentifier(treatment)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['matrix', 'treatments', index],
          message: 'treatment names must be safe identifiers',
        });
      } else if (!treatmentNames.has(treatment)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['matrix', 'treatments', index],
          message: 'matrix references an undefined treatment',
        });
      }
    }
  });

/** Resolved plans require every defaulted authoring field to be materialized. */
const MaterializedEvalCaseSchema = z.intersection(
  z
    .object({
      schema_version: z.literal(BENCHMARK_SCHEMA_VERSION),
      id: CaseIdSchema,
      execution_mode: z.enum(['multi_turn', 'one_shot']),
      setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS),
      success_guidelines: z.array(SuccessGuidelineSchema).max(1_000),
    })
    .passthrough(),
  EvalCaseSchema,
);

const ResolvedRuntimeSchema = z
  .object({
    adapter: z.literal('docker'),
    image: z.object({kind: z.literal('forge')}).strict(),
    platform: z.enum(['linux/amd64', 'linux/arm64']),
    resources: z
      .object({
        memory_bytes: PositiveIntegerSchema.max(1024 ** 4),
        cpu_count: FiniteNumberSchema.positive().max(1_024),
        process_count: PositiveIntegerSchema.max(1_000_000),
      })
      .strict(),
  })
  .strict();

const ResolvedRunPlanSchema = z
  .object({
    schema_version: z.literal(BENCHMARK_SCHEMA_VERSION),
    selection: RunSelectionSchema,
    provenance: z
      .object({
        dataset: DatasetIdentitySchema.extend({
          manifest_sha256: z
            .string()
            .refine(isSha256Digest, 'must be a sha256: digest'),
        }).strict(),
        experiment: z
          .object({
            id: CaseIdSchema,
            version: VersionSchema,
            sha256: z
              .string()
              .refine(isSha256Digest, 'must be a sha256: digest'),
          })
          .strict(),
        case: z
          .object({
            id: CaseIdSchema,
            path: DatasetPathSchema,
            sha256: z
              .string()
              .refine(isSha256Digest, 'must be a sha256: digest'),
          })
          .strict(),
        forge: z.object({version: VersionSchema}).strict(),
      })
      .strict(),
    case: MaterializedEvalCaseSchema,
    treatment: z
      .object({
        id: SimpleIdentifierSchema,
        setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS),
      })
      .strict(),
    setup: z
      .array(SetupStepEnvelopeSchema)
      .max(MAX_RESOLVED_SETUP_STEPS),
    interaction: z
      .object({
        mode: z.enum(['multi_turn', 'one_shot']),
        task: TrimmedTextSchema.optional(),
        context: z.string().refine(isBoundedText).optional(),
        initial_prompt: TrimmedTextSchema.optional(),
        initial_prompt_source: z.enum(['case.task', 'case.initial_prompt']),
        effective_prompt: TrimmedTextSchema,
        max_turns: PositiveIntegerSchema.max(100),
      })
      .strict(),
    evaluation: z
      .object({
        success_guidelines: z.array(SuccessGuidelineSchema).max(1_000),
        checks: ChecksSchema.optional(),
        example_answer: z.string().refine(isBoundedText).optional(),
        judge: ModelRefSchema.optional(),
      })
      .strict(),
    role_player: ModelRefSchema.optional(),
    agent: AgentSelectionSchema,
    runtime: ResolvedRuntimeSchema,
    limits: z
      .object({
        run_timeout_ms: PositiveIntegerSchema.max(24 * 60 * 60 * 1000),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (
      plan.selection.case_id !== plan.case.id ||
      plan.provenance.case.id !== plan.case.id
    ) {
      addPlanIssue(
        context,
        ['selection', 'case_id'],
        'selection and provenance case IDs must match case.id',
      );
    }
    if (plan.selection.treatment !== plan.treatment.id) {
      addPlanIssue(
        context,
        ['selection', 'treatment'],
        'selection treatment must match treatment.id',
      );
    }
    if (!jsonValuesEqual(plan.selection.agent, plan.agent)) {
      addPlanIssue(
        context,
        ['selection', 'agent'],
        'selection agent must match the resolved agent',
      );
    }

    const expectedSetup = [...plan.case.setup, ...plan.treatment.setup];
    if (!jsonValuesEqual(plan.setup, expectedSetup)) {
      addPlanIssue(
        context,
        ['setup'],
        'resolved setup must be case setup followed by treatment setup',
      );
    }

    if (plan.interaction.mode !== plan.case.execution_mode) {
      addPlanIssue(
        context,
        ['interaction', 'mode'],
        'interaction mode must match case.execution_mode',
      );
    }
    for (const field of ['task', 'context', 'initial_prompt'] as const) {
      if (plan.interaction[field] !== plan.case[field]) {
        addPlanIssue(
          context,
          ['interaction', field],
          `interaction.${field} must match case.${field}`,
        );
      }
    }
    const expectedPromptSource =
      plan.case.initial_prompt === undefined
        ? ('case.task' as const)
        : ('case.initial_prompt' as const);
    const expectedPrompt = plan.case.initial_prompt ?? plan.case.task;
    if (plan.interaction.initial_prompt_source !== expectedPromptSource) {
      addPlanIssue(
        context,
        ['interaction', 'initial_prompt_source'],
        'initial prompt source does not match the selected case prompt',
      );
    }
    if (plan.interaction.effective_prompt !== expectedPrompt) {
      addPlanIssue(
        context,
        ['interaction', 'effective_prompt'],
        'effective prompt does not match the selected case prompt',
      );
    }
    const expectedMaxTurns =
      plan.case.execution_mode === 'one_shot'
        ? 1
        : (plan.case.max_turns ?? DEFAULT_MAX_TURNS);
    if (plan.interaction.max_turns !== expectedMaxTurns) {
      addPlanIssue(
        context,
        ['interaction', 'max_turns'],
        'interaction max_turns does not match the case and Forge defaults',
      );
    }

    if (
      !jsonValuesEqual(
        plan.evaluation.success_guidelines,
        plan.case.success_guidelines,
      )
    ) {
      addPlanIssue(
        context,
        ['evaluation', 'success_guidelines'],
        'evaluation guidelines must match the selected case',
      );
    }
    if (!jsonValuesEqual(plan.evaluation.checks, plan.case.checks)) {
      addPlanIssue(
        context,
        ['evaluation', 'checks'],
        'evaluation checks must match the selected case',
      );
    }
    if (plan.evaluation.example_answer !== plan.case.example_answer) {
      addPlanIssue(
        context,
        ['evaluation', 'example_answer'],
        'evaluation example_answer must match the selected case',
      );
    }
    if (
      plan.case.execution_mode === 'multi_turn' &&
      plan.role_player === undefined
    ) {
      addPlanIssue(
        context,
        ['role_player'],
        'multi_turn plans require a role_player model',
      );
    }
    if (
      plan.case.execution_mode === 'one_shot' &&
      plan.role_player !== undefined
    ) {
      addPlanIssue(
        context,
        ['role_player'],
        'one_shot plans cannot include a role_player model',
      );
    }
    if (
      plan.case.success_guidelines.length > 0 &&
      plan.evaluation.judge === undefined
    ) {
      addPlanIssue(
        context,
        ['evaluation', 'judge'],
        'plans with success guidelines require a judge model',
      );
    }
    if (
      plan.case.success_guidelines.length === 0 &&
      plan.evaluation.judge !== undefined
    ) {
      addPlanIssue(
        context,
        ['evaluation', 'judge'],
        'plans without success guidelines cannot include a judge model',
      );
    }
  });

export function parseDatasetManifest(value: unknown): DatasetManifestV1 {
  return parseWithSchema(
    DatasetManifestSchema,
    value,
    'invalid_manifest',
    'dataset manifest',
  ) as DatasetManifestV1;
}

export function parseDatasetManifestJson(source: string): DatasetManifestV1 {
  assertSourceSize(source, MAX_DATASET_MANIFEST_BYTES, 'dataset manifest');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new BenchmarkModelError(
      'invalid_manifest',
      'Dataset manifest is not valid JSON.',
      {cause: error},
    );
  }
  assertBoundedDataGraph(value, 'dataset manifest');
  return parseDatasetManifest(value);
}

export function parseEvalCase(value: unknown): EvalCaseV1 {
  return parseWithSchema(
    EvalCaseSchema,
    value,
    'invalid_case',
    'eval case',
  ) as EvalCaseV1;
}

export function parseEvalCaseYaml(source: string): EvalCaseV1 {
  return parseEvalCase(parseYaml(source, 'eval case'));
}

export function parseExperimentConfig(value: unknown): ExperimentConfigV1 {
  const parsed = parseWithSchema(
    ExperimentConfigSchema,
    value,
    'invalid_experiment_config',
    'experiment config',
  ) as ExperimentConfigV1;
  return {
    ...parsed,
    treatments: {
      baseline: {setup: []},
      ...parsed.treatments,
    },
  };
}

export function parseExperimentConfigYaml(source: string): ExperimentConfigV1 {
  return parseExperimentConfig(parseYaml(source, 'experiment config'));
}

/** Parse an untrusted CLI, worker, or API selection before matrix resolution. */
export function parseRunSelection(value: unknown): RunSelection {
  return parseWithSchema(
    RunSelectionSchema,
    value,
    'invalid_experiment_config',
    'run selection',
  ) as RunSelection;
}

/**
 * Validate a planner output at a process or package trust boundary.
 *
 * In addition to strict field validation, this verifies that every duplicated
 * execution field is the deterministic projection of the selected case,
 * treatment, and agent. Callers therefore cannot change score-affecting input
 * by editing only one copy inside a serialized plan.
 */
export function parseResolvedRunPlan(value: unknown): ResolvedRunPlanV1 {
  return parseWithSchema(
    ResolvedRunPlanSchema,
    value,
    'invalid_plan',
    'resolved run plan',
  ) as ResolvedRunPlanV1;
}

function parseYaml(source: string, label: string): unknown {
  assertSourceSize(source, MAX_BENCHMARK_YAML_BYTES, label);
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      schema: 'core',
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error('YAML parser reported an issue.');
    }
    const value: unknown = document.toJS({maxAliasCount: 100});
    assertBoundedDataGraph(value, label);
    return value;
  } catch (error) {
    if (error instanceof BenchmarkModelError) throw error;
    throw new BenchmarkModelError('invalid_yaml', `Invalid ${label} YAML.`, {
      cause: error,
    });
  }
}

function parseWithSchema(
  schema: z.ZodTypeAny,
  value: unknown,
  code:
    | 'invalid_manifest'
    | 'invalid_case'
    | 'invalid_experiment_config'
    | 'invalid_plan',
  label: string,
): unknown {
  assertBoundedDataGraph(value, label, code);
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new BenchmarkModelError(
    code,
    `Invalid ${label}${first ? `: ${first.message}` : '.'}`,
    {cause: result.error},
  );
}

function addPlanIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({code: z.ZodIssueCode.custom, path, message});
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonValuesEqual(entry, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort(compareCodeUnits);
  const rightKeys = Object.keys(rightRecord).sort(compareCodeUnits);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSourceSize(source: string, maximum: number, label: string): void {
  if (Buffer.byteLength(source, 'utf8') > maximum) {
    throw new BenchmarkModelError(
      label === 'dataset manifest' ? 'invalid_manifest' : 'invalid_yaml',
      `${capitalize(label)} exceeds the ${maximum}-byte limit.`,
    );
  }
}

function assertBoundedDataGraph(
  value: unknown,
  label: string,
  code: BenchmarkModelErrorCode =
    label === 'dataset manifest' ? 'invalid_manifest' : 'invalid_yaml',
): void {
  type Frame =
    | {kind: 'enter'; value: unknown; depth: number}
    | {kind: 'leave'; value: object};
  const pending: Frame[] = [
    {kind: 'enter', value, depth: 0},
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === 'leave') {
      ancestors.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_GRAPH_NODES || frame.depth > MAX_GRAPH_DEPTH) {
      throw new BenchmarkModelError(
        code,
        `${capitalize(label)} exceeds structural limits.`,
      );
    }
    if (frame.value === null || typeof frame.value !== 'object') continue;
    if (ancestors.has(frame.value)) {
      throw new BenchmarkModelError(
        code,
        `${capitalize(label)} contains a cyclic value.`,
      );
    }
    const entries = Array.isArray(frame.value)
      ? frame.value
      : Object.values(frame.value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_ENTRIES) {
      throw new BenchmarkModelError(
        code,
        `${capitalize(label)} exceeds collection limits.`,
      );
    }
    ancestors.add(frame.value);
    pending.push({kind: 'leave', value: frame.value});
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({
        kind: 'enter',
        value: entries[index],
        depth: frame.depth + 1,
      });
    }
  }
}

function addNestedIssues(
  result: z.SafeParseReturnType<unknown, unknown>,
  context: z.RefinementCtx,
  prefix: (string | number)[],
): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    context.addIssue({...issue, path: [...prefix, ...issue.path]});
  }
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  parent: (string | number)[],
  field?: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...parent, index, ...(field === undefined ? [] : [field])],
        message: `${field ?? parent.at(-1) ?? 'values'} values must be unique`,
      });
    }
    seen.add(value);
  }
}

function rejectUnsafeObjectKeys(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reserved object keys are not allowed',
      });
    }
  }
}

function agentKey(agent: {
  adapter: string;
  provider: string;
  model: string;
}): string {
  return JSON.stringify([agent.adapter, agent.provider, agent.model]);
}

function isBoundedText(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES &&
    !value.includes('\0')
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Narrow a parsed envelope to the public setup union without exporting Zod. */
export function parseSetupStep(value: unknown): SetupStepV1 {
  return parseWithSchema(
    SetupStepEnvelopeSchema,
    value,
    'invalid_case',
    'setup step',
  ) as SetupStepV1;
}
