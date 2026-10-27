import { z } from 'zod';
import { assertBoundedJsonValue } from '../atif/parser.ts';
import {
  agentAdapterMetadataSchema,
  completionProviderMetadataSchema,
} from '../contracts/metadata.ts';
import {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  parseJudgeTranscriptProjection,
} from '../evaluation/judgeTranscript.ts';
import { scoreEvaluation } from '../evaluation/score.ts';
import { criterionRequirementWordingIssue } from '../model/criteria.ts';
import { parseRunSelection } from '../model/index.ts';
import {
  isSafeActionIdentifier,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from '../model/paths.ts';
import {
  DEFAULT_REQUIREMENT_LEVEL,
  REQUIREMENT_LEVELS,
} from '../model/types.ts';
import { MAX_ERROR_MESSAGE_CHARACTERS } from '../security/errorMessage.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  assertCompatibleForgeVersion,
  parseForgeBuildIdentity,
} from '../version.ts';
import {
  type ForgeArtifactParseContext,
  type InteractionArtifactV1,
  type JudgeEvidenceV1,
  MAX_MATCHED_TOOL_CALLS,
  type RunResult,
  type SetupArtifactV1,
  type WorkspaceEvidenceV1,
} from './types.ts';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const safeText = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const safeIdentifier = z.string().refine(isSafeSimpleIdentifier);
const safeVersion = z.string().refine(isSafeVersion);
const isoTimestamp = z.string().datetime({ offset: true });
const boundedArtifactText = z.string().max(16 * 1024 * 1024);

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const setupArtifactSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            uses: z.string().refine(isSafeActionIdentifier),
            resolution: z.record(z.string(), jsonValue).optional(),
          })
          .strict(),
      )
      .max(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, step] of value.steps.entries()) {
      if (step.index !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'index'],
          message:
            'Setup artifact step indices must be contiguous and zero-based.',
        });
      }
    }
  });

const workspaceEvidenceSchema = z
  .object({
    entries: z.array(
      z
        .object({
          path: safeText,
          exists: z.boolean(),
          kind: z.enum(['file', 'directory', 'other', 'missing']),
          size_bytes: z.number().int().nonnegative().optional(),
          content_base64: z.string().max(342_000).optional(),
          issue: z
            .string()
            .max(64 * 1024)
            .optional(),
        })
        .strict(),
    ),
    complete: z.boolean(),
    warnings: z.array(
      z
        .object({
          code: safeText,
          message: z
            .string()
            .min(1)
            .max(64 * 1024),
          path: safeText.optional(),
        })
        .strict(),
    ),
  })
  .strict();

const checkResult = z
  .object({
    name: safeText,
    label: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    requirement_level: z.enum(REQUIREMENT_LEVELS).optional(),
    passed: z.boolean(),
    detail: z
      .string()
      .max(64 * 1024)
      .optional(),
    tool_calls: z
      .object({
        matched_count: z.number().int().nonnegative(),
        calls: z
          .array(
            z
              .object({
                step_id: z.number().int(),
                tool_call_id: safeText,
                function_name: safeText,
              })
              .strict(),
          )
          .max(MAX_MATCHED_TOOL_CALLS),
      })
      .strict()
      .refine(({ matched_count, calls }) => calls.length <= matched_count)
      .optional(),
  })
  .strict()
  .refine(
    ({ passed, tool_calls }) =>
      tool_calls === undefined || passed === tool_calls.matched_count > 0,
    'A tool call check passes exactly when a call matched.',
  );

const artifactDescriptor = z
  .object({
    path: safeText,
    media_type: safeText,
    size_bytes: z.number().int().nonnegative(),
    sha256: digest,
    sensitivity: z.literal('restricted').optional(),
  })
  .strict();

