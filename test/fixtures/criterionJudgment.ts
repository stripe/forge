/** Minimal synthetic model output; probabilities are independent of production policy. */
export function criterionJudgment(passed = true, explanation = 'Done.') {
  return {
    answers: {
      criterion: {
        type: 'choice' as const,
        choice: passed ? 'met' as const : 'not_met' as const,
        probabilities: {met: passed ? 1 : 0, not_met: passed ? 0 : 1, insufficient_evidence: 0},
        confidence: 1,
        explanation,
      },
    },
  };
}
