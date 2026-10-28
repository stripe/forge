import { z } from 'zod';

export const mcpToolRefusalsSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('available'),
      count: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      reason: z.enum([
        'source_unavailable',
        'source_invalid',
        'source_incomplete',
      ]),
    })
    .strict(),
]);

export const mcpToolRefusalWarningSchema = z
  .object({
    code: z.literal('mcp_tool_refusals'),
    message: z.enum([
      'Native MCP calls were refused by the agent.',
      'Native MCP tool refusal counts are unavailable.',
    ]),
    mcp_tool_refusals: mcpToolRefusalsSchema,
  })
  .strict();

/** Invalid optional adapter observations cannot invalidate a scored run. */
export function mcpToolRefusalWarnings(
  value: unknown,
): z.infer<typeof mcpToolRefusalWarningSchema>[] {
  if (value === undefined) return [];
  const parsed = mcpToolRefusalsSchema.safeParse(value);
  const observation = parsed.success
    ? parsed.data
    : { state: 'unavailable' as const, reason: 'source_invalid' as const };
  if (observation.state === 'available' && observation.count === 0) return [];
  return [
    {
      code: 'mcp_tool_refusals',
      message:
        observation.state === 'available'
          ? 'Native MCP calls were refused by the agent.'
          : 'Native MCP tool refusal counts are unavailable.',
      mcp_tool_refusals: observation,
    },
  ];
}