const rolePlayerError = z
  .object({
    status: z.literal('role_player_error'),
    error_type: z.enum(['parse_error', 'request_error']),
    attempts: z.number().int().positive(),
    explanation: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

const interactionToolCall = z
  .object({
    id: safeText.optional(),
    name: safeText,
    input: jsonValue.optional(),
    result: z
      .object({
        content: z.string().max(1024 * 1024),
        isError: z.boolean().optional(),
        truncated: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const interactionTurn = z
  .object({
    turn: z.number().int().positive(),
    user: boundedArtifactText,
    assistant: boundedArtifactText,
    tool_calls: z.array(interactionToolCall).max(100_000),
  })
  .strict();
const criterionFields = {
  label: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  requirement_level: z
    .enum(REQUIREMENT_LEVELS)
    .default(DEFAULT_REQUIREMENT_LEVEL),
  criterion: z
    .string()
    .min(1)
    .max(64 * 1024),
  explanation: z.string().max(64 * 1024),
};
const criterionResult = z
  .union([
    z.object({ ...criterionFields, passed: z.boolean() }).strict(),
    z
      .object({
        ...criterionFields,
        passed: z.null(),
        error: z
          .object({
            type: z.enum(['parse_error', 'request_error']),
            attempts: z.number().int().min(1).max(3),
            message: z.string().trim().min(1).max(MAX_ERROR_MESSAGE_CHARACTERS),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((criterion, context) => {
    const wordingIssue = criterionRequirementWordingIssue(
      criterion.criterion,
      criterion.requirement_level,
    );
    if (wordingIssue !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criterion'],
        message: wordingIssue,
      });
    }
  });

export const evaluationResultSchema = z
  .object({
    score: z.number().finite().min(0).max(1).nullable(),
    status: z.enum(['passed', 'partial', 'failed', 'judge_error']),
    judging_criteria_passed: z.number().int().nonnegative(),
    judging_criteria_total: z.number().int().nonnegative(),
    judging_criteria_errored: z.number().int().nonnegative(),
    judging_criteria: z.array(criterionResult),
    checks: z.array(checkResult),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = scoreEvaluation(
      value.judging_criteria.map(({ label, ...criterion }) => ({
        ...criterion,
        ...(label === undefined ? {} : { label }),
      })),
      value.checks.map(
        ({ label, requirement_level, detail, tool_calls, ...check }) => ({
          ...check,
          ...(label === undefined ? {} : { label }),
          ...(requirement_level === undefined ? {} : { requirement_level }),
          ...(detail === undefined ? {} : { detail }),
          ...(tool_calls === undefined ? {} : { tool_calls }),
        }),
      ),
    );
    if (
      value.judging_criteria_total !== expected.judging_criteria_total ||
      value.judging_criteria_passed !== expected.judging_criteria_passed ||
      value.judging_criteria_errored !== expected.judging_criteria_errored
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Criterion totals do not match criterion results.',
      });
    }
    if (value.score !== expected.score || value.status !== expected.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Evaluation score and status do not match criterion and check results.',
      });
    }
  });

const avaNeed = z
  .object({
    id: safeText,
    description: z.string().trim().min(1).max(240),
  })
  .strict();

const avaDecisionBase = z
  .object({
    sequence: z.number().int().positive(),
    after_agent_turn: z.number().int().positive().nullable(),
    stop: z.boolean(),
    remaining_need_ids: z.array(safeText).max(6).nullable(),
    focus_need_id: safeText.nullable(),
    coding_agent_invoked: z.boolean(),
    error: rolePlayerError.optional(),
  })
  .strict();

const avaDecision = z.discriminatedUnion('source', [
  avaDecisionBase.extend({
    source: z.literal('configured_initial_prompt'),
    message: boundedArtifactText,
  }),
  avaDecisionBase.extend({
    source: z.literal('generated'),
    message: z.string().max(500),
  }),
]);

const interactionArtifactSchema = z
  .object({
    mode: z.enum(['multi_turn', 'one_shot']),
    stop_reason: z.enum(['task_complete', 'max_turns', 'role_player_error']),
    turns: z.array(interactionTurn).max(100),
    role_player: z
      .object({
        model: z.object({ provider: safeText, model: safeText }).strict(),
        needs: z.array(avaNeed).max(6).nullable(),
        decisions: z.array(avaDecision).max(101),
      })
      .strict()
      .optional(),
    failure: rolePlayerError.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, turn] of value.turns.entries()) {
      if (turn.turn !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['turns', index, 'turn'],
          message: 'Interaction turns must be contiguous and one-based.',
        });
      }
    }
    if (value.mode === 'one_shot') {
      if (value.role_player !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['role_player'],
          message: 'One-shot interactions cannot contain role-player state.',
        });
      }
      if (value.turns.length !== 1 || value.stop_reason !== 'task_complete') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['turns'],
          message: 'One-shot interactions require one completed task turn.',
        });
      }
    } else if (value.role_player === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role_player'],
        message: 'Multi-turn interactions require role-player audit state.',
      });
    }
    if (
      (value.stop_reason === 'role_player_error') !==
      (value.failure !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Interaction failure must match its stop reason.',
      });
    }
    const decisions = value.role_player?.decisions ?? [];
    for (const [index, decision] of decisions.entries()) {
      if (decision.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['role_player', 'decisions', index, 'sequence'],
          message: 'Ava decisions must be contiguous and one-based.',
        });
      }
    }
    const invoked = decisions.filter(
      ({ coding_agent_invoked }) => coding_agent_invoked,
    ).length;
    if (value.role_player !== undefined && invoked !== value.turns.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role_player', 'decisions'],
        message: 'Ava invocation decisions must match completed agent turns.',
      });
    }
  });

