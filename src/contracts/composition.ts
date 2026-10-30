import type { AgentAdapter } from './agent.ts';
import type { RunArtifactContributor, RunArtifactStore } from './artifacts.ts';
import type { AttemptDiagnosticsStore } from './attemptDiagnostics.ts';
import type {
  CompletionProvider,
  CompletionProviderResolver,
} from './completion.ts';
import type { CredentialReference, CredentialResolver } from './credentials.ts';
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
  /** Host-only search authority; used only when setup declares forge/web-search.
   * baseUrl excludes /v1; the engine appends /v1/responses. The runtime must
   * reach host loopback (Docker requires explicit network: host).
   */
  readonly webSearch?: Readonly<{
    baseUrl: string;
    credential: CredentialReference;
  }>;
  readonly runtime: RuntimeAdapter;
  readonly agents: ReadonlyMap<string, AgentAdapter>;
  readonly completionProviders?: CompletionProviderCollection;
  readonly credentialResolver: CredentialResolver;
  readonly inputProvider: RunInputProvider;
  readonly artifactStore: RunArtifactStore;
  readonly attemptDiagnosticsStore?: AttemptDiagnosticsStore;
  /** Host opt-in; never an authored input or environment default. */
  readonly restrictedDiagnosticExcerpts?: boolean;
  readonly observer?: RunObserver;
  readonly contributors?: readonly RunArtifactContributor[];
}
