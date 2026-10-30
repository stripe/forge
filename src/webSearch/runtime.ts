import type { ForgeComposition } from '../contracts/composition.ts';
import { credentialReference, type CredentialResolver } from '../contracts/credentials.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import { hasWebSearch, WEB_SEARCH_TOKEN_REFERENCE } from '../setup/forgeWebSearch.ts';
import { startWebSearchService, type WebSearchService } from './webSearchService.ts';

/** Pure validation, before any run credentials or runtime authority. */
export function preflightWebSearch(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
): void {
  if (!hasWebSearch(plan)) return;
  if (plan.setup.filter((step) => step.uses === 'forge/web-search').length !== 1)
    throw new TypeError('forge/web-search must occur exactly once per run.');
  const config = composition.webSearch;
  if (!config)
    throw new TypeError('The host must configure webSearch for forge/web-search.');
  credentialReference(config.credential);
  const url = new URL(config.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username ||
    url.password || url.search || url.hash
  ) throw new TypeError('Invalid web search upstream base URL.');
}

export interface PreparedWebSearch {
  readonly service: WebSearchService;
  readonly secrets: readonly string[];
  readonly credentialResolver: CredentialResolver;
}

export async function prepareWebSearch(
  plan: ResolvedRunPlanV1,
  composition: ForgeComposition,
  runId: string,
  signal: AbortSignal,
): Promise<PreparedWebSearch | undefined> {
  if (!hasWebSearch(plan)) return undefined;
  const config = composition.webSearch!;
  const upstreamCredential = await composition.credentialResolver.resolve(
    config.credential, { runId, purpose: 'web_search', signal },
  );
  signal.throwIfAborted();
  if (
    typeof upstreamCredential !== 'string' || !upstreamCredential ||
    /[\0\r\n]/.test(upstreamCredential)
  ) throw new TypeError('Invalid web search credential.');
  const service = await startWebSearchService({
    upstreamBaseUrl: config.baseUrl,
    upstreamCredential,
    agentHostname: '127.0.0.1',
    signal,
  });
  return {
    service,
    secrets: [upstreamCredential, service.credential],
    credentialResolver: {
      resolve(reference, context) {
        return reference === WEB_SEARCH_TOKEN_REFERENCE
          ? Promise.resolve(service.credential)
          : composition.credentialResolver.resolve(reference, context);
      },
    },
  };
}
