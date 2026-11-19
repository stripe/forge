# Archived candidate judgments

`archived-candidates.json` contains five saved criterion judgments from a
five-candidate verbalized-sampling regrade of archived Codex runs. The fixture
retains the candidate texts, labels, weights, aggregate decisions, and
explanations unchanged. It omits the shared evidence-warning reference,
transcripts, workspace evidence, credentials, and native logs. Run IDs and
zero-based criterion indexes identify each source judgment.

These examples cover unanimous agreement, all three labels, insufficient
evidence, and met/not-met decisions below the 0.80 annotation threshold.
Tests replay the candidates and assert the saved choice, probabilities,
confidence, threshold annotation, and leading-candidate rationale.
