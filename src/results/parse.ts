import {z} from 'zod';

import {parseRunSelection} from '../model/index.js';
import {
  EVALUATION_SCHEMA_VERSION,
  RUN_RESULT_SCHEMA_VERSION,
  type RunResult,
} from './types.js';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const safeText = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const isoTimestamp = z.string().datetime({offset: true});

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
]);

const normalizationProvenance = z.object({
  source: normalizationSource,
  adapter: z.object({id: safeText, version: safeText}).strict(),
}).strict();

const evidenceV1 = z.object({
  format: z.literal('atif'),
  schema_version: z.literal('ATIF-v1.8'),
  normalization_version: z.literal(1),
  provenance: normalizationProvenance,
  completeness: z.enum(['complete', 'partial', 'fallback']),
  warnings: z.array(normalizationWarning),
  redaction_count: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  const fallbackSource = value.provenance.source.kind === 'driver_fallback';
  const fallbackCompleteness = value.completeness === 'fallback';
  if (fallbackSource !== fallbackCompleteness) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completeness'],
      message:
        'driver_fallback provenance and fallback completeness must be used together',
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
  evaluation: evaluationResultSchema,
  started_at: isoTimestamp,
  completed_at: isoTimestamp,
  duration_ms: z.number().int().nonnegative(),
  stop_reason: z.literal('completed'),
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
    const sourceSessionId = value.evidence.provenance.source.session_id;
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
