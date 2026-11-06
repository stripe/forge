import {
  FORGE_PLAYWRIGHT_MCP_VERSION,
  FORGE_PLAYWRIGHT_VERSION,
} from '../runtime/docker/assets.ts';
import type { SetupStepHandler } from './types.ts';

export const BROWSER_STATE_ID = 'forge-browser';
export const BROWSER_STATE_PATH = '/home/forge/.forge-browser';
export const BROWSER_MCP_URL = 'http://127.0.0.1:8931/mcp';
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
        await state.writeFile(
          'mcp.json',
          Buffer.from(
            JSON.stringify({
              mcpServers: {
                'forge-browser': { type: 'http', url: BROWSER_MCP_URL },
              },
            }),
          ),
          { mode: 0o600 },
        );
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
        return {
          provider: 'local',
          controller: 'playwright-mcp',
          playwright_mcp_version: FORGE_PLAYWRIGHT_MCP_VERSION,
          playwright_version: FORGE_PLAYWRIGHT_VERSION,
        };
      },
    };
  },
} satisfies SetupStepHandler);
