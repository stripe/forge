import type { ReadonlyWorkspace } from '../contracts/runtime.ts';
import {
  FORGE_PLAYWRIGHT_MCP_VERSION,
  FORGE_PLAYWRIGHT_VERSION,
} from '../runtime/docker/assets.ts';
import type { SetupStepHandler } from './types.ts';

export const BROWSER_STATE_ID = 'forge-browser';
export const BROWSER_STATE_PATH = '/home/forge/.forge-browser';
export const BROWSER_EXECUTABLE = 'forge-browser';

/** Start the run-owned service during ordered setup; runtime shutdown owns its lifetime. */
export const browserSetupHandler: SetupStepHandler = Object.freeze({
  uses: 'forge/browser',
  preflight(step, context) {
    if (step.uses !== 'forge/browser' || Object.keys(step.with).length !== 0) {
      throw new TypeError('forge/browser requires an empty with object.');
    }
    if (
      !context.browser?.access.agent ||
      context.browser.access.role_player ||
      context.browser.integration.provider !== 'local' ||
      context.browser.integration.controller !== 'playwright-mcp'
    ) {
      throw new TypeError(
        'forge/browser requires an explicit supported browser configuration.',
      );
    }
    if (!context.supportsBrowserMcp) {
      throw new TypeError(
        'The selected agent does not support browser MCP registration.',
      );
    }
    return {
      requirements: {
        executables: [BROWSER_EXECUTABLE],
        stateDirectories: [
          { id: BROWSER_STATE_ID, containerPath: BROWSER_STATE_PATH },
        ],
      },
      async apply(context) {
        if (context.paths.home !== '/home/forge') {
          throw new TypeError(
            'Local browser setup requires the documented /home/forge runtime layout.',
          );
        }
        const state = context.stateDirectories.get(BROWSER_STATE_ID);
        if (!state) throw new TypeError('Browser state is unavailable.');
        const result = await context.commands.run(
          [BROWSER_EXECUTABLE, 'start'],
          {
            signal: context.signal,
            timeoutMs: 60_000,
            maxOutputBytes: 64 * 1024,
          },
        );
        if (result.exitCode !== 0)
          throw new Error('Browser service did not become ready.');
        const url = result.stdout.trim();
        if (!isBrowserMcpUrl(url))
          throw new Error('Invalid browser service endpoint.');
        await state.writeFile(
          'mcp.json',
          Buffer.from(
            JSON.stringify({
              mcpServers: {
                'forge-browser': { type: 'http', url: url },
              },
            }),
          ),
          { mode: 0o600 },
        );
        return {
          provider: 'local',
          controller: 'playwright-mcp',
          mcp_url: url,
          playwright_mcp_version: FORGE_PLAYWRIGHT_MCP_VERSION,
          playwright_version: FORGE_PLAYWRIGHT_VERSION,
        };
      },
    };
  },
} satisfies SetupStepHandler);

/** Canonical unauthenticated run-owned HTTP endpoint; no authored URLs or redirects. */
export function isBrowserMcpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/.exec(value);
  return match !== null && Number(match[1]) <= 65535;
}

export async function readBrowserMcpUrl(
  state: ReadonlyWorkspace,
): Promise<string> {
  const document = JSON.parse(
    Buffer.from(await state.readFile('mcp.json', { maxBytes: 4096 })).toString(
      'utf8',
    ),
  );
  const server = document?.mcpServers?.['forge-browser'];
  if (
    !document ||
    Object.keys(document).length !== 1 ||
    !document.mcpServers ||
    Object.keys(document.mcpServers).length !== 1 ||
    !server ||
    Object.keys(server).length !== 2 ||
    server.type !== 'http' ||
    !isBrowserMcpUrl(server.url)
  ) {
    throw new TypeError('Invalid run-owned browser MCP configuration.');
  }
  return server.url;
}
