import { getMatrixGroups } from './model/matrix.ts';
import { parseExperimentConfig } from './model/parse.ts';
import type { LoadedExperimentConfigV1 } from './model/types.ts';

/** Resolve explicit CLI overrides before planning; core parsing stays ambient-free. */
export function resolveCliRuntime(
  experiment: LoadedExperimentConfigV1,
  environment: Readonly<Record<string, string | undefined>>,
  parseEffectiveConfig: typeof parseExperimentConfig = parseExperimentConfig,
): LoadedExperimentConfigV1 {
  const output = structuredClone(experiment);
  const disableBetas = environment.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
  if (disableBetas !== undefined) {
    if (disableBetas !== '1' && disableBetas !== '0')
      throw new TypeError(
        'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS must be 1 or 0.',
      );
    const claudeAgents = getMatrixGroups(output.config.matrix).flatMap(
      (group) =>
        group.agents.filter((agent) => agent.adapter === 'claude-code'),
    );
    for (const agent of claudeAgents) {
      if (disableBetas === '1') agent.disable_experimental_betas = true;
      else delete agent.disable_experimental_betas;
    }
    // Overrides can collapse otherwise distinct agent coordinates or groups.
    if (claudeAgents.length > 0)
      output.config = parseEffectiveConfig(output.config);
  }
  return output;
}
