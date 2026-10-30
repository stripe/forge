import { parse as parseToml } from 'toml';
import { CODEX_HOME_STATE_ID } from '../agents/codex/layout.ts';
import { declareCodexMcpServers } from '../agents/codex/pluginConfig.ts';
import { credentialReference } from '../contracts/credentials.ts';
import type {
  MutableWorkspace,
  PreparedRuntime,
} from '../contracts/runtime.ts';
import type {
  JsonObject,
  ResolvedRunPlanV1,
  SetupStepV1,
} from '../model/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { isRecord, WEB_SEARCH_MODEL } from '../webSearch/webSearchBackend.ts';
import type {
  PreparedSetupStep,
  SetupPreflightContext,
  SetupStepHandler,
} from './types.ts';

export const WEB_SEARCH_TOKEN_ENV = 'FORGE_WEB_SEARCH_TOKEN';
export const WEB_SEARCH_TOKEN_REFERENCE = 'forge.web-search-token';
const MAX_CONFIG_BYTES = 1024 * 1024;

export function hasWebSearch(plan: Pick<ResolvedRunPlanV1, 'setup'>): boolean {
  return plan.setup.some((step) => step.uses === 'forge/web-search');
}

export const WEB_SEARCH_RESOLUTION: JsonObject = Object.freeze({
  server: 'web_search',
  tool: 'call_web_search',
  backend_model: WEB_SEARCH_MODEL,
  result_mode: 'urls-only',
  endpoint: 'per-run-host-service',
  external_web_access: false,
  native_search: 'disabled',
});

/** The upstream credential is host-owned; only the ephemeral bearer enters the agent. */
export const webSearchSetupHandler: SetupStepHandler = Object.freeze({
  uses: 'forge/web-search',
  preflight(
    step: SetupStepV1,
    context: SetupPreflightContext,
  ): PreparedSetupStep {
    if (step.uses !== 'forge/web-search' || Object.keys(step.with).length !== 0)
      throw new TypeError('forge/web-search accepts no configuration.');
    const adapter = context.selection.adapter;
    if (!['claude-code', 'codex', 'opencode'].includes(adapter))
      throw new TypeError(
        'forge/web-search requires a built-in agent adapter.',
      );
    if (
      context.runtime.adapter === 'docker' &&
      (!('network' in context.runtime) || context.runtime.network !== 'host')
    )
      throw new TypeError(
        'forge/web-search requires runtime.network: host with Docker.',
      );
    const states = (context.agentStateDirectories ?? []).filter(
      (state) => adapter === 'codex' && state.id === CODEX_HOME_STATE_ID,
    );
    if (adapter === 'codex' && states.length !== 1)
      throw new TypeError(
        'forge/web-search requires the Codex run-owned home.',
      );
    return {
      requirements: {
        // OpenCode v1.19.0's webSearchEnabled gate uses these flags for all
        // agents on the fixed forge provider, independently of permissions.
        ...(adapter === 'opencode'
          ? {
              variables: {
                OPENCODE_EXPERIMENTAL: 'false',
                OPENCODE_ENABLE_EXA: 'false',
                OPENCODE_EXPERIMENTAL_EXA: 'false',
                OPENCODE_ENABLE_PARALLEL: 'false',
                OPENCODE_EXPERIMENTAL_PARALLEL: 'false',
              },
            }
          : {}),
        stateDirectories: states,
        credentials: {
          agent: {
            [WEB_SEARCH_TOKEN_ENV]: {
              reference: credentialReference(WEB_SEARCH_TOKEN_REFERENCE),
            },
          },
        },
      },
      async apply(runtime) {
        if (!runtime.webSearchUrl)
          throw new Error('Host web search connection is unavailable.');
        if (adapter === 'codex') {
          const home = runtime.stateDirectories.get(CODEX_HOME_STATE_ID);
          if (!home) throw new Error('Codex state is unavailable.');
          await declareCodexMcpServers(home, {
            web_search: {
              url: runtime.webSearchUrl,
              bearer_token_env_var: WEB_SEARCH_TOKEN_ENV,
            },
          });
        } else {
          const claude = adapter === 'claude-code';
          const path = claude ? '.mcp.json' : 'opencode.json';
          const config = await readConfig(runtime.workspace, path);
          const key = claude ? 'mcpServers' : 'mcp';
          const servers = config[key] === undefined ? {} : config[key];
          if (!isRecord(servers))
            throw new Error('MCP configuration must be an object.');
          const bytes = Buffer.from(
            `${JSON.stringify(
              {
                ...config,
                [key]: {
                  ...servers,
                  web_search: searchServer(claude, runtime.webSearchUrl),
                },
              },
              null,
              2,
            )}\n`,
          );
          if (bytes.byteLength > MAX_CONFIG_BYTES)
            throw new Error('MCP configuration exceeds its size limit.');
          runtime.signal.throwIfAborted();
          await runtime.workspace.writeFile(path, bytes);
        }
        return { ...WEB_SEARCH_RESOLUTION };
      },
    };
  },
});

function searchServer(claude: boolean, url: string): JsonObject {
  return claude
    ? {
        type: 'http',
        url,
        headers: { Authorization: `Bearer \${${WEB_SEARCH_TOKEN_ENV}}` },
      }
    : {
        type: 'remote',
        url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer {env:${WEB_SEARCH_TOKEN_ENV}}` },
      };
}

async function readConfig(
  workspace: MutableWorkspace,
  path: string,
): Promise<Record<string, unknown>> {
  const entry = await workspace.inspect(path);
  if (entry.kind === 'absent') return {};
  if (entry.kind !== 'file')
    throw new Error('MCP configuration must be a regular file.');
  try {
    const value: unknown = JSON.parse(
      Buffer.from(
        await workspace.readFile(path, { maxBytes: MAX_CONFIG_BYTES }),
      ).toString('utf8'),
    );
    if (isRecord(value)) return value;
  } catch {
    /* Do not expose configuration bytes in errors. */
  }
  throw new Error('MCP configuration must be an object.');
}

/** Reject later setup steps that remove or redirect the run-owned connection. */
export async function assertWebSearchConfiguration(
  plan: ResolvedRunPlanV1,
  runtime: Pick<PreparedRuntime, 'workspace' | 'stateDirectories'>,
  url: string,
): Promise<void> {
  if (plan.agent.adapter === 'codex') {
    const home = runtime.stateDirectories.get(CODEX_HOME_STATE_ID);
    if (!home) throw new Error('Codex state is unavailable.');
    const config = parseToml(
      Buffer.from(
        await home.readFile('config.toml', { maxBytes: MAX_CONFIG_BYTES }),
      ).toString('utf8'),
    ) as Record<string, unknown>;
    const entry = isRecord(config.mcp_servers)
      ? config.mcp_servers.web_search
      : undefined;
    if (
      isRecord(entry) &&
      entry.url === url &&
      entry.bearer_token_env_var === WEB_SEARCH_TOKEN_ENV &&
      Object.keys(entry).length === 2
    )
      return;
  } else {
    const claude = plan.agent.adapter === 'claude-code';
    const config = await readConfig(
      runtime.workspace,
      claude ? '.mcp.json' : 'opencode.json',
    );
    const servers = config[claude ? 'mcpServers' : 'mcp'];
    const entry = isRecord(servers) ? servers.web_search : undefined;
    if (
      isRecord(entry) &&
      serializeCanonicalJson(entry) ===
        serializeCanonicalJson(searchServer(claude, url))
    )
      return;
  }
  throw new Error('Setup changed the Forge web search connection.');
}
