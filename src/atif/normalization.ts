import {z} from 'zod';

import {parseAtifTrajectory} from './parser.js';
import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectoryV1_8,
} from './types.js';

/**
 * Version of Forge's native-log-to-ATIF mapping semantics. It is deliberately
 * independent from the upstream ATIF schema version.
 */
export const ATIF_NORMALIZATION_VERSION = 2 as const;

const MAX_METADATA_TEXT_LENGTH = 4_096;
const MAX_WARNING_MESSAGE_LENGTH = 64 * 1_024;
const MAX_WARNINGS = 100_000;

const MetadataTextSchema = z.string().min(1).max(MAX_METADATA_TEXT_LENGTH);

const NormalizationSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('native_log'),
      format: MetadataTextSchema,
      sessionId: MetadataTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('atif'),
      format: z.literal('atif'),
      schemaVersion: MetadataTextSchema,
      sessionId: MetadataTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('driver_fallback'),
      format: z.literal('forge-driver-turns'),
      sessionId: MetadataTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('role_player_error'),
      format: z.literal('forge-system-event'),
    })
    .strict(),
]);

const NormalizationWarningSchema = z
  .object({
    code: z.enum([
      'source_unavailable',
      'source_invalid',
      'source_incomplete',
      'unsupported_native_event',
      'fallback_used',
      'value_omitted',
    ]),
    message: z.string().min(1).max(MAX_WARNING_MESSAGE_LENGTH),
    path: MetadataTextSchema.optional(),
  })
  .strict();

const NormalizedTrajectorySchema = z
  .object({
    format: z.literal('atif'),
    schemaVersion: z.literal(ATIF_SCHEMA_VERSION),
    normalizationVersion: z.literal(ATIF_NORMALIZATION_VERSION),
    trajectory: z.unknown(),
    provenance: z
      .object({
        source: NormalizationSourceSchema,
        adapter: z
          .object({id: MetadataTextSchema, version: MetadataTextSchema})
          .strict(),
      })
      .strict(),
    completeness: z.enum(['complete', 'partial', 'fallback']),
    warnings: z.array(NormalizationWarningSchema).max(MAX_WARNINGS),
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

export type AtifNormalizationSource =
  | {
      kind: 'native_log';
      /** Agent-native format identifier, such as claude-code-jsonl. */
      format: string;
      sessionId?: string;
    }
  | {
      kind: 'atif';
      format: 'atif';
      /** Exact discriminator on the source document before any upgrade. */
      schemaVersion: string;
      sessionId?: string;
    }
  | {
      kind: 'driver_fallback';
      format: 'forge-driver-turns';
      sessionId?: string;
    }
  | {
      kind: 'role_player_error';
      format: 'forge-system-event';
    };

export interface AtifNormalizationProvenance {
  source: AtifNormalizationSource;
  /** Adapter implementation, not the coding-agent binary identified by ATIF. */
  adapter: {
    id: string;
    version: string;
  };
}

export type AtifNormalizationWarningCode =
  | 'source_unavailable'
  | 'source_invalid'
  | 'source_incomplete'
  | 'unsupported_native_event'
  | 'fallback_used'
  | 'value_omitted';

export interface AtifNormalizationWarning {
  code: AtifNormalizationWarningCode;
  message: string;
  /** Agent-native location or normalized ATIF field path, when known. */
  path?: string;
}

export type AtifNormalizationCompleteness =
  | 'complete'
  | 'partial'
  | 'fallback';

/**
 * In-memory evidence envelope. Persist trajectory as standalone
 * `trajectory.json`; persist the other fields alongside its descriptor in the
 * Forge run record so generic ATIF consumers do not need to unwrap it.
 */
export interface NormalizedTrajectory {
  format: 'atif';
  schemaVersion: typeof ATIF_SCHEMA_VERSION;
  normalizationVersion: typeof ATIF_NORMALIZATION_VERSION;
  trajectory: AtifTrajectoryV1_8;
  provenance: AtifNormalizationProvenance;
  completeness: AtifNormalizationCompleteness;
  warnings: AtifNormalizationWarning[];
}

export interface CreateNormalizedTrajectoryInput {
  trajectory: unknown;
  provenance: AtifNormalizationProvenance;
  completeness: AtifNormalizationCompleteness;
  warnings?: readonly AtifNormalizationWarning[];
}

export type NormalizedTrajectoryValidationPath = readonly (string | number)[];

export interface NormalizedTrajectoryValidationIssue {
  readonly path: NormalizedTrajectoryValidationPath;
  readonly message: string;
}

export class NormalizedTrajectoryValidationError extends Error {
  readonly code = 'invalid_normalized_trajectory' as const;
  readonly issues: readonly NormalizedTrajectoryValidationIssue[];

  constructor(issues: readonly NormalizedTrajectoryValidationIssue[]) {
    super(
      `Normalized trajectory validation failed with ${issues.length} issue${
        issues.length === 1 ? '' : 's'
      }.`,
    );
    this.name = 'NormalizedTrajectoryValidationError';
    this.issues = issues.map((issue) => ({...issue, path: [...issue.path]}));
  }
}

/** Parse the complete adapter-to-engine evidence envelope at runtime. */
export function parseNormalizedTrajectory(input: unknown): NormalizedTrajectory {
  const result = NormalizedTrajectorySchema.safeParse(input);
  if (!result.success) {
    throw new NormalizedTrajectoryValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === 'number' || typeof segment === 'string'
            ? segment
            : String(segment),
        ),
        message: issue.message,
      })),
    );
  }

  return {
    format: result.data.format,
    schemaVersion: result.data.schemaVersion,
    normalizationVersion: result.data.normalizationVersion,
    trajectory: parseAtifTrajectory(result.data.trajectory),
    provenance: result.data.provenance as AtifNormalizationProvenance,
    completeness: result.data.completeness,
    warnings: result.data.warnings as AtifNormalizationWarning[],
  };
}

/** Validate and wrap one adapter-produced canonical trajectory. */
export function createNormalizedTrajectory(
  input: CreateNormalizedTrajectoryInput,
): NormalizedTrajectory {
  return parseNormalizedTrajectory({
    format: 'atif',
    schemaVersion: ATIF_SCHEMA_VERSION,
    normalizationVersion: ATIF_NORMALIZATION_VERSION,
    trajectory: input.trajectory,
    provenance: input.provenance,
    completeness: input.completeness,
    warnings: input.warnings ?? [],
  });
}
