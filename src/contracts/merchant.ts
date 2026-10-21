import {
  type CredentialReference,
  type CredentialResolutionContext,
  type CredentialResolver,
  credentialReference,
} from './credentials.ts';

/** The merchant key's only runtime name; agent code and plugins read it. */
export const MERCHANT_ENVIRONMENT_VARIABLE = 'STRIPE_API_KEY';

const MERCHANT_REFERENCE_PREFIX = 'stripe-merchant:';

/** @internal Opaque reference Forge declares for an experiment merchant. */
export function merchantCredentialReference(
  recipe: string,
): CredentialReference {
  return credentialReference(`${MERCHANT_REFERENCE_PREFIX}${recipe}`);
}

/** @internal */
export function isMerchantCredentialReference(reference: string): boolean {
  return reference.startsWith(MERCHANT_REFERENCE_PREFIX);
}

/** Host-owned merchant provisioning composed with an existing resolver. */
export interface MerchantCredentialResolverOptions {
  /** Return a Stripe API key for one run, before its runtime is allocated. */
  provision(
    recipe: string,
    context: CredentialResolutionContext,
  ): Promise<string>;
  /** Resolves every other reference, such as completion-provider keys. */
  readonly fallback: CredentialResolver;
}

/** Route experiment merchant references to a host-owned provisioner. */
export function createMerchantCredentialResolver(
  options: MerchantCredentialResolverOptions,
): CredentialResolver {
  return {
    resolve(reference, context) {
      return isMerchantCredentialReference(reference)
        ? options.provision(
            reference.slice(MERCHANT_REFERENCE_PREFIX.length),
            context,
          )
        : options.fallback.resolve(reference, context);
    },
  };
}