const judgeEvidenceSchema = z
  .object({
    transcript: z
      .object({
        source: z.literal(JUDGE_TRANSCRIPT_SOURCE),
        projection_id: z.literal(JUDGE_TRANSCRIPT_PROJECTION_ID),
        trajectory_scope: z.literal(JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE),
        included_step_sources: z.tuple([
          z.literal(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES[0]),
          z.literal(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES[1]),
        ]),
        copied_context: z.literal(JUDGE_TRANSCRIPT_COPIED_CONTEXT),
        included_fields: z.tuple([
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
        // The shared projection parser below validates the complete step schema.
        steps: z.array(z.unknown()),
        omitted: z.literal('judge_budget_exceeded').optional(),
        warnings: z.array(z.unknown()).optional(),
      })
      .strict()
      .refine(
        (transcript) =>
          transcript.omitted === undefined || transcript.steps.length === 0,
        { message: 'An omitted judge transcript must have empty steps.' },
      ),
    workspace: z
      .object({
        entries: z
          .array(
            z
              .object({
                path: safeText,
                content: z.string().max(20_000),
                truncated: z.boolean(),
              })
              .strict(),
          )
          .max(10_000),
        complete: z.boolean(),
        warnings: z
          .array(
            z
              .object({
                code: safeText,
                message: z
                  .string()
                  .min(1)
                  .max(64 * 1024),
                path: safeText.optional(),
              })
              .strict(),
          )
          .max(10_000),
      })
      .strict(),
  })
  .strict();

const completionCallSummary = z
  .object({
    sequence: z.number().int().positive(),
    purpose: z.enum(['role_player', 'judge']),
    provider: safeText,
    provider_version: safeText,
    provider_metadata: completionProviderMetadataSchema.optional(),
    model: safeText,
    status: z.enum(['succeeded', 'failed']),
    stop_reason: z
      .enum([
        'end_turn',
        'max_tokens',
        'stop_sequence',
        'tool_use',
        'pause_turn',
        'refusal',
        'model_context_window_exceeded',
        'other',
      ])
      .nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    cached_tokens: z.number().int().nonnegative().nullable(),
    cost_usd: z.number().finite().nonnegative().nullable(),
    error_code: safeText.nullable(),
  })
  .strict();

const normalizationWarning = z
  .object({
    code: z.enum([
      'source_unavailable',
      'source_invalid',
      'source_incomplete',
      'unsupported_native_event',
      'fallback_used',
      'value_omitted',
    ]),
    message: z
      .string()
      .min(1)
      .max(64 * 1024),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict();

const normalizationSource = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('native_log'),
      format: safeText,
      session_id: safeText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('atif'),
      format: z.literal('atif'),
      schema_version: safeText,
      session_id: safeText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('driver_fallback'),
      format: z.literal('forge-driver-turns'),
      session_id: safeText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('role_player_error'),
      format: z.literal('forge-system-event'),
    })
    .strict(),
]);

