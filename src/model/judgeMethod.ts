/**
 * How an LLM judge answers each Choice question:
 * - `direct`: one distribution, no explanation (the SystemOne answer shape).
 * - `explained`: one distribution and one explanation (the default).
 * - `option-critique`: evidence for and against every option, with a
 *   probability per option; the distribution is their normalization.
 * - `verbalized-sampling`: `candidates` complete candidate answers with
 *   probabilities in one response; each option's probability is the sum over
 *   the candidates selecting it, and the choice is derived from that.
 */
export type DecisionJudgeMode =
  | 'direct'
  | 'explained'
  | 'option-critique'
  | 'verbalized-sampling';
export const DECISION_JUDGE_MODES: readonly DecisionJudgeMode[] = [
  'direct',
  'explained',
  'option-critique',
  'verbalized-sampling',
];
export const DEFAULT_DECISION_JUDGE_MODE: DecisionJudgeMode = 'explained';
export const MIN_VERBALIZED_SAMPLING_CANDIDATES = 2;
export const MAX_VERBALIZED_SAMPLING_CANDIDATES = 10;
export const DEFAULT_VERBALIZED_SAMPLING_CANDIDATES = 5;
/** Names recorded by earlier regrades. */
export const LEGACY_DECISION_JUDGE_MODES: Readonly<
  Record<string, DecisionJudgeMode>
> = Object.freeze({ standard: 'explained', verbalized: 'option-critique' });

/** A judge mode with its candidate count; only verbalized sampling has one. */
export interface DecisionJudgeMethod {
  readonly mode: DecisionJudgeMode;
  readonly candidates?: number;
}

/** Validate and default a mode and optional candidate count from config or flags. */
export function decisionJudgeMethod(
  mode: unknown = DEFAULT_DECISION_JUDGE_MODE,
  candidates?: unknown,
): DecisionJudgeMethod {
  if (!(DECISION_JUDGE_MODES as readonly unknown[]).includes(mode))
    throw new TypeError(
      `Judge mode must be one of: ${DECISION_JUDGE_MODES.join(', ')}.`,
    );
  if (mode !== 'verbalized-sampling') {
    if (candidates !== undefined)
      throw new TypeError(
        'Judge candidates apply only to verbalized-sampling.',
      );
    return { mode: mode as DecisionJudgeMode };
  }
  const count = candidates ?? DEFAULT_VERBALIZED_SAMPLING_CANDIDATES;
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < MIN_VERBALIZED_SAMPLING_CANDIDATES ||
    count > MAX_VERBALIZED_SAMPLING_CANDIDATES
  )
    throw new TypeError(
      `Judge candidates must be an integer from ${MIN_VERBALIZED_SAMPLING_CANDIDATES} to ${MAX_VERBALIZED_SAMPLING_CANDIDATES}.`,
    );
  return { mode: 'verbalized-sampling', candidates: count };
}

/**
 * The method an experiment or plan judge reference selects. Absent fields mean
 * the default, so references written before methods existed keep their meaning.
 */
export function judgeMethodOf(judge: {
  readonly mode?: DecisionJudgeMode;
  readonly candidates?: number;
}): DecisionJudgeMethod {
  return decisionJudgeMethod(judge.mode, judge.candidates);
}
