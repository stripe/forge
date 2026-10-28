import type { ForgeComposition } from '../contracts/composition.ts';
import type { ModelProbe } from '../contracts/modelProbe.ts';
import { completionBindingsForPlan } from '../execution/completionRuntime.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';

export interface SelectedModelProbe {
  readonly purpose: 'agent' | 'role_player' | 'judge';
  readonly adapter?: string;
  readonly provider: string;
  readonly model: string;
  readonly probe: ModelProbe;
  readonly composition: ForgeComposition;
}

/** Deduplicate across cases, treatments, repetitions and validation platforms. */
export function selectedModelProbes(
  requests: readonly {
    plan: ResolvedRunPlanV1;
    composition: ForgeComposition;
  }[],
): readonly SelectedModelProbe[] {
  const selected = new Map<string, SelectedModelProbe>();
  for (const { plan, composition } of requests) {
    const agent = composition.agents.get(plan.agent.adapter)!;
    const candidates: SelectedModelProbe[] = [
      {
        purpose: 'agent',
        adapter: agent.id,
        provider: plan.agent.provider,
        model: plan.agent.model,
        probe: availableProbe(() => agent.probeModel?.(plan.agent)),
        composition,
      },
    ];
    for (const { purpose, model, provider } of completionBindingsForPlan(
      plan,
      composition,
    )) {
      candidates.push({
        purpose,
        ...model,
        probe: availableProbe(() => provider.probeModel?.({ purpose, model })),
        composition,
      });
    }
    for (const candidate of candidates) {
      const key = JSON.stringify([
        candidate.purpose,
        candidate.adapter,
        candidate.provider,
        candidate.model,
        candidate.probe.endpoint,
      ]);
      if (!selected.has(key)) selected.set(key, candidate);
    }
  }
  return [...selected.values()];
}

function availableProbe(create: () => ModelProbe | undefined): ModelProbe {
  try {
    const probe = create();
    if (
      probe &&
      typeof probe.endpoint === 'string' &&
      typeof probe.run === 'function'
    )
      return probe;
  } catch {
    // Factory failures are isolated to this selected model, just like call failures.
  }
  return {
    endpoint: '',
    run: async () => ({ outcome: 'other', reason: 'probe_unavailable' }),
  };
}