const normalizationProvenance = z
  .object({
    source: normalizationSource,
    adapter: z.object({ id: safeText, version: safeText }).strict(),
  })
  .strict();

const evidenceV1 = z
  .object({
    format: z.literal('atif'),
    schema_version: z.literal('ATIF-v1.8'),
    provenance: normalizationProvenance,
    completeness: z.enum(['complete', 'partial', 'fallback']),
    warnings: z.array(normalizationWarning),
    redaction_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const fallbackSource =
      value.provenance.source.kind === 'driver_fallback' ||
      value.provenance.source.kind === 'role_player_error';
    const fallbackCompleteness = value.completeness === 'fallback';
    if (fallbackSource !== fallbackCompleteness) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completeness'],
        message:
          'fallback provenance and fallback completeness must be used together',
      });
    }
    if (value.completeness === 'complete' && value.warnings.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warnings'],
        message: 'complete evidence cannot contain normalization warnings',
      });
    }
    if (value.completeness === 'partial' && value.warnings.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warnings'],
        message: 'partial evidence requires a normalization warning',
      });
    }
    if (
      value.completeness === 'fallback' &&
      !value.warnings.some((warning) => warning.code === 'fallback_used')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warnings'],
        message: 'fallback evidence requires a fallback_used warning',
      });
    }
    if (
      value.completeness !== 'fallback' &&
      value.warnings.some((warning) => warning.code === 'fallback_used')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warnings'],
        message: 'fallback_used warnings are valid only for fallback evidence',
      });
    }
  });

const caseTagsResultSchema = z.record(
  z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_]*$/),
  z.string().min(1).max(256),
);

const runResultFields = {
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  selection: z.unknown().transform((value, context) => {
    try {
      return parseRunSelection(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid run selection.',
      });
      return z.NEVER;
    }
  }),
  case_tags: caseTagsResultSchema.optional(),
  forge: z
    .object({
      version: safeVersion,
      commit_sha: z.string().optional(),
      dirty: z.boolean().optional(),
      action_bundles: z
        .array(
          z
            .object({
              namespace: safeIdentifier,
              version: safeVersion,
              sha256: digest,
            })
            .strict(),
        )
        .min(1)
        .max(100)
        .superRefine((bundles, context) => {
          const seen = new Set<string>();
          for (const [index, bundle] of bundles.entries()) {
            if (seen.has(bundle.namespace)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'namespace'],
                message: 'Action bundle namespaces must be unique.',
              });
            }
            if (
              index > 0 &&
              bundles[index - 1]!.namespace >= bundle.namespace
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'namespace'],
                message: 'Action bundles must be in canonical namespace order.',
              });
            }
            seen.add(bundle.namespace);
          }
        })
        .optional(),
    })
    .strict(),
  runtime: z
    .object({
      adapter: safeText,
      runtime_id: safeText,
      platform: safeText,
      metadata: z.record(z.string(), z.string().max(64 * 1024)),
    })
    .strict(),
  agent: z
    .object({
      adapter: safeText,
      adapter_version: safeText,
      metadata: agentAdapterMetadataSchema.optional(),
      provider: safeText,
      model: safeText,
      session_id: z.string().max(4096).nullable(),
      cost_usd: z.number().finite().nonnegative().nullable(),
    })
    .strict(),
  completion_calls: z
    .array(completionCallSummary)
    .superRefine((calls, context) => {
      for (const [index, call] of calls.entries()) {
        if (call.sequence !== index + 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'sequence'],
            message:
              'Completion-call sequence must be contiguous and one-based.',
          });
        }
        if (call.status === 'succeeded' && call.error_code !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'error_code'],
            message: 'Successful completion calls cannot record an error code.',
          });
        }
        if (call.status === 'failed' && call.error_code === null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'error_code'],
            message: 'Failed completion calls require an error code.',
          });
        }
      }
    }),
  interaction: z
    .object({
      mode: z.enum(['multi_turn', 'one_shot']),
      turn_count: z.number().int().nonnegative(),
    })
    .strict(),
  failure: rolePlayerError.nullable(),
  evaluation: evaluationResultSchema,
  started_at: isoTimestamp,
  completed_at: isoTimestamp,
  duration_ms: z.number().int().nonnegative(),
  stop_reason: z.enum(['task_complete', 'max_turns', 'role_player_error']),
  artifacts: z.array(artifactDescriptor),
  supplemental_artifacts: z.array(artifactDescriptor),
  warnings: z.array(
    z
      .object({
        code: safeText,
        message: z
          .string()
          .min(1)
          .max(64 * 1024),
      })
      .strict(),
  ),
};

