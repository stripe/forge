/**
 * Host-side endpoint mapping for OpenCode.
 *
 * An experiment's agent selection may name an `endpoint`. The name is
 * experiment config and is recorded in plans; the host alone maps it to an API
 * root and key. `OPENCODE_ENDPOINT_<NAME>_BASE_URL` sets the API root and
 * `OPENCODE_ENDPOINT_<NAME>_API_KEY` supplies the key through the credential
 * reference `opencode.endpoint.<name>.api-key`. URLs and keys are not
 * written into experiment files, plans, or results.
 */

const ENDPOINT_PREFIX = 'OPENCODE_ENDPOINT_';
const BASE_URL_SUFFIX = '_BASE_URL';
const API_KEY_SUFFIX = '_API_KEY';
const ENVIRONMENT_NAME = /^OPENCODE_ENDPOINT_([A-Z][A-Z0-9_]{0,62})_BASE_URL$/;
const REFERENCE = /^opencode\.endpoint\.([a-z][a-z0-9_]{0,62})\.api-key$/;

/** Authored endpoint names: lowercase letters, digits, and underscores. */
export const OPENCODE_ENDPOINT_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * A selected endpoint has no host base URL. The message is static apart from
 * the validated endpoint name, so callers may show it verbatim.
 */
export class OpenCodeEndpointConfigurationError extends Error {
  constructor(name: string) {
    super(
      OPENCODE_ENDPOINT_NAME.test(name)
        ? `OpenCode endpoint ${JSON.stringify(name)} is not configured: set ${openCodeEndpointBaseUrlEnvironment(name)}.`
        : 'OpenCode endpoint name is invalid.',
    );
    this.name = 'OpenCodeEndpointConfigurationError';
  }
}

export function openCodeEndpointBaseUrlEnvironment(name: string): string {
  return `${ENDPOINT_PREFIX}${name.toUpperCase()}${BASE_URL_SUFFIX}`;
}

/** One named endpoint; the credential is a host binding reference. */
export interface OpenCodeEndpoint {
  readonly baseUrl: string;
  readonly credential: string;
}

export function openCodeEndpointCredentialReference(name: string): string {
  return `opencode.endpoint.${name}.api-key`;
}

/** Host variable behind an endpoint credential reference, if it is one. */
export function openCodeEndpointCredentialEnvironment(
  reference: string,
): string | undefined {
  const name = REFERENCE.exec(reference)?.[1];
  return name === undefined
    ? undefined
    : `${ENDPOINT_PREFIX}${name.toUpperCase()}${API_KEY_SUFFIX}`;
}

/** Pure parse of the host environment; no endpoint variables means none. */
export function parseOpenCodeEndpoints(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, OpenCodeEndpoint>> {
  const endpoints: Record<string, OpenCodeEndpoint> = {};
  // Read values only for endpoint variables; never scan other host secrets.
  for (const variable of Object.keys(environment)) {
    if (
      !variable.startsWith(ENDPOINT_PREFIX) ||
      !variable.endsWith(BASE_URL_SUFFIX)
    )
      continue;
    const name = ENVIRONMENT_NAME.exec(variable)?.[1]?.toLowerCase();
    if (name === undefined)
      throw new TypeError(
        `${variable} does not name an endpoint: use OPENCODE_ENDPOINT_<NAME>_BASE_URL with an uppercase name of letters, digits, and underscores.`,
      );
    const baseUrl = environment[variable];
    if (!baseUrl) continue;
    endpoints[name] = Object.freeze({
      baseUrl,
      credential: openCodeEndpointCredentialReference(name),
    });
  }
  return Object.freeze(endpoints);
}
