import type { CredentialReference } from './credentials.ts';

/** API integrations an agent adapter can speak. */
export type ProviderIntegration = 'anthropic' | 'openai' | 'openai-compatible';

/**
 * Host configuration for one provider name. An experiment's
 * `agent.provider` is a stable logical name for a service or route, such as
 * `openrouter`; it is never a URL or credential. The host maps the name to
 * this configuration, so experiment files, plans, and results record only the
 * name. Forge does not capture the mapping, so the same name can reach
 * different hosts on different machines.
 *
 * The public defaults `anthropic`, `openai`, and `openai-compatible` are
 * provider names whose integration is themselves.
 */
export interface ProviderConfiguration {
  readonly integration: ProviderIntegration;
  /** HTTP(S) API root. Optional only where the integration has a public default. */
  readonly baseUrl?: string;
  /** Opaque host credential reference. Never the secret itself. */
  readonly credential?: string | CredentialReference;
}

/** Host-owned lookup from provider name to configuration. */
export interface ProviderLookup {
  get(name: string): ProviderConfiguration | undefined;
  /** Configured names, for diagnostics. */
  names(): readonly string[];
}

/** An immutable lookup over explicit entries. */
export function createProviderLookup(
  entries: Readonly<Record<string, ProviderConfiguration>>,
): ProviderLookup {
  const configurations = new Map(
    Object.entries(entries).map(([name, configuration]) => [
      name,
      Object.freeze({ ...configuration }),
    ]),
  );
  const names = Object.freeze([...configurations.keys()]);
  return Object.freeze({
    get: (name: string) => configurations.get(name),
    names: () => names,
  });
}

/**
 * A selected provider is unknown to the host or uses an integration the
 * adapter cannot speak. The message holds only logical names and integration
 * types, so callers may show it verbatim.
 */
export class ProviderConfigurationError extends TypeError {
  constructor(
    message: string,
    readonly reason: 'unknown_provider' | 'unsupported_integration',
    readonly provider: string,
    readonly adapter: string,
  ) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

const MAX_LISTED_NAMES = 16;

/**
 * Resolve an authored provider name for an adapter that supports the given
 * integrations. Messages contain only logical names, never URLs or credentials.
 */
export function resolveProvider(
  lookup: ProviderLookup,
  adapter: string,
  name: string,
  supported: readonly ProviderIntegration[],
): ProviderConfiguration {
  const configuration = lookup.get(name);
  if (configuration === undefined) {
    const names = lookup.names();
    const listed = names.slice(0, MAX_LISTED_NAMES).join(', ');
    throw new ProviderConfigurationError(
      `Provider ${JSON.stringify(name)} is not configured for ${adapter}${
        names.length === 0
          ? '.'
          : `; configured providers: ${listed}${names.length > MAX_LISTED_NAMES ? ', ...' : ''}.`
      }`,
      'unknown_provider',
      name,
      adapter,
    );
  }
  if (!supported.includes(configuration.integration)) {
    throw new ProviderConfigurationError(
      `Provider ${JSON.stringify(name)} uses the ${configuration.integration} integration, which ${adapter} does not support; it requires ${supported.join(' or ')}.`,
      'unsupported_integration',
      name,
      adapter,
    );
  }
  return configuration;
}
