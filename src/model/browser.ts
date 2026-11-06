import { z } from 'zod';
import type {
  BrowserConfigV1,
  ExperimentConfigV1,
  SetupStepV1,
} from './types.ts';

export const BrowserIntegrationSchema = z
  .object({
    provider: z.literal('local'),
    controller: z.literal('playwright-mcp'),
  })
  .strict();

export const BrowserSetupWithSchema = z
  .object({
    access: z
      .object({
        agent: z.boolean().default(false),
        role_player: z.literal(false).default(false),
      })
      .strict()
      .prefault({}),
  })
  .strict();

const DEFAULT_BROWSER_INTEGRATION: Readonly<BrowserConfigV1['integration']> =
  Object.freeze({
    provider: 'local',
    controller: 'playwright-mcp',
  });

/** Resolve declared grants and a release-owned default before runtime authority. */
export function resolveBrowserConfig(
  steps: readonly SetupStepV1[],
  override: ExperimentConfigV1['browser'],
): BrowserConfigV1 | undefined {
  const requests = steps.filter((step) => step.uses === 'forge/browser');
  if (requests.length > 1)
    throw new TypeError(
      'At most one browser setup request is supported across case and treatment.',
    );
  if (!requests[0]) return undefined;
  const { access } = BrowserSetupWithSchema.parse(requests[0].with);
  if (!access.agent) return undefined;
  return {
    access,
    integration: { ...(override?.integration ?? DEFAULT_BROWSER_INTEGRATION) },
  };
}
