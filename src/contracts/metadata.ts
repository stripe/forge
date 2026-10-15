import { z } from 'zod';

/** Non-sensitive configuration distinctions recorded independently of releases. */
export interface AgentAdapterMetadata {
  readonly endpoint_mode: 'default' | 'custom';
  readonly layout_mode: 'default' | 'custom';
}

export interface CompletionProviderMetadata {
  readonly endpoint_mode: 'default' | 'custom';
}

const mode = z.enum(['default', 'custom']);

/** Internal shared boundaries for preflight snapshots and persisted records. */
export const agentAdapterMetadataSchema = z
  .object({
    endpoint_mode: mode,
    layout_mode: mode,
  })
  .strict()
  .readonly();

export const completionProviderMetadataSchema = z
  .object({
    endpoint_mode: mode,
  })
  .strict()
  .readonly();
