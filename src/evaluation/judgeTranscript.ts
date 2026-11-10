import { z } from 'zod';

import {
  type AtifAgentStep,
  type AtifContent,
  type AtifObservationResult,
  type AtifTrajectoryV1_8,
  type JsonObject,
  parseAtifTrajectory,
} from '../atif/index.ts';
import { AtifValidationError, assertBoundedJsonValue } from '../atif/parser.ts';
import { serializeCanonicalJson } from '../serialization.ts';

export const JUDGE_TRANSCRIPT_SOURCE = 'trajectory.json' as const;
export const JUDGE_TRANSCRIPT_PROJECTION_ID =
  'forge-visible-atif-steps' as const;
// Retain the strict reader contract for existing excerpt projections. New
// projections keep complete steps; execution selects by the whole-prompt budget.
const TRANSCRIPT_OMISSION_MESSAGE =
  '[Forge truncated the judge transcript to 768 KiB. The prefix and suffix are excerpts of canonical step JSON; intervening evidence is omitted.]';
const TRANSCRIPT_WARNING = Object.freeze({
  code: 'transcript_truncated' as const,
  message: TRANSCRIPT_OMISSION_MESSAGE,
});
export const JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE = 'root' as const;
export const JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES = Object.freeze([
  'user',
  'agent',
] as const);
export const JUDGE_TRANSCRIPT_COPIED_CONTEXT = 'excluded' as const;
export const JUDGE_TRANSCRIPT_INCLUDED_FIELDS = Object.freeze([
  'step_id',
  'source',
  'message',
  'tool_calls[].tool_call_id',
  'tool_calls[].function_name',
  'tool_calls[].arguments',
  'observation.results[].source_call_id',
  'observation.results[].content',
  'observation.results[].is_error',
] as const);

/** Message or media-reference content visible to a criterion judge. */
export type JudgeVisibleContentV1 = AtifContent;

/** Observable invocation details, excluding provider-specific metadata. */
export interface JudgeVisibleToolCallV1 {
  readonly tool_call_id: string;
  readonly function_name: string;
  readonly arguments: JsonObject;
}

/** Observable tool output, excluding subagent references and arbitrary extras. */
export interface JudgeVisibleObservationResultV1 {
  readonly source_call_id?: string;
  readonly content?: JudgeVisibleContentV1;
  /** Promoted only from an exact boolean `extra.is_error` value. */
  readonly is_error?: boolean;
}

export interface JudgeVisibleObservationV1 {
  readonly results: readonly JudgeVisibleObservationResultV1[];
}

export interface JudgeVisibleUserStepV1 {
  readonly step_id: number;
  readonly source: 'user';
  readonly message: JudgeVisibleContentV1;
}

export interface JudgeVisibleAgentStepV1 {
  readonly step_id: number;
  readonly source: 'agent';
  readonly message: JudgeVisibleContentV1;
  readonly tool_calls?: readonly JudgeVisibleToolCallV1[];
  readonly observation?: JudgeVisibleObservationV1;
}

/** Root behavior, or a previously recorded marked start/end excerpt. */
export type JudgeVisibleStepV1 =
  | JudgeVisibleUserStepV1
  | JudgeVisibleAgentStepV1
  | {
      readonly source: 'omission';
      readonly message: string;
      readonly prefix: string;
      readonly suffix: string;
    };

/** Exact transcript projection and declared policy supplied to a criterion judge. */
export interface JudgeTranscriptProjectionV1 {
  readonly source: typeof JUDGE_TRANSCRIPT_SOURCE;
  readonly projectionId: typeof JUDGE_TRANSCRIPT_PROJECTION_ID;
  readonly trajectoryScope: typeof JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE;
  readonly includedStepSources: typeof JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES;
  readonly copiedContext: typeof JUDGE_TRANSCRIPT_COPIED_CONTEXT;
  readonly includedFields: typeof JUDGE_TRANSCRIPT_INCLUDED_FIELDS;
  /** Exact canonical JSON supplied to the judge, including its final LF. */
  readonly transcriptJson: string;
  /** Present on previously recorded marked start/end excerpts. */
  readonly warnings?: readonly {
    readonly code: 'transcript_truncated';
    readonly message: string;
  }[];
}

/** Canonical empty transcript with the same declared projection policy. */
export const EMPTY_JUDGE_TRANSCRIPT: JudgeTranscriptProjectionV1 =
  Object.freeze({
    source: JUDGE_TRANSCRIPT_SOURCE,
    projectionId: JUDGE_TRANSCRIPT_PROJECTION_ID,
    trajectoryScope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
    includedStepSources: JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
    copiedContext: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
    includedFields: JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
    transcriptJson: serializeCanonicalJson([]),
  });

