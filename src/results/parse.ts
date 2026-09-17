import {z} from 'zod';

import {parseRunSelection} from '../model/index.js';
import {
  EVALUATION_SCHEMA_VERSION,
  INTERACTION_SCHEMA_VERSION,
  JUDGE_EVIDENCE_SCHEMA_VERSION,
  RUN_RESULT_SCHEMA_VERSION,
  type InteractionArtifactV1,
  type JudgeEvidenceV1,
  type RunResult,
} from './types.js';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const safeText = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const isoTimestamp = z.string().datetime({offset: true});
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

const checkResult = z.object({
  name: safeText,
  passed: z.boolean(),
  detail: z.string().max(64 * 1024).optional(),
}).strict();

const guidelineResult = z.object({
  guideline: z.string().min(1).max(64 * 1024),
  passed: z.boolean(),
  explanation: z.string().max(64 * 1024),
}).strict();

export const evaluationResultSchema = z.object({
  schema_version: z.literal(EVALUATION_SCHEMA_VERSION),
  score: z.number().finite().min(0).max(1),
  status: z.enum(['passed', 'partial', 'failed']),
  guidelines_passed: z.number().int().nonnegative(),
  guidelines_total: z.number().int().nonnegative(),
  guidelines: z.array(guidelineResult),
  checks: z.array(checkResult),
}).strict().superRefine((value, context) => {
  const passed = value.guidelines.filter((guideline) => guideline.passed).length;
  if (
    value.guidelines_total !== value.guidelines.length ||
    value.guidelines_passed !== passed
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Guideline totals do not match guideline results.',
    });
  }
});

const artifactDescriptor = z.object({
  path: safeText,
  media_type: safeText,
  size_bytes: z.number().int().nonnegative(),
  sha256: digest,
}).strict();

const rolePlayerError = z.object({
  status: z.literal('role_player_error'),
  error_type: z.enum(['parse_error', 'request_error']),
  attempts: z.number().int().positive(),
  explanation: z.string().min(1).max(64 * 1024),
}).strict();

const interactionToolCall = z.object({
  id: safeText.optional(),
  name: safeText,
  input: jsonValue.optional(),
}).strict();

const interactionTurn = z.object({
  turn: z.number().int().positive(),
  user: boundedArtifactText,
  assistant: boundedArtifactText,
  tool_calls: z.array(interactionToolCall).max(100_000),
}).strict();

const avaNeed = z.object({
  id: safeText,
  description: z.string().trim().min(1).max(240),
}).strict();

const avaDecision = z.object({
  sequence: z.number().int().positive(),
  after_agent_turn: z.number().int().positive().nullable(),
  message: z.string().max(500),
  stop: z.boolean(),
  remaining_need_ids: z.array(safeText).max(6).nullable(),
  focus_need_id: safeText.nullable(),
  coding_agent_invoked: z.boolean(),
  source: z.enum(['configured_initial_prompt', 'generated']),
  error: rolePlayerError.optional(),
}).strict();

const interactionArtifactSchema = z.object({
  schema_version: z.literal(INTERACTION_SCHEMA_VERSION),
  mode: z.enum(['multi_turn', 'one_shot']),
  stop_reason: z.enum(['task_complete', 'max_turns', 'role_player_error']),
  turns: z.array(interactionTurn).max(100),
  role_player: z.object({
    model: z.object({provider: safeText, model: safeText}).strict(),
    prompt_version: safeText,
    needs: z.array(avaNeed).max(6).nullable(),
    decisions: z.array(avaDecision).max(101),
  }).strict().optional(),
  failure: rolePlayerError.nullable(),
}).strict().superRefine((value, context) => {
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
  if ((value.stop_reason === 'role_player_error') !== (value.failure !== null)) {
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
  const invoked = decisions.filter(({coding_agent_invoked}) => coding_agent_invoked).length;
  if (value.role_player !== undefined && invoked !== value.turns.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['role_player', 'decisions'],
      message: 'Ava invocation decisions must match completed agent turns.',
    });
  }
});

const judgeEvidenceSchema = z.object({
  schema_version: z.literal(JUDGE_EVIDENCE_SCHEMA_VERSION),
  prompt_version: safeText,
  trajectory_sha256: digest,
  workspace: z.object({
    entries: z.array(z.object({
      path: safeText,
      content: z.string().max(20_000),
      truncated: z.boolean(),
    }).strict()).max(10_000),
    complete: z.boolean(),
    warnings: z.array(z.object({
      code: safeText,
      message: z.string().min(1).max(64 * 1024),
      path: safeText.optional(),
    }).strict()).max(10_000),
  }).strict(),
}).strict();

