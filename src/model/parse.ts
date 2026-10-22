import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  defaultSetupActionRegistry,
  type SetupActionDefinition,
  type SetupActionRegistry,
} from '../setup/registry.ts';
import {
  assertCompatibleForgeVersion,
  parseForgeBuildIdentity,
} from '../version.ts';
import { JudgingCriterionSchema } from './criteria.ts';
import { BenchmarkModelError, type BenchmarkModelErrorCode } from './errors.ts';
import { isSha256Digest, isSha256Hex } from './hashes.ts';
import { agentSelectionKey } from './matrix.ts';
import {
  isAuthoredCaseId,
  isCaseDefinitionPath,
  isSafeActionIdentifier,
  isSafeCaseId,
  isSafeDatasetRelativePath,
  isSafeMetadata,
  isSafeSimpleIdentifier,
  isSafeVersion,
  isSafeWorkspaceRelativePath,
} from './paths.ts';
import {
  type DatasetManifestV1,
  DEFAULT_DOCKER_CPU_COUNT,
  DEFAULT_DOCKER_MEMORY_BYTES,
  DEFAULT_DOCKER_PROCESS_COUNT,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUN_TIMEOUT_MS,
  type EvalCaseV1,
  type ExperimentConfigV1,
  type JsonObject,
  type JsonValue,
  type ResolvedRunPlanV1,
  type RunSelection,
  type SetupStepV1,
} from './types.ts';

export const MAX_BENCHMARK_YAML_BYTES = 1024 * 1024;
export const MAX_DATASET_MANIFEST_BYTES = 4 * 1024 * 1024;

const MAX_GRAPH_NODES = 20_000;
const MAX_GRAPH_DEPTH = 64;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SETUP_STEPS = 1_000;
const MAX_RESOLVED_SETUP_STEPS = MAX_SETUP_STEPS * 2;
const MAX_ACTION_BUNDLES = 100;
const MAX_CHECK_REGEX_BYTES = 1_024;

const FiniteNumberSchema = z.number().finite();
const PositiveIntegerSchema = FiniteNumberSchema.int().safe().positive();
const NonnegativeIntegerSchema = FiniteNumberSchema.int().safe().nonnegative();
const TrimmedTextSchema = z.string().trim().min(1).refine(isBoundedText);
const JudgingCriteriaSchema = z
  .array(JudgingCriterionSchema)
  .max(1_000)
  .superRefine((criteria, context) => {
    if (
      criteria.length > 0 &&
      criteria.every((criterion) => criterion.requirement_level === 'OPTIONAL')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one judging criterion must be included in scoring',
      });
    }
  });
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
const AuthoredCaseIdSchema = z
  .string()
  .refine(
    isAuthoredCaseId,
    'case ID must use lowercase slash-separated kebab-case segments',
  );
const DatasetPathSchema = z
  .string()
  .refine(
    isSafeDatasetRelativePath,
    'must be a canonical dataset-relative POSIX path',
  );