/**
 * Project canonical ATIF into the root-step evidence visible to a judge.
 *
 * The input is validated first and projected by positive allowlist. System and
 * copied-context steps are excluded. Opaque tool arguments and result content
 * remain intact because they are observable agent behavior; all other ATIF
 * metadata, reasoning, extras, and subagent references are excluded.
 */
export function createJudgeTranscriptProjection(
  trajectory: AtifTrajectoryV1_8,
): JudgeTranscriptProjectionV1 {
  const parsed = parseAtifTrajectory(trajectory);
  const projectedSteps: JudgeVisibleStepV1[] = [];

  for (const step of parsed.steps) {
    if (step.source === 'system' || step.is_copied_context === true) continue;

    if (step.source === 'user') {
      projectedSteps.push({
        step_id: step.step_id,
        source: step.source,
        message: step.message,
      });
      continue;
    }

    const projected = projectAgentStep(step);
    if (hasJudgeVisibleAgentBehavior(projected)) {
      projectedSteps.push(projected);
    }
  }

  return makeProjection(serializeCanonicalJson(projectedSteps));
}

/**
 * Validate an untrusted projection at the public judge boundary.
 *
 * Metadata must describe this exact policy, and transcript bytes must be the
 * canonical serialization of a strict JudgeVisibleStepV1 array. The returned
 * projection is a fresh, frozen metadata object.
 */
export function parseJudgeTranscriptProjection(
  input: unknown,
): JudgeTranscriptProjectionV1 {
  assertBoundedProjectionJson(input, 'metadata');
  const projection = ProjectionSchema.parse(input);
  let decoded: unknown;
  try {
    decoded = JSON.parse(projection.transcriptJson);
  } catch {
    throw new TypeError('Judge transcript projection is not valid JSON.');
  }

  assertBoundedProjectionJson(decoded, 'transcript');
  const steps = JudgeVisibleStepsSchema.parse(decoded);
  const canonicalTranscript = serializeCanonicalJson(steps);
  if (canonicalTranscript !== projection.transcriptJson) {
    throw new TypeError(
      'Judge transcript projection must use canonical JSON with a final LF.',
    );
  }

  const truncated = steps[0]?.source === 'omission';
  if (
    serializeCanonicalJson(projection.warnings ?? []) !==
    serializeCanonicalJson(truncated ? [TRANSCRIPT_WARNING] : [])
  ) {
    throw new TypeError(
      'Judge transcript truncation requires its exact evidence warning.',
    );
  }
  return makeProjection(canonicalTranscript, truncated);
}

function projectAgentStep(step: AtifAgentStep): JudgeVisibleAgentStepV1 {
  const toolCalls = (step.tool_calls ?? []).map((call) => ({
    tool_call_id: call.tool_call_id,
    function_name: call.function_name,
    arguments: call.arguments,
  }));
  const results = (step.observation?.results ?? [])
    .map(projectObservationResult)
    .filter(
      (result): result is JudgeVisibleObservationResultV1 =>
        result !== undefined,
    );

  return {
    step_id: step.step_id,
    source: step.source,
    message: step.message,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(results.length > 0 ? { observation: { results } } : {}),
  };
}

interface JudgeVisibleAgentBehaviorShape {
  readonly message: unknown;
  readonly tool_calls?: readonly unknown[] | undefined;
  readonly observation?: { readonly results: readonly unknown[] } | undefined;
}

function hasJudgeVisibleAgentBehavior(
  step: JudgeVisibleAgentBehaviorShape,
): boolean {
  const hasMessage = hasJudgeVisibleMessage(step.message);
  return (
    hasMessage ||
    (step.tool_calls?.length ?? 0) > 0 ||
    (step.observation?.results.length ?? 0) > 0
  );
}

function hasJudgeVisibleMessage(message: unknown): boolean {
  if (typeof message === 'string') return message.length > 0;
  if (!Array.isArray(message)) return false;
  return message.some((part) => {
    if (typeof part !== 'object' || part === null) return false;
    const candidate = part as {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    if (candidate.type === 'text') {
      return typeof candidate.text === 'string' && candidate.text.length > 0;
    }
    return candidate.type === 'image' || candidate.type === 'audio';
  });
}

function projectObservationResult(
  result: AtifObservationResult,
): JudgeVisibleObservationResultV1 | undefined {
  const isError = result.extra?.is_error;
  const projected: JudgeVisibleObservationResultV1 = {
    ...(result.source_call_id != null
      ? { source_call_id: result.source_call_id }
      : {}),
    ...(result.content != null ? { content: result.content } : {}),
    ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
  };

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function makeProjection(
  transcriptJson: string,
  truncated = false,
): JudgeTranscriptProjectionV1 {
  return Object.freeze({
    source: JUDGE_TRANSCRIPT_SOURCE,
    projectionId: JUDGE_TRANSCRIPT_PROJECTION_ID,
    trajectoryScope: JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
    includedStepSources: JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
    copiedContext: JUDGE_TRANSCRIPT_COPIED_CONTEXT,
    includedFields: JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
    transcriptJson,
    ...(truncated ? { warnings: Object.freeze([TRANSCRIPT_WARNING]) } : {}),
  });
}

function assertBoundedProjectionJson(
  input: unknown,
  scope: 'metadata' | 'transcript',
): void {
  try {
    assertBoundedJsonValue(input);
  } catch (error) {
    if (error instanceof AtifValidationError) {
      throw new TypeError(
        `Judge transcript projection ${scope} is not bounded JSON.`,
        { cause: error },
      );
    }
    throw error;
  }
}

const FiniteNumberSchema = z.number().finite();
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
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
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    path: z.string().min(1),
  })
  .strict();
