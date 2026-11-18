/**
 * Host-side provider mapping for the OpenCode CLI composition.
 *
 * An experiment's agent selection names a `provider`, such as `openrouter`.
 * The name is experiment config and is recorded in plans; the host alone maps
 * it to an API root and key. `OPENCODE_PROVIDER_<NAME>_BASE_URL` configures an
 * `openai-compatible` provider and `OPENCODE_PROVIDER_<NAME>_API_KEY` supplies
 * its key through the credential reference `opencode.provider.<name>.api-key`.
 * URLs and keys are not written into experiment files, plans, or results.
 */
import type { ProviderConfiguration } from '../../contracts/providers.ts';

const PROVIDER_PREFIX = 'OPENCODE_PROVIDER_';
const BASE_URL_SUFFIX = '_BASE_URL';
const API_KEY_SUFFIX = '_API_KEY';
const ENVIRONMENT_NAME = /^OPENCODE_PROVIDER_([A-Z][A-Z0-9_]{0,62})_BASE_URL$/;
const REFERENCE = /^opencode\.provider\.([a-z][a-z0-9_]{0,62})\.api-key$/;

/** Environment-configured provider names: lowercase letters, digits, and underscores. */
export const OPENCODE_PROVIDER_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The host variable that configures the base URL for a provider name. */
export function openCodeProviderBaseUrlEnvironment(name: string): string {
  return `${PROVIDER_PREFIX}${name.toUpperCase()}${BASE_URL_SUFFIX}`;
}

export function openCodeProviderCredentialReference(name: string): string {
  return `opencode.provider.${name}.api-key`;
}

/** Host variable behind a provider credential reference, if it is one. */
export function openCodeProviderCredentialEnvironment(
  reference: string,
): string | undefined {
  const name = REFERENCE.exec(reference)?.[1];
  return name === undefined
    ? undefined
    : `${PROVIDER_PREFIX}${name.toUpperCase()}${API_KEY_SUFFIX}`;
}

/** Pure parse of the host environment; no provider variables means none. */
export function parseOpenCodeProviders(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, ProviderConfiguration>> {
  const providers: Record<string, ProviderConfiguration> = {};
  // Read values only for provider variables; never scan other host secrets.
  for (const variable of Object.keys(environment)) {
    if (
      !variable.startsWith(PROVIDER_PREFIX) ||
      !variable.endsWith(BASE_URL_SUFFIX)
    )
      continue;
    const name = ENVIRONMENT_NAME.exec(variable)?.[1]?.toLowerCase();
    if (name === undefined)
      throw new TypeError(
        `${variable} does not name a provider: use OPENCODE_PROVIDER_<NAME>_BASE_URL with an uppercase name of letters, digits, and underscores.`,
      );
    const baseUrl = environment[variable];
    if (!baseUrl) continue;
    providers[name] = Object.freeze({
      integration: 'openai-compatible',
      baseUrl,
      credential: openCodeProviderCredentialReference(name),
    });
  }
  return Object.freeze(providers);
}
