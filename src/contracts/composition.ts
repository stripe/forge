import type { AgentAdapter } from './agent.ts';
import type { RunArtifactContributor, RunArtifactStore } from './artifacts.ts';
import type { AttemptDiagnosticsStore } from './attemptDiagnostics.ts';
import type {
  CompletionProvider,
  CompletionProviderResolver,
} from './completion.ts';
import type { CredentialResolver } from './credentials.ts';
import type { RunInputProvider } from './inputs.ts';
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
  readonly credentialResolver: CredentialResolver;
  readonly inputProvider: RunInputProvider;
  readonly artifactStore: RunArtifactStore;
  readonly attemptDiagnosticsStore?: AttemptDiagnosticsStore;
  readonly observer?: RunObserver;
  readonly contributors?: readonly RunArtifactContributor[];
}
