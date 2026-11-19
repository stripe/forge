/**
 * How an LLM judge answers a criterion when an experiment selects a method.
 * Without a method the judge returns the pass/fail judgment it always has.
 *
 * - `verbalized-sampling`: `candidates` complete candidate answers with
 *   probabilities in one response; each option's probability is the sum over
 *   the candidates selecting it, and the choice is derived from that.
 */
export type DecisionJudgeMode = 'verbalized-sampling';
export const DECISION_JUDGE_MODES: readonly DecisionJudgeMode[] = [
  'verbalized-sampling',
];
export const MIN_VERBALIZED_SAMPLING_CANDIDATES = 2;
export const MAX_VERBALIZED_SAMPLING_CANDIDATES = 10;
export const DEFAULT_VERBALIZED_SAMPLING_CANDIDATES = 5;

/** A selected judge method with its candidate count. */
export interface DecisionJudgeMethod {
  readonly mode: DecisionJudgeMode;
  readonly candidates: number;
}

/** Validate a mode and optional candidate count from config or flags. */
export function decisionJudgeMethod(
  mode: unknown,
  candidates?: unknown,
): DecisionJudgeMethod {
  if (!(DECISION_JUDGE_MODES as readonly unknown[]).includes(mode))
    throw new TypeError(
      `Judge mode must be one of: ${DECISION_JUDGE_MODES.join(', ')}.`,
    );
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
 * The method an experiment or plan judge reference selects, or `undefined`
 * for the default pass/fail judge, so references written before methods
 * existed keep their meaning.
 */
export function judgeMethodOf(judge: {
  readonly mode?: DecisionJudgeMode;
  readonly candidates?: number;
}): DecisionJudgeMethod | undefined {
  if (judge.mode === undefined) {
    if (judge.candidates !== undefined)
      throw new TypeError(
        'Judge candidates apply only to verbalized-sampling.',
      );
    return undefined;
  }
  return decisionJudgeMethod(judge.mode, judge.candidates);
}
