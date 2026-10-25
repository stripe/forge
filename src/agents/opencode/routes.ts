/**
 * Host-side per-model endpoint routing for OpenCode.
 *
 * `OPENCODE_MODEL_ROUTES` maps exact experiment model names to named endpoints,
 * for example `qwen/qwen4-coder=openrouter,kimi-k3=openrouter`. Each named
 * endpoint reads `OPENCODE_ENDPOINT_<NAME>_BASE_URL` and its key from
 * `OPENCODE_ENDPOINT_<NAME>_API_KEY`. Models without a route use the default
 * `OPENCODE_BASE_URL` and `OPENCODE_API_KEY`. Routing is host configuration:
 * experiment files and resolved plans do not record it.
 */

export const OPENCODE_MODEL_ROUTES_ENVIRONMENT = 'OPENCODE_MODEL_ROUTES';
const ENDPOINT_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** One routed model's endpoint; the credential is a host binding reference. */
export interface OpenCodeModelRoute {
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly credential: string;
}

export interface OpenCodeModelRouting {
  readonly routes: Readonly<Record<string, OpenCodeModelRoute>>;
  /** Credential reference → environment variable name, for the CLI resolver. */
  readonly credentialBindings: Readonly<Record<string, string>>;
}

export class OpenCodeRouteConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeRouteConfigurationError';
  }
}

/** Pure parse of the routing environment; absent routes mean no overrides. */
export function parseOpenCodeModelRoutes(
  environment: Readonly<Record<string, string | undefined>>,
): OpenCodeModelRouting {
  const raw = environment[OPENCODE_MODEL_ROUTES_ENVIRONMENT]?.trim();
  if (!raw) return { routes: {}, credentialBindings: {} };
  const routes: Record<string, OpenCodeModelRoute> = {};
  const credentialBindings: Record<string, string> = {};
  for (const entry of raw.split(/[,\n]/)) {
    const pair = entry.trim();
    if (!pair) continue;
    const separator = pair.lastIndexOf('=');
    const model = separator < 1 ? '' : pair.slice(0, separator).trim();
    const endpoint = pair
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (
      !model ||
      /[\u0000-\u001f\u007f]/.test(model) ||
      !ENDPOINT_NAME.test(endpoint)
    )
      throw new OpenCodeRouteConfigurationError(
        `${OPENCODE_MODEL_ROUTES_ENVIRONMENT} entries must be <model>=<endpoint>, with an endpoint of lowercase letters, digits, and underscores: ${JSON.stringify(pair)}`,
      );
    if (Object.hasOwn(routes, model))
      throw new OpenCodeRouteConfigurationError(
        `${OPENCODE_MODEL_ROUTES_ENVIRONMENT} routes ${model} more than once.`,
      );
    const prefix = `OPENCODE_ENDPOINT_${endpoint.toUpperCase()}`;
    const baseUrl = environment[`${prefix}_BASE_URL`];
    if (!baseUrl)
      throw new OpenCodeRouteConfigurationError(
        `Model ${model} routes to endpoint ${endpoint}, but ${prefix}_BASE_URL is not set.`,
      );
    const credential = `opencode.endpoint.${endpoint}.api-key`;
    credentialBindings[credential] = `${prefix}_API_KEY`;
    routes[model] = Object.freeze({ endpoint, baseUrl, credential });
  }
  return {
    routes: Object.freeze(routes),
    credentialBindings: Object.freeze(credentialBindings),
  };
}
