import { z } from 'zod';
import { isAtifTimestamp } from './timestamp.ts';
import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectoryV1_8,
  type JsonValue,
} from './types.ts';

const IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

const AUDIO_MEDIA_TYPES = [
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
  'audio/aiff',
] as const;

const AUDIO_MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'audio/mp3': 'audio/mpeg',
  'audio/mpga': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/x-flac': 'audio/flac',
  'audio/x-aiff': 'audio/aiff',
};

const FiniteNumberSchema = z.number().finite();
const IntegerSchema = FiniteNumberSchema.int();
const NonEmptyStringSchema = z.string().min(1);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    FiniteNumberSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

const ImageSourceSchema = z
  .object({
    media_type: z.enum(IMAGE_MEDIA_TYPES),
    path: NonEmptyStringSchema,
  })
  .strict();

const AudioMediaTypeSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  return AUDIO_MEDIA_TYPE_ALIASES[normalized] ?? normalized;
}, z.enum(AUDIO_MEDIA_TYPES));

const AudioSourceSchema = z
  .object({
    media_type: AudioMediaTypeSchema,
    path: NonEmptyStringSchema,
    duration_sec: FiniteNumberSchema.nonnegative().nullish(),
  })
  .strict();

const ContentPartSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      source: ImageSourceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('audio'),
      source: AudioSourceSchema,
    })
    .strict(),
]);

const ContentSchema = z.union([z.string(), z.array(ContentPartSchema)]);

const AgentSchema = z
  .object({
    name: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    model_name: NonEmptyStringSchema.nullish(),
    tool_definitions: z.array(JsonObjectSchema).nullish(),
    extra: JsonObjectSchema.nullish(),
  })
  .strict();

const MetricsSchema = z
  .object({
    prompt_tokens: IntegerSchema.nullish(),
    completion_tokens: IntegerSchema.nullish(),
    cached_tokens: IntegerSchema.nullish(),
    cost_usd: FiniteNumberSchema.nullish(),
    prompt_token_ids: z.array(IntegerSchema).nullish(),
    completion_token_ids: z.array(IntegerSchema).nullish(),
    logprobs: z.array(FiniteNumberSchema).nullish(),
    extra: JsonObjectSchema.nullish(),
  })
  .strict();

const FinalMetricsSchema = z
  .object({
    total_prompt_tokens: IntegerSchema.nullish(),
    total_completion_tokens: IntegerSchema.nullish(),
    total_cached_tokens: IntegerSchema.nullish(),
    total_cost_usd: FiniteNumberSchema.nullish(),
    total_steps: IntegerSchema.nonnegative().nullish(),
    extra: JsonObjectSchema.nullish(),
  })
  .strict();

const ToolCallSchema = z
  .object({
    tool_call_id: NonEmptyStringSchema,
    function_name: NonEmptyStringSchema,
    arguments: JsonObjectSchema,
    extra: JsonObjectSchema.nullish(),
  })
  .strict();

const SubagentTrajectoryRefSchema = z
  .object({
    trajectory_id: NonEmptyStringSchema.nullish(),
    session_id: NonEmptyStringSchema.nullish(),
    trajectory_path: NonEmptyStringSchema.nullish(),
    extra: JsonObjectSchema.nullish(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.trajectory_id == null && reference.trajectory_path == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trajectory_id'],
        message:
          'A subagent reference requires trajectory_id or trajectory_path; session_id is informational only.',
      });
    }
  });

const ObservationResultSchema = z
  .object({
    source_call_id: NonEmptyStringSchema.nullish(),
    content: ContentSchema.nullish(),
    subagent_trajectory_ref: z.array(SubagentTrajectoryRefSchema).nullish(),
    extra: JsonObjectSchema.nullish(),
  })
  .strict();

const ObservationSchema = z
  .object({
    results: z.array(ObservationResultSchema),
  })
  .strict();

