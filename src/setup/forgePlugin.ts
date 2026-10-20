import { pluginMcpCredentials } from '../agents/pluginMcp.ts';
import type { PreparedAgentPluginInstallation } from '../contracts/plugin.ts';
import { parseAgentPluginInstallationReceipt } from '../contracts/pluginReceipt.ts';
import { pluginMcpServersForDistribution } from '../model/pluginMcp.ts';
import type { PluginSetupStepV1, SetupStepV1 } from '../model/types.ts';
import type {
  PreparedSetupStep,
  SetupExecutionContext,
  SetupPreflightContext,
  SetupStepHandler,
} from './types.ts';

export const pluginSetupHandler: SetupStepHandler = Object.freeze({
  uses: 'forge/plugin',
  preflight(
    step: SetupStepV1,
    context: SetupPreflightContext,
  ): PreparedSetupStep {
    if (step.uses !== 'forge/plugin') {
      throw new TypeError(
        `forge/plugin cannot handle ${JSON.stringify(step.uses)}.`,
      );
    }
    const pluginStep = step as PluginSetupStepV1;
    const distribution = pluginStep.with.agents[context.selection.adapter];
    if (!distribution) {
      throw new TypeError(
        `forge/plugin does not define a distribution for agent ${JSON.stringify(context.selection.adapter)}.`,
      );
    }
    if (!context.pluginInstaller) {
      throw new TypeError(
        `Agent ${JSON.stringify(context.selection.adapter)} does not support forge/plugin.`,
      );
    }
    const mcpServers = pluginMcpServersForDistribution(
      context.selection.adapter,
      distribution,
    );
    if (mcpServers && !context.pluginInstaller.supportsMcpBearerAuth) {
      throw new TypeError(
        `Agent ${JSON.stringify(context.selection.adapter)} does not support plugin MCP bearer authentication.`,
      );
    }
    const prepared = context.pluginInstaller.preflight(distribution, {
      selection: context.selection,
      runtime: context.runtime,
      ...(mcpServers ? { mcpServers } : {}),
    });
    assertPreparedInstallation(prepared);

    return Object.freeze({
      requirements: Object.freeze({
        ...(mcpServers
          ? {
              credentials: {
                agent: pluginMcpCredentials(mcpServers),
              },
            }
          : {}),
        executables: prepared.requirements.executables,
        stateDirectories: prepared.requirements.stateDirectories,
      }),
      async apply(applyContext: SetupExecutionContext) {
        return parseAgentPluginInstallationReceipt(
          await prepared.install({
            runId: applyContext.runId,
            paths: applyContext.paths,
            stateDirectories: applyContext.stateDirectories,
            commands: applyContext.commands,
            signal: applyContext.signal,
          }),
        );
      },
    });
  },
});

function assertPreparedInstallation(
  value: PreparedAgentPluginInstallation,
): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'requirements') ||
    !Object.hasOwn(value, 'install') ||
    typeof value.install !== 'function' ||
    value.requirements === null ||
    typeof value.requirements !== 'object' ||
    !Array.isArray(value.requirements.executables) ||
    !Array.isArray(value.requirements.stateDirectories)
  ) {
    throw new TypeError(
      'Agent plugin installer returned an invalid prepared operation.',
    );
  }
}
