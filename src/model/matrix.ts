import type {
  AgentSelectionV1,
  ExperimentMatrixGroupV1,
  ExperimentMatrixV1,
} from './types.ts';

/** Read both authored matrix forms without flattening their group boundaries. */
export function getMatrixGroups(
  matrix: ExperimentMatrixV1,
): readonly ExperimentMatrixGroupV1[] {
  if (matrix.groups !== undefined) return matrix.groups;
  return [
    {
      cases: matrix.cases,
      treatments: matrix.treatments,
      agents: matrix.agents,
    },
  ];
}

/** @internal Agent identity after the same defaults used by plan resolution. */
export function agentSelectionKey(agent: {
  adapter: string;
  provider: string;
  model: string;
  hook_trust?: 'native' | 'automation' | undefined;
  model_profile?: AgentSelectionV1['model_profile'] | undefined;
}): string {
  return JSON.stringify([
    agent.adapter,
    agent.provider,
    agent.model,
    agent.hook_trust ?? (agent.adapter === 'codex' ? 'native' : null),
    agent.model_profile === undefined
      ? null
      : [
          agent.model_profile.limit.context,
          agent.model_profile.limit.output,
          agent.model_profile.reasoning,
          agent.model_profile.temperature,
          agent.model_profile.attachment,
        ],
  ]);
}
