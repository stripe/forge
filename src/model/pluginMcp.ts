import { z } from 'zod';
import { isSafeSimpleIdentifier } from './paths.ts';

export const PluginMcpServersSchema = z
  .record(
    z
      .string()
      .refine(isSafeSimpleIdentifier, 'must be a safe server identifier'),
    z
      .object({
        bearer_token: z
          .object({
            env: z
              .string()
              .max(128)
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          })
          .strict(),
      })
      .strict(),
  )
  .refine(
    (servers) =>
      Object.keys(servers).length > 0 && Object.keys(servers).length <= 100,
    'must contain a bounded non-empty server map',
  );