const CasePathSchema = DatasetPathSchema.refine(
  isCaseDefinitionPath,
  'case definitions must be case.yaml or <name>.case.yaml files below cases/',
);
const WorkspacePathSchema = z
  .string()
  .refine(
    isSafeWorkspaceRelativePath,
    'must be a canonical workspace-relative POSIX path',
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

const SetupStepEnvelopeSchema = z
  .object({
    uses: z
      .string()
      .refine(
        isSafeActionIdentifier,
        'uses must be a namespaced action ID without a version suffix',
      ),
    with: JsonObjectSchema,
  })
  .strict();

const SetupActionBundleReferenceSchema = z
  .object({
    namespace: SimpleIdentifierSchema,
    version: VersionSchema,
    sha256: z.string().refine(isSha256Digest, 'must be a sha256: digest'),
  })
  .strict();

const ActionBundleReferencesSchema = z
  .array(SetupActionBundleReferenceSchema)
  .min(1)
  .max(MAX_ACTION_BUNDLES)
  .superRefine((references, context) => {
    addDuplicateIssues(
      references.map(({ namespace }) => namespace),
      context,
      [],
      'namespace',
    );
  });

const AuthoredForgeSchema = z
  .object({
    action_bundles: ActionBundleReferencesSchema,
  })
  .strict();

const ForgeProvenanceSchema = z
  .object({
    version: VersionSchema,
    commit_sha: z.string().optional(),
    dirty: z.boolean().optional(),
    action_bundles: ActionBundleReferencesSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      parseForgeBuildIdentity({
        version: value.version,
        ...(value.commit_sha === undefined
          ? {}
          : { commit_sha: value.commit_sha }),
        ...(value.dirty === undefined ? {} : { dirty: value.dirty }),
      });
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid Forge build identity.',
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
        (pattern) =>
          Buffer.byteLength(pattern, 'utf8') <= MAX_CHECK_REGEX_BYTES,
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

const CompatibleEvalCaseSchema = z
  .object({
    id: CaseIdSchema,
    display_name: TrimmedTextSchema.optional(),
    task: TrimmedTextSchema.optional(),
    initial_prompt: TrimmedTextSchema.optional(),
    context: z.string().refine(isBoundedText).optional(),
    execution_mode: z.enum(['multi_turn', 'one_shot']).default('multi_turn'),
    max_turns: PositiveIntegerSchema.max(100).optional(),
    setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS).default([]),
    judging_criteria: JudgingCriteriaSchema.default([]),
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

const EvalCaseSchema = z.intersection(
  CompatibleEvalCaseSchema,
  z.object({ id: AuthoredCaseIdSchema }),
);

const DatasetIdentitySchema = z
  .object({
    id: SimpleIdentifierSchema,
    version: VersionSchema,
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
    dataset: DatasetIdentitySchema,
    cases: z.array(CasePathSchema).min(1).max(10_000),
    files: z.array(ManifestFileSchema).min(1).max(50_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(manifest.cases, context, ['cases'], 'path');
    addDuplicateIssues(
      manifest.files.map(({ path }) => path),
      context,
      ['files'],
      'path',
    );
    const files = new Set(manifest.files.map(({ path }) => path));
    for (const [index, casePath] of manifest.cases.entries()) {
      if (!files.has(casePath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cases', index],
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
  hook_trust: z.enum(['native', 'automation']).optional(),
})
  .strict()
  .superRefine((agent, context) => {
    if (agent.adapter === 'claude-code' && agent.hook_trust !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hook_trust'],
        message: 'hook_trust is not supported by Claude Code',
      });
    }
  });

const RunSelectionSchema = z
  .object({
    group_id: SimpleIdentifierSchema.optional(),
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

const DockerRuntimeSchema = z
  .object({
    adapter: z.literal('docker'),
    image: z.object({ kind: z.literal('forge') }).strict(),
    platform: z.enum(['linux/amd64', 'linux/arm64', 'native']),
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

// Provider-specific semantics are validated by the explicitly supplied runtime
// during pure execution preflight. Parsing and offline verification need no
// private implementation, and never transform this materialized configuration.
const ExternalRuntimeSchema = z
  .object({
    adapter: z
      .string()
      .refine(
        (value) =>
          value.length <= 257 &&
          value !== 'forge/docker' &&
          value.split('/').length === 2 &&
          value.split('/').every(isSafeSimpleIdentifier),
        'must be a namespaced external runtime identifier',
      ),
    platform: z.enum(['linux/amd64', 'linux/arm64']),
    config: z
      .unknown()
      .superRefine((value, context) => {
        try {
          assertBoundedDataGraph(value, 'runtime config', 'invalid_plan');
          assertPlainJsonGraph(value, 'runtime config', 'invalid_plan');
          assertRuntimeConfigBytes(value);
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'Runtime config must be bounded plain JSON without unsafe object keys.',
          });
        }
      })
      .pipe(JsonObjectSchema),
  })
  .strict();

const RuntimeSchema = z.union([DockerRuntimeSchema, ExternalRuntimeSchema]);

function assertRuntimeConfigBytes(value: unknown): void {
  // Count every serialized occurrence, including repeated object references.
  // Bound raw strings before escaping them and before Zod clones the graph.
  const pending: unknown[] = [value];
  let bytes = 0;
  const textBytes = (text: string): number => {
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
      throw new TypeError('Oversized config.');
    return Buffer.byteLength(JSON.stringify(text), 'utf8');
  };
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      bytes += textBytes(current);
    } else if (current !== null && typeof current === 'object') {
      const keys = Object.keys(current);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        if (
          key === '__proto__' ||
          key === 'prototype' ||
          key === 'constructor'
        ) {
          throw new TypeError('Unsafe config key.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!('value' in descriptor))
          throw new TypeError('Config accessors are unsupported.');
        if (!Array.isArray(current)) bytes += textBytes(key) + 1;
        pending.push(descriptor.value);
      }
    } else {
      bytes += JSON.stringify(current)!.length;
    }
    if (bytes > MAX_TEXT_BYTES) throw new TypeError('Oversized config.');
  }
}

const ExperimentMatrixAxesSchema = z
  .object({
    cases: z.array(CasePathSchema).min(1).max(10_000),
    treatments: z.array(z.string()).min(1).max(1_000),
    agents: z.array(AgentSelectionSchema).min(1).max(1_000),
  })
  .strict();

const ExperimentMatrixGroupSchema = ExperimentMatrixAxesSchema.extend({
  id: SimpleIdentifierSchema.optional(),
}).strict();

const MatrixRunPolicySchema = {
  repetitions: PositiveIntegerSchema.max(10_000).default(1),
  retries: NonnegativeIntegerSchema.max(100).default(0),
};

const FlatExperimentMatrixSchema = ExperimentMatrixAxesSchema.extend(
  MatrixRunPolicySchema,
).strict();
const GroupedExperimentMatrixSchema = z
  .object({
    groups: z.array(ExperimentMatrixGroupSchema).min(1).max(1_000),
    ...MatrixRunPolicySchema,
  })
  .strict();
const ExperimentMatrixSchema = z.unknown().transform((matrix, context) => {
  const grouped =
    matrix !== null &&
    typeof matrix === 'object' &&
    Object.hasOwn(matrix, 'groups');
  const parsed = (
    grouped ? GroupedExperimentMatrixSchema : FlatExperimentMatrixSchema
  ).safeParse(matrix);
  if (!parsed.success) {
    // Keep diagnostics specific to the authored form, including existing flat axes.
    for (const issue of parsed.error.issues)
      context.addIssue({ ...issue, fatal: true });
    return z.NEVER;
  }
  return parsed.data;
});

const ExperimentConfigSchema = z
  .object({
    id: CaseIdSchema,
    version: VersionSchema,
    dataset: DatasetIdentitySchema.extend({
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (value) => value === value.trim() && !value.includes('\0'),
          'must be a non-empty dataset location without NUL bytes',
        )
        .optional(),
      manifest_sha256: z
        .string()
        .refine(isSha256Digest, 'must be a sha256: digest'),
    }).strict(),
    forge: AuthoredForgeSchema.optional(),
    runtime: RuntimeSchema,
    models: z
      .object({
        role_player: ModelRefSchema.optional(),
        judge: ModelRefSchema.optional(),
      })
      .strict()
      .default({}),
    treatments: z.record(z.string(), TreatmentSchema).default({}),
    matrix: ExperimentMatrixSchema,
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
    const matrix = config.matrix;
    const grouped = 'groups' in matrix;
    const groups = 'groups' in matrix ? matrix.groups : [matrix];
    if (grouped) {
      const ids = new Set<string>();
      for (const [index, group] of matrix.groups.entries()) {
        if (group.id === undefined) continue;
        if (ids.has(group.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['matrix', 'groups', index, 'id'],
            message: 'matrix group IDs must be unique',
          });
        }
        ids.add(group.id);
      }
    }
    const treatmentNames = new Set([
      'baseline',
      ...Object.keys(config.treatments),
    ]);
    const previousGroups: {
      cases: Set<string>;
      treatments: Set<string>;
      agents: Set<string>;
    }[] = [];
    for (const [groupIndex, group] of groups.entries()) {
      const parent = grouped ? ['matrix', 'groups', groupIndex] : ['matrix'];
      const agentKeys = group.agents.map(agentSelectionKey);
      addDuplicateIssues(group.cases, context, [...parent, 'cases']);
      addDuplicateIssues(group.treatments, context, [...parent, 'treatments']);
      addDuplicateIssues(agentKeys, context, [...parent, 'agents']);
      for (const [index, treatment] of group.treatments.entries()) {
        if (!isSafeSimpleIdentifier(treatment)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...parent, 'treatments', index],
            message: 'treatment names must be safe identifiers',
          });
        } else if (!treatmentNames.has(treatment)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...parent, 'treatments', index],
            message: 'matrix references an undefined treatment',
          });
        }
      }
      const currentGroup = {
        cases: new Set(group.cases),
        treatments: new Set(group.treatments),
        agents: new Set(agentKeys),
      };
      // Cartesian products overlap exactly when all three axes intersect.
      // Check their sets without materializing a potentially huge product.
      if (
        previousGroups.some(
          (previous) =>
            setsIntersect(currentGroup.cases, previous.cases) &&
            setsIntersect(currentGroup.treatments, previous.treatments) &&
            setsIntersect(currentGroup.agents, previous.agents),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: parent,
          message:
            'matrix groups must not contain duplicate resolved selections',
        });
      }
      previousGroups.push(currentGroup);
    }
  });