const completionCallSummary = z.object({
  sequence: z.number().int().positive(),
  purpose: z.enum(['role_player', 'judge']),
  provider: safeText,
  provider_version: safeText,
  model: safeText,
  status: z.enum(['succeeded', 'failed']),
  stop_reason: z.enum([
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'model_context_window_exceeded',
    'other',
  ]).nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  cached_tokens: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().finite().nonnegative().nullable(),
  error_code: safeText.nullable(),
}).strict();

const normalizationWarning = z.object({
  code: z.enum([
    'source_unavailable',
    'source_invalid',
    'source_incomplete',
    'unsupported_native_event',
    'fallback_used',
    'value_omitted',
  ]),
  message: z.string().min(1).max(64 * 1024),
  path: z.string().min(1).max(4096).optional(),
}).strict();

const normalizationSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('native_log'),
    format: safeText,
    session_id: safeText.optional(),
  }).strict(),
  z.object({
    kind: z.literal('atif'),
    format: z.literal('atif'),
    schema_version: safeText,
    session_id: safeText.optional(),
  }).strict(),
  z.object({
    kind: z.literal('driver_fallback'),
    format: z.literal('forge-driver-turns'),
    session_id: safeText.optional(),
  }).strict(),
  z.object({
    kind: z.literal('role_player_error'),
    format: z.literal('forge-system-event'),
  }).strict(),
]);

const normalizationProvenance = z.object({
  source: normalizationSource,
  adapter: z.object({id: safeText, version: safeText}).strict(),
}).strict();

const evidenceV1 = z.object({
  format: z.literal('atif'),
  schema_version: z.literal('ATIF-v1.8'),
  normalization_version: z.literal(2),
  provenance: normalizationProvenance,
  completeness: z.enum(['complete', 'partial', 'fallback']),
  warnings: z.array(normalizationWarning),
  redaction_count: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
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

const runResultFields = {
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  selection: z.unknown().transform((value, context) => {
    try {
      return parseRunSelection(value);
    } catch (error) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid run selection.'});
      return z.NEVER;
    }
  }),
  plan_sha256: digest,
  forge: z.object({version: safeText}).strict(),
  runtime: z.object({
    adapter: safeText,
    runtime_id: safeText,
    platform: safeText,
    metadata: z.record(z.string().max(64 * 1024)),
  }).strict(),
  agent: z.object({
    adapter: safeText,
    adapter_version: safeText,
    provider: safeText,
    model: safeText,
    session_id: z.string().max(4096).nullable(),
    cost_usd: z.number().finite().nonnegative().nullable(),
  }).strict(),
  completion_calls: z.array(completionCallSummary).superRefine((calls, context) => {
    for (const [index, call] of calls.entries()) {
      if (call.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'sequence'],
          message: 'Completion-call sequence must be contiguous and one-based.',
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
  interaction: z.object({
    mode: z.enum(['multi_turn', 'one_shot']),
    turn_count: z.number().int().nonnegative(),
  }).strict(),
  failure: rolePlayerError.nullable(),
  evaluation: evaluationResultSchema,
  started_at: isoTimestamp,
  completed_at: isoTimestamp,
  duration_ms: z.number().int().nonnegative(),
  stop_reason: z.enum(['task_complete', 'max_turns', 'role_player_error']),
  artifact_set_sha256: digest,
  artifacts: z.array(artifactDescriptor),
  supplemental_artifacts: z.array(artifactDescriptor),
  warnings: z.array(z.object({code: safeText, message: z.string().min(1).max(64 * 1024)}).strict()),
};

const runResultSchema = z.object({
  schema_version: z.literal(RUN_RESULT_SCHEMA_VERSION),
  ...runResultFields,
  evidence: evidenceV1,
}).strict()
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
        message: 'Evidence provenance does not match the recorded agent adapter.',
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
  return runResultSchema.parse(input) as RunResult;
}

export function parseEvaluationResult(input: unknown) {
  return evaluationResultSchema.parse(input);
}

export function parseInteractionArtifact(input: unknown): InteractionArtifactV1 {
  return interactionArtifactSchema.parse(input) as InteractionArtifactV1;
}

export function parseJudgeEvidence(input: unknown): JudgeEvidenceV1 {
  return judgeEvidenceSchema.parse(input) as JudgeEvidenceV1;
}