const runResultSchema = z
  .object({
    ...runResultFields,
    evidence: evidenceV1,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.stop_reason === 'role_player_error' && value.failure === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'role_player_error results require failure details.',
      });
    }
    if (value.stop_reason !== 'role_player_error' && value.failure !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Only role_player_error results may include failure details.',
      });
    }
    if (
      value.evidence.provenance.adapter.id !== value.agent.adapter ||
      value.evidence.provenance.adapter.version !== value.agent.adapter_version
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'provenance', 'adapter'],
        message:
          'Evidence provenance does not match the recorded agent adapter.',
      });
    }
    const sourceSessionId =
      'session_id' in value.evidence.provenance.source
        ? value.evidence.provenance.source.session_id
        : undefined;
    if (
      sourceSessionId !== undefined &&
      sourceSessionId !== value.agent.session_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'provenance', 'source', 'session_id'],
        message: 'Evidence provenance does not match the recorded session.',
      });
    }
  });

export function parseRunResult(input: unknown): RunResult {
  const { forge } = z
    .object({ forge: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(input);
  const { action_bundles: _actionBundles, ...identityFields } = forge;
  const identity = parseForgeBuildIdentity(identityFields);
  assertCompatibleForgeVersion(identity.version);
  return runResultSchema.parse(input) as RunResult;
}

export function parseEvaluationResult(input: unknown) {
  return evaluationResultSchema.parse(input);
}

export function parseInteractionArtifact(
  input: unknown,
  context: ForgeArtifactParseContext,
): InteractionArtifactV1 {
  assertArtifactContext(context);
  return interactionArtifactSchema.parse(input) as InteractionArtifactV1;
}

export function parseSetupArtifact(
  input: unknown,
  context: ForgeArtifactParseContext,
): SetupArtifactV1 {
  assertArtifactContext(context);
  return setupArtifactSchema.parse(input) as SetupArtifactV1;
}

/** @internal Strict wire parser used by completed-run verification. */
export function parseWorkspaceEvidence(
  input: unknown,
  context: ForgeArtifactParseContext,
): WorkspaceEvidenceV1 {
  assertArtifactContext(context);
  return workspaceEvidenceSchema.parse(input) as WorkspaceEvidenceV1;
}

export function parseJudgeEvidence(
  input: unknown,
  context: ForgeArtifactParseContext,
): JudgeEvidenceV1 {
  assertArtifactContext(context);
  const evidence = judgeEvidenceSchema.parse(input);

  const transcript = evidence.transcript;
  assertBoundedJsonValue(transcript.steps);
  const projection = parseJudgeTranscriptProjection({
    source: transcript.source,
    projectionId: transcript.projection_id,
    trajectoryScope: transcript.trajectory_scope,
    includedStepSources: transcript.included_step_sources,
    copiedContext: transcript.copied_context,
    includedFields: transcript.included_fields,
    transcriptJson: serializeCanonicalJson(transcript.steps),
    ...(transcript.warnings === undefined
      ? {}
      : { warnings: transcript.warnings }),
  });
  return {
    ...evidence,
    transcript: {
      ...transcript,
      steps: JSON.parse(projection.transcriptJson),
    },
  } as JudgeEvidenceV1;
}

function assertArtifactContext(context: ForgeArtifactParseContext): void {
  const parsed = z
    .object({ forgeVersion: safeVersion })
    .strict()
    .parse(context);
  assertCompatibleForgeVersion(parsed.forgeVersion);
}
