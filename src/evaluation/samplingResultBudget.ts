import { MAX_RESULT_BYTES } from '../results/types.ts';
import { MAX_ASSESSMENT_ARGUMENT_CHARACTERS } from './decision.ts';

/**
 * Bytes one saved sampling candidate can take: a reading and a rationale at
 * their character caps plus the label, probability and keys around them.
 */
export const MAX_SAMPLING_CANDIDATE_RECORD_BYTES =
  2 * MAX_ASSESSMENT_ARGUMENT_CHARACTERS + 256;

/** Room kept in `result.json` for everything besides candidate records. */
export const SAMPLING_RESULT_RESERVE_BYTES = 64 * 1024;

/**
 * Why a sampling judge cannot be saved for this many criteria and candidates,
 * or `undefined` when the estimate fits `result.json`. Candidates are saved
 * whole, so the check runs before any paid work. The estimate counts each
 * character as one byte and leaves a fixed reserve for everything else, so it
 * rejects configurations that cannot fit; it is not an upper bound. Multi-byte
 * text, JSON escaping and per-criterion explanations can still push a result
 * over the store limit, which then fails the run as before.
 */
export function samplingResultBudgetIssue(
  criteria: number,
  candidates: number,
): string | undefined {
  const bytes = criteria * candidates * MAX_SAMPLING_CANDIDATE_RECORD_BYTES;
  const limit = MAX_RESULT_BYTES - SAMPLING_RESULT_RESERVE_BYTES;
  if (bytes <= limit) return undefined;
  return `${criteria} criteria judged by ${candidates} sampled candidates could take ${bytes} bytes of candidate records, over the ${limit}-byte share of the ${MAX_RESULT_BYTES}-byte result limit. Reduce the criteria or judge candidates.`;
}
