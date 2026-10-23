import { z } from 'zod';

const ProxyUrlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !/[\s\u0000-\u001f\u007f]/.test(value)
      );
    } catch {
      return false;
    }
  }, 'must be an HTTP proxy URL without credentials, query or fragment');

export const DockerProxySchema = z
  .object({
    http: ProxyUrlSchema.optional(),
    https: ProxyUrlSchema.optional(),
    no_proxy: z
      .string()
      .max(4096)
      .regex(/^[^\u0000-\u001f\u007f]*$/)
      .optional(),
  })
  .strict();

/** Docker build and common command-line clients use both spellings. */
export function dockerProxyEnvironment(
  proxy: z.infer<typeof DockerProxySchema> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [field, name] of [
    ['http', 'HTTP_PROXY'],
    ['https', 'HTTPS_PROXY'],
    ['no_proxy', 'NO_PROXY'],
  ] as const) {
    const value = proxy?.[field];
    if (value !== undefined) {
      result[name] = value;
      result[name.toLowerCase()] = value;
    }
  }
  return Object.freeze(result);
}