/** Resolved plans require every defaulted authoring field to be materialized. */
const MaterializedEvalCaseSchema = z.intersection(
  z
    .object({
      id: CaseIdSchema,
      execution_mode: z.enum(['multi_turn', 'one_shot']),
      setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS),
      judging_criteria: JudgingCriteriaSchema,
    })
    .passthrough(),
  CompatibleEvalCaseSchema,
);

const ResolvedDockerRuntimeSchema = z
  .object({
    adapter: z.literal('docker'),
    image: z.object({ kind: z.literal('forge') }).strict(),
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

const ResolvedRuntimeSchema = z.union([
  ResolvedDockerRuntimeSchema,
  ExternalRuntimeSchema,
]);

const ResolvedRunPlanSchema = z
  .object({
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
          })
          .strict(),
        case: z
          .object({
            id: CaseIdSchema,
            path: DatasetPathSchema,
          })
          .strict(),
        forge: ForgeProvenanceSchema,
      })
      .strict(),
    case: MaterializedEvalCaseSchema,
    treatment: z
      .object({
        id: SimpleIdentifierSchema,
        setup: z.array(SetupStepEnvelopeSchema).max(MAX_SETUP_STEPS),
      })
      .strict(),
    setup: z.array(SetupStepEnvelopeSchema).max(MAX_RESOLVED_SETUP_STEPS),
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
        judging_criteria: JudgingCriteriaSchema,
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
        plan.evaluation.judging_criteria,
        plan.case.judging_criteria,
      )
    ) {
      addPlanIssue(
        context,
        ['evaluation', 'judging_criteria'],
        'evaluation criteria must match the selected case',
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
      plan.case.judging_criteria.length > 0 &&
      plan.evaluation.judge === undefined
    ) {
      addPlanIssue(
        context,
        ['evaluation', 'judge'],
        'plans with success criteria require a judge model',
      );
    }
    if (
      plan.case.judging_criteria.length === 0 &&
      plan.evaluation.judge !== undefined
    ) {
      addPlanIssue(
        context,
        ['evaluation', 'judge'],
        'plans without success criteria cannot include a judge model',
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
      { cause: error },
    );
  }
  assertBoundedDataGraph(value, 'dataset manifest');
  return parseDatasetManifest(value);
}

