import { MODEL } from './configuration.mjs';

// Native structured output must produce valid JSON even when the prompt asks
// for a backslash before a Markdown backtick, which is not a JSON escape.
export async function runCriterionJudgmentRegression(
  forge,
  { provider, credentialResolver, runId, signal },
) {
  const model = { provider: provider.id, model: MODEL };
  const requirements = provider.requirements({ model, purpose: 'judge' });
  const credentials = Object.fromEntries(
    await Promise.all(
      Object.entries(requirements.credentials).map(
        async ([name, requirement]) => [
          name,
          await credentialResolver.resolve(requirement.reference, { signal }),
        ],
      ),
    ),
  );
  await provider.preflight?.({
    runId,
    model,
    purpose: 'judge',
    credentials,
    signal,
  });
  const response = await provider
    .complete(
      {
        runId,
        purpose: 'judge',
        model,
        systemPrompt:
          'Return one structured choice answer for criterion. Choose met with probability 1 and confidence 1; set the other probabilities to 0.',
        messages: [
          {
            role: 'user',
            content:
              'Copy this object exactly, including every backslash in the explanation: ' +
              '{"answers":{"criterion":{"type":"choice","choice":"met","probabilities":{"met":1,"not_met":0,"insufficient_evidence":0},"confidence":1,"explanation":"Missing \\`cancel_url\\`."}}}',
          },
        ],
        temperature: 0,
        maxTokens: 1024,
        responseSchema: forge.CRITERION_JUDGMENT_RESPONSE_SCHEMA,
        signal,
      },
      { credentials },
    )
    .catch((error) => {
      if (error?.code === 'invalid_output') {
        throw Object.assign(
          new Error(
            'The live JSON escape check returned malformed structured output.',
          ),
          { code: 'invalid_output' },
        );
      }
      throw error;
    });
  const judgment = forge.parseCriterionJudgment(response.content, {
    value: 'Synthetic JSON escape check.',
  });
  if (response.stopReason !== 'end_turn' || judgment.passed !== true) {
    throw new Error(
      'The live JSON escape check did not return a valid completed judgment.',
    );
  }
  return Object.freeze({
    verified: true,
    valid_json: true,
    local_judgment_validation: true,
  });
}