const AudioSourceSchema = z
  .object({
    media_type: z.enum([
      'audio/wav',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/ogg',
      'audio/flac',
      'audio/webm',
      'audio/aiff',
    ]),
    path: z.string().min(1),
    duration_sec: FiniteNumberSchema.nonnegative().nullish(),
  })
  .strict();
const ContentSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }).strict(),
      z
        .object({ type: z.literal('image'), source: ImageSourceSchema })
        .strict(),
      z
        .object({ type: z.literal('audio'), source: AudioSourceSchema })
        .strict(),
    ]),
  ),
]);
const ToolCallSchema = z
  .object({
    tool_call_id: z.string().min(1),
    function_name: z.string().min(1),
    arguments: JsonObjectSchema,
  })
  .strict();
const ObservationResultSchema = z
  .object({
    source_call_id: z.string().min(1).optional(),
    content: ContentSchema.optional(),
    is_error: z.boolean().optional(),
  })
  .strict()
  .refine((result) => Object.keys(result).length > 0, {
    message: 'A judge-visible observation result cannot be empty.',
  });
const ObservationSchema = z
  .object({ results: z.array(ObservationResultSchema).min(1) })
  .strict();
const UserStepSchema = z
  .object({
    step_id: z.number().int().min(1),
    source: z.literal('user'),
    message: ContentSchema,
  })
  .strict();
const AgentStepSchema = z
  .object({
    step_id: z.number().int().min(1),
    source: z.literal('agent'),
    message: ContentSchema,
    tool_calls: z.array(ToolCallSchema).min(1).optional(),
    observation: ObservationSchema.optional(),
  })
  .strict()
  .refine(hasJudgeVisibleAgentBehavior, {
    message: 'An agent step must contain visible message or tool behavior.',
  })
  .superRefine((step, context) => {
    const toolCallIds = new Set<string>();
    for (const [index, call] of (step.tool_calls ?? []).entries()) {
      if (toolCallIds.has(call.tool_call_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tool_calls', index, 'tool_call_id'],
          message: 'tool_call_id must be unique within a step',
        });
      }
      toolCallIds.add(call.tool_call_id);
    }
    for (const [index, result] of (step.observation?.results ?? []).entries()) {
      if (
        result.source_call_id !== undefined &&
        !toolCallIds.has(result.source_call_id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observation', 'results', index, 'source_call_id'],
          message:
            'source_call_id must reference a tool call from the same step',
        });
      }
    }
  });
const CompleteStepsSchema = z
  .array(z.union([UserStepSchema, AgentStepSchema]))
  .superRefine((steps, context) => {
    for (let index = 1; index < steps.length; index += 1) {
      if (steps[index]!.step_id <= steps[index - 1]!.step_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'step_id'],
          message: 'step_id values must retain increasing trajectory order',
        });
      }
    }
  });
const JudgeVisibleStepsSchema = z.union([
  CompleteStepsSchema,
  z.tuple([
    z
      .object({
        source: z.literal('omission'),
        message: z.literal(TRANSCRIPT_OMISSION_MESSAGE),
        prefix: z.string().min(1),
        suffix: z.string().min(1),
      })
      .strict(),
  ]),
]);
const ProjectionSchema = z
  .object({
    source: z.literal(JUDGE_TRANSCRIPT_SOURCE),
    projectionId: z.literal(JUDGE_TRANSCRIPT_PROJECTION_ID),
    trajectoryScope: z.literal(JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE),
    includedStepSources: z.tuple([
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES[0]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES[1]),
    ]),
    copiedContext: z.literal(JUDGE_TRANSCRIPT_COPIED_CONTEXT),
    includedFields: z.tuple([
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[0]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[1]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[2]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[3]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[4]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[5]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[6]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[7]),
      z.literal(JUDGE_TRANSCRIPT_INCLUDED_FIELDS[8]),
    ]),
    transcriptJson: z.string(),
    warnings: z
      .array(
        z
          .object({
            code: z.literal(TRANSCRIPT_WARNING.code),
            message: z.literal(TRANSCRIPT_WARNING.message),
          })
          .strict(),
      )
      .length(1)
      .optional(),
  })
  .strict();
