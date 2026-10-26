import { z } from 'zod';

export const attemptTimestampSchema = z.string().datetime();
const elapsed = z.number().finite().nonnegative();
export const attemptTimingSchema = z
  .object({
    reserved_at: attemptTimestampSchema,
    started_at: attemptTimestampSchema.optional(),
    failure_observed_at: attemptTimestampSchema.optional(),
    cleanup_completed_at: attemptTimestampSchema.optional(),
    finished_at: attemptTimestampSchema.optional(),
    failure_observed_elapsed_ms: elapsed.optional(),
    cleanup_completed_elapsed_ms: elapsed.optional(),
    finished_elapsed_ms: elapsed.optional(),
  })
  .strict();
export type AttemptTiming = z.infer<typeof attemptTimingSchema>;
