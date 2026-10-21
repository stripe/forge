import type { AgentAdapter } from './agent.ts';
import type { RunArtifactContributor, RunArtifactStore } from './artifacts.ts';
import type {
  CompletionProvider,
  CompletionProviderResolver,
} from './completion.ts';
import type { CredentialResolver } from './credentials.ts';
import type { RunInputProvider } from './inputs.ts';
import type { StripeKeyProvisioner } from './merchant.ts';
import type { RunObserver } from './observability.ts';
import type { RuntimeAdapter } from './runtime.ts';

export type CompletionProviderCollection =
  | ReadonlyMap<string, CompletionProvider>
  | CompletionProviderResolver;

/**
 * All environment-varying authority supplied to Forge's shared lifecycle.
 * There is no service discovery or implicit import of private implementations.
 */
export interface ForgeComposition {
  readonly runtime: RuntimeAdapter;
  readonly agents: ReadonlyMap<string, AgentAdapter>;
  readonly completionProviders?: CompletionProviderCollection;
  /** Looks up existing secrets by opaque reference, without side effects. */
  readonly credentialResolver: CredentialResolver;
  /** Required by plans that declare an experiment merchant. */
  readonly stripeKeyProvisioner?: StripeKeyProvisioner;
  readonly inputProvider: RunInputProvider;
  readonly artifactStore: RunArtifactStore;
  readonly observer?: RunObserver;
  readonly contributors?: readonly RunArtifactContributor[];
}
