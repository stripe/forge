import type {AgentAdapter} from './agent.js';
import type {
  RunArtifactContributor,
  RunArtifactStore,
} from './artifacts.js';
import type {
  CompletionProvider,
  CompletionProviderResolver,
} from './completion.js';
import type {CredentialResolver} from './credentials.js';
import type {RunInputProvider} from './inputs.js';
import type {RunObserver} from './observability.js';
import type {RuntimeAdapter} from './runtime.js';

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
  readonly credentialResolver: CredentialResolver;
  readonly inputProvider: RunInputProvider;
  readonly artifactStore: RunArtifactStore;
  readonly observer?: RunObserver;
  readonly contributors?: readonly RunArtifactContributor[];
}
