import { z } from 'zod';

/** Registered bundled connections; authentication belongs to Forge, not YAML. */
export const PluginMcpServerSchema = z.enum(['stripe']);
export type PluginMcpServerId = z.infer<typeof PluginMcpServerSchema>;

export const PluginMcpServersSchema = z
  .array(PluginMcpServerSchema)
  .min(1)
  .max(100)
  .refine(
    (servers) => new Set(servers).size === servers.length,
    'must not repeat an MCP server',
  );