export function parseEvalCase(value: unknown): EvalCaseV1 {
  return parseEvalCaseWithSetupActions(value, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function parseEvalCaseWithSetupActions(
  value: unknown,
  setupActions: SetupActionRegistry,
): EvalCaseV1 {
  const parsed = parseWithSchema(
    EvalCaseSchema,
    value,
    'invalid_case',
    'eval case',
  ) as EvalCaseV1;
  return {
    ...parsed,
    setup: normalizeSetupSteps(
      parsed.setup,
      setupActions,
      'authoring',
      'invalid_case',
      'eval case setup step',
    ),
  };
}

export function parseEvalCaseYaml(source: string): EvalCaseV1 {
  return parseEvalCaseYamlWithSetupActions(source, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function parseEvalCaseYamlWithSetupActions(
  source: string,
  setupActions: SetupActionRegistry,
): EvalCaseV1 {
  return parseEvalCaseWithSetupActions(
    parseYaml(source, 'eval case'),
    setupActions,
  );
}

export function parseExperimentConfig(value: unknown): ExperimentConfigV1 {
  return parseExperimentConfigWithSetupActions(
    value,
    defaultSetupActionRegistry,
  );
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function parseExperimentConfigWithSetupActions(
  value: unknown,
  setupActions: SetupActionRegistry,
): ExperimentConfigV1 {
  const parsed = parseWithSchema(
    ExperimentConfigSchema,
    value,
    'invalid_experiment_config',
    'experiment config',
  ) as ExperimentConfigV1;
  const treatments = Object.fromEntries(
    Object.entries(parsed.treatments).map(([name, treatment]) => [
      name,
      {
        setup: normalizeSetupSteps(
          treatment.setup,
          setupActions,
          'authoring',
          'invalid_experiment_config',
          `treatment ${JSON.stringify(name)} setup step`,
        ),
      },
    ]),
  );
  const config: ExperimentConfigV1 = {
    ...parsed,
    treatments: {
      baseline: { setup: [] },
      ...treatments,
    },
  };
  try {
    const references = config.forge?.action_bundles ?? [];
    setupActions.assertReferencesMatch(references);
    for (const treatment of Object.values(config.treatments)) {
      setupActions.assertStepsDeclared(treatment.setup, references);
    }
  } catch (error) {
    throw new BenchmarkModelError(
      'invalid_experiment_config',
      'Invalid experiment config: setup action bundle references do not match its actions.',
      { cause: error },
    );
  }
  return config;
}

export function parseExperimentConfigYaml(source: string): ExperimentConfigV1 {
  return parseExperimentConfigYamlWithSetupActions(
    source,
    defaultSetupActionRegistry,
  );
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function parseExperimentConfigYamlWithSetupActions(
  source: string,
  setupActions: SetupActionRegistry,
): ExperimentConfigV1 {
  return parseExperimentConfigWithSetupActions(
    parseYaml(source, 'experiment config'),
    setupActions,
  );
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
  return parseResolvedRunPlanWithSetupActions(
    value,
    defaultSetupActionRegistry,
  );
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function parseResolvedRunPlanWithSetupActions(
  value: unknown,
  setupActions: SetupActionRegistry,
): ResolvedRunPlanV1 {
  // Check the producer before interpreting a release-owned plan format.
  try {
    assertBoundedDataGraph(value, 'resolved run plan');
    const envelope = z
      .object({
        provenance: z
          .object({ forge: z.object({ version: VersionSchema }).passthrough() })
          .passthrough(),
      })
      .passthrough()
      .parse(value);
    assertCompatibleForgeVersion(envelope.provenance.forge.version);
  } catch (error) {
    throw new BenchmarkModelError(
      'invalid_plan',
      'Invalid resolved run plan: incompatible Forge release or missing provenance.',
      { cause: error },
    );
  }
  const parsed = parseWithSchema(
    ResolvedRunPlanSchema,
    value,
    'invalid_plan',
    'resolved run plan',
  ) as ResolvedRunPlanV1;
  const caseSetup = normalizeSetupSteps(
    parsed.case.setup,
    setupActions,
    'canonical',
    'invalid_plan',
    'resolved case setup step',
  );
  const treatmentSetup = normalizeSetupSteps(
    parsed.treatment.setup,
    setupActions,
    'canonical',
    'invalid_plan',
    'resolved treatment setup step',
  );
  const normalized: ResolvedRunPlanV1 = {
    ...parsed,
    case: {
      ...parsed.case,
      setup: caseSetup,
    },
    treatment: {
      ...parsed.treatment,
      setup: treatmentSetup,
    },
    setup: [...caseSetup, ...treatmentSetup],
  };
  const rechecked = parseWithSchema(
    ResolvedRunPlanSchema,
    normalized,
    'invalid_plan',
    'resolved run plan',
  ) as ResolvedRunPlanV1;
  try {
    setupActions.assertExactReferences(
      rechecked.setup,
      rechecked.provenance.forge.action_bundles ?? [],
    );
  } catch (error) {
    throw new BenchmarkModelError(
      'invalid_plan',
      'Invalid resolved run plan: setup action bundle provenance is not the exact canonical set required by its actions.',
      { cause: error },
    );
  }
  return deepFreeze(rechecked);
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
    const value: unknown = document.toJS({ maxAliasCount: 100 });
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
    { cause: result.error },
  );
}

function addPlanIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
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

function assertSourceSize(
  source: string,
  maximum: number,
  label: string,
): void {
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
  code: BenchmarkModelErrorCode = label === 'dataset manifest'
    ? 'invalid_manifest'
    : 'invalid_yaml',
): void {
  type Frame =
    | { kind: 'enter'; value: unknown; depth: number }
    | { kind: 'leave'; value: object };
  const pending: Frame[] = [{ kind: 'enter', value, depth: 0 }];
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
    pending.push({ kind: 'leave', value: frame.value });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({
        kind: 'enter',
        value: entries[index],
        depth: frame.depth + 1,
      });
    }
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

function setsIntersect(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  const [smaller, larger] =
    left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) return true;
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function isBoundedText(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES && !value.includes('\0')
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Parse and canonicalize an authored setup envelope using public built-ins. */
export function parseSetupStep(value: unknown): SetupStepV1 {
  return parseSetupStepWithSetupActions(value, defaultSetupActionRegistry);
}

/** @internal Engine-bound variant using one already-frozen action registry. */
export function parseSetupStepWithSetupActions(
  value: unknown,
  setupActions: SetupActionRegistry,
): SetupStepV1 {
  return normalizeSetupStep(
    value,
    setupActions,
    'authoring',
    'invalid_case',
    'setup step',
  );
}

type SetupStepParseMode = 'authoring' | 'canonical';

function normalizeSetupSteps(
  input: readonly SetupStepV1[],
  setupActions: SetupActionRegistry,
  mode: SetupStepParseMode,
  code: 'invalid_case' | 'invalid_experiment_config' | 'invalid_plan',
  label: string,
): SetupStepV1[] {
  return input.map((step, index) =>
    normalizeSetupStep(
      step,
      setupActions,
      mode,
      code,
      `${label} at index ${index}`,
    ),
  );
}

function normalizeSetupStep(
  value: unknown,
  setupActions: SetupActionRegistry,
  mode: SetupStepParseMode,
  code: 'invalid_case' | 'invalid_experiment_config' | 'invalid_plan',
  label: string,
): SetupStepV1 {
  assertBoundedDataGraph(value, label, code);
  assertPlainJsonGraph(value, label, code);
  assertBoundedJsonBytes(value, label, code);
  const envelope = parseWithSchema(
    SetupStepEnvelopeSchema,
    value,
    code,
    label,
  ) as SetupStepV1;
  const action = setupActions.action(envelope.uses);
  if (!action) {
    throw new BenchmarkModelError(
      code,
      `Invalid ${label}: unknown setup action: ${envelope.uses}.`,
    );
  }

  const normalizedWith = parseSetupActionWith(action, envelope, code, label);
  if (mode === 'canonical') {
    if (!jsonValuesEqual(envelope.with, normalizedWith)) {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: action ${JSON.stringify(envelope.uses)} with payload is not canonical.`,
      );
    }
  } else {
    let reparsedWith: JsonObject;
    try {
      reparsedWith = parseSetupActionWith(
        action,
        { uses: envelope.uses, with: normalizedWith },
        code,
        `${label} normalized output`,
      );
    } catch (error) {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: action ${JSON.stringify(envelope.uses)} did not produce a stable canonical with payload.`,
        { cause: error },
      );
    }
    if (!jsonValuesEqual(normalizedWith, reparsedWith)) {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: action ${JSON.stringify(envelope.uses)} did not produce a stable canonical with payload.`,
      );
    }
  }

  return Object.freeze({
    uses: envelope.uses,
    with: normalizedWith,
  });
}

function parseSetupActionWith(
  action: SetupActionDefinition,
  step: SetupStepV1,
  code: 'invalid_case' | 'invalid_experiment_config' | 'invalid_plan',
  label: string,
): JsonObject {
  let output: unknown;
  try {
    output = action.parseWith(deepFreeze(structuredClone(step.with)));
  } catch (error) {
    throw new BenchmarkModelError(
      code,
      `Invalid ${label}: action ${JSON.stringify(step.uses)} rejected its with payload.`,
      { cause: error },
    );
  }
  const normalizedLabel = `${label} normalized with payload`;
  assertBoundedDataGraph(output, normalizedLabel, code);
  assertPlainJsonGraph(output, normalizedLabel, code);
  assertBoundedJsonBytes(output, normalizedLabel, code);
  const normalizedWith = parseWithSchema(
    JsonObjectSchema,
    output,
    code,
    normalizedLabel,
  ) as JsonObject;
  return deepFreeze(normalizedWith);
}

function assertBoundedJsonBytes(
  value: unknown,
  label: string,
  code: 'invalid_case' | 'invalid_experiment_config' | 'invalid_plan',
): void {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      bytes += Buffer.byteLength(current, 'utf8');
    } else if (Array.isArray(current)) {
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...current);
    } else if (current !== null && typeof current === 'object') {
      if (visited.has(current)) continue;
      visited.add(current);
      const entries = Object.entries(current as Record<string, unknown>);
      for (const [key, nested] of entries) {
        bytes += Buffer.byteLength(key, 'utf8');
        pending.push(nested);
      }
    } else {
      bytes += 8;
    }
    if (bytes > MAX_TEXT_BYTES) {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: payload exceeds the ${MAX_TEXT_BYTES}-byte limit.`,
      );
    }
  }
}

function assertPlainJsonGraph(
  value: unknown,
  label: string,
  code: 'invalid_case' | 'invalid_experiment_config' | 'invalid_plan',
): void {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== 'object') {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: payload must contain only JSON values.`,
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current).filter((key) => key !== 'length');
      if (
        keys.length !== current.length ||
        keys.some(
          (key, index) =>
            key !== String(index) ||
            Object.getOwnPropertyDescriptor(current, key)?.enumerable !== true,
        )
      ) {
        throw new BenchmarkModelError(
          code,
          `Invalid ${label}: arrays contain unsupported fields.`,
        );
      }
      pending.push(...current);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: payload must contain only plain JSON objects.`,
      );
    }
    const record = current as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          Object.getOwnPropertyDescriptor(record, key)?.enumerable !== true,
      )
    ) {
      throw new BenchmarkModelError(
        code,
        `Invalid ${label}: objects contain unsupported fields.`,
      );
    }
    pending.push(...(keys as string[]).map((key) => record[key]));
  }
}
