import type { ExperimentMatrixGroupV1, ExperimentMatrixV1 } from './types.ts';

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
}): string {
  return JSON.stringify([
    agent.adapter,
    agent.provider,
    agent.model,
    agent.hook_trust ?? (agent.adapter === 'codex' ? 'native' : null),
  ]);
}
