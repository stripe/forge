import { z } from 'zod';
import { ModelProfileSchema, ModelProfileShapeSchema } from './parse.ts';
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
  disable_experimental_betas?: true | undefined;
  context_window_tokens?: number | undefined;
  model_profile?: AgentSelectionV1['model_profile'] | undefined;
  endpoint?: string | undefined;
  upstream_providers?: readonly string[] | undefined;
}): string {
  const key: unknown[] = [
    agent.adapter,
    agent.provider,
    agent.model,
    agent.hook_trust ?? (agent.adapter === 'codex' ? 'native' : null),
    ...(agent.disable_experimental_betas === undefined ? [] : [true]),
    agent.model_profile === undefined
      ? null
      : schemaIdentityValues(
          ModelProfileShapeSchema,
          ModelProfileSchema.parse(agent.model_profile),
        ),
  ];
  // Appended only when authored, so existing keys keep their bytes.
  if (agent.endpoint !== undefined || agent.upstream_providers !== undefined)
    key.push(agent.endpoint ?? null);
  if (agent.upstream_providers !== undefined)
    key.push(agent.upstream_providers);
  // Claude Code only, so it never shares a position with the OpenCode fields.
  if (agent.context_window_tokens !== undefined)
    key.push(agent.context_window_tokens);
  return JSON.stringify(key);
}

// Preserve the existing flat key format, visiting fields in schema order rather
// than authored object order. New schema fields automatically enter identity.
function schemaIdentityValues(schema: z.ZodType, value: unknown): unknown[] {
  // An absent optional field adds nothing, so keys authored before it existed
  // keep their bytes.
  if (schema instanceof z.ZodOptional)
    return value === undefined
      ? []
      : schemaIdentityValues(schema.unwrap() as z.ZodType, value);
  if (schema instanceof z.ZodObject) {
    const object = value as Record<string, unknown>;
    return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(
      ([key, field]) => schemaIdentityValues(field, object[key]),
    );
  }
  return [value];
}