const StepSchema = z
  .object({
    step_id: IntegerSchema.min(1),
    timestamp: z
      .string()
      .refine(isAtifTimestamp, 'timestamp must be an ISO 8601 date-time')
      .nullish(),
    source: z.enum(['system', 'user', 'agent']),
    model_name: NonEmptyStringSchema.nullish(),
    reasoning_effort: z
      .union([NonEmptyStringSchema, FiniteNumberSchema])
      .nullish(),
    message: ContentSchema,
    reasoning_content: z.string().nullish(),
    tool_calls: z.array(ToolCallSchema).nullish(),
    observation: ObservationSchema.nullish(),
    metrics: MetricsSchema.nullish(),
    is_copied_context: z.boolean().nullish(),
    llm_call_count: IntegerSchema.nonnegative().nullish(),
    extra: JsonObjectSchema.nullish(),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.source !== 'agent') {
      const agentOnlyFields = [
        'model_name',
        'reasoning_effort',
        'reasoning_content',
        'tool_calls',
        'metrics',
      ] as const;
      for (const field of agentOnlyFields) {
        if (step[field] != null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is only valid on an agent step`,
          });
        }
      }
    }

    if (step.source === 'user' && step.observation != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observation'],
        message: 'observation is only valid on an agent or system step',
      });
    }

    if (step.source === 'agent' && step.llm_call_count === 0) {
      for (const field of ['metrics', 'reasoning_content'] as const) {
        if (step[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} must be absent when llm_call_count is 0`,
          });
        }
      }
    }

    const toolCallIds = new Set<string>();
    for (const [index, toolCall] of (step.tool_calls ?? []).entries()) {
      if (toolCallIds.has(toolCall.tool_call_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tool_calls', index, 'tool_call_id'],
          message: 'tool_call_id must be unique within a step',
        });
      }
      toolCallIds.add(toolCall.tool_call_id);
    }

    for (const [index, result] of (step.observation?.results ?? []).entries()) {
      if (
        result.source_call_id != null &&
        !toolCallIds.has(result.source_call_id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observation', 'results', index, 'source_call_id'],
          message:
            'source_call_id must reference a tool_call_id from the same step',
        });
      }
    }
  });

let TrajectorySchema: z.ZodType<AtifTrajectoryV1_8>;

TrajectorySchema = z.lazy(() =>
  z
    .object({
      schema_version: z.literal(ATIF_SCHEMA_VERSION),
      session_id: NonEmptyStringSchema.nullish(),
      trajectory_id: NonEmptyStringSchema.nullish(),
      agent: AgentSchema,
      steps: z.array(StepSchema).min(1),
      notes: z.string().nullish(),
      final_metrics: FinalMetricsSchema.nullish(),
      continued_trajectory_ref: NonEmptyStringSchema.nullish(),
      extra: JsonObjectSchema.nullish(),
      subagent_trajectories: z.array(TrajectorySchema).nullish(),
    })
    .strict()
    .superRefine((trajectory, context) => {
      for (const [index, step] of trajectory.steps.entries()) {
        const expected = index + 1;
        if (step.step_id !== expected) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', index, 'step_id'],
            message: `step_id must be sequential from 1; expected ${expected}`,
          });
        }
      }

      if (
        trajectory.final_metrics?.total_steps != null &&
        trajectory.final_metrics.total_steps !== trajectory.steps.length &&
        !trajectory.notes?.trim()
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['final_metrics', 'total_steps'],
          message:
            'A total_steps value different from steps.length must be explained in notes',
        });
      }

      const embeddedIds = new Set<string>();
      for (const [index, subagent] of (
        trajectory.subagent_trajectories ?? []
      ).entries()) {
        if (subagent.trajectory_id == null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subagent_trajectories', index, 'trajectory_id'],
            message: 'trajectory_id is required on an embedded subagent',
          });
          continue;
        }
        if (embeddedIds.has(subagent.trajectory_id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subagent_trajectories', index, 'trajectory_id'],
            message:
              'trajectory_id must be unique within subagent_trajectories',
          });
        }
        embeddedIds.add(subagent.trajectory_id);
      }

      for (const [stepIndex, step] of trajectory.steps.entries()) {
        for (const [resultIndex, result] of (
          step.observation?.results ?? []
        ).entries()) {
          for (const [referenceIndex, reference] of (
            result.subagent_trajectory_ref ?? []
          ).entries()) {
            if (
              reference.trajectory_id != null &&
              reference.trajectory_path == null &&
              !embeddedIds.has(reference.trajectory_id)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  'steps',
                  stepIndex,
                  'observation',
                  'results',
                  resultIndex,
                  'subagent_trajectory_ref',
                  referenceIndex,
                  'trajectory_id',
                ],
                message:
                  'An embedded subagent reference must resolve to subagent_trajectories',
              });
            }
          }
        }
      }
    }),
) as z.ZodType<AtifTrajectoryV1_8>;

/** Internal boundary that keeps Zod out of the public function signatures. */
export function parseAtifSchema(input: unknown): AtifTrajectoryV1_8 {
  return TrajectorySchema.parse(input);
}
