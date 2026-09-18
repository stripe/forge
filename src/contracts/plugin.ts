import type {CommandRunner} from './command.js';
import type {
  MutableWorkspace,
  RuntimeLogicalPaths,
  RuntimeRequirements,
} from './runtime.js';
import type {
  AgentSelectionV1,
  PluginSelectionV1,
  ResolvedRunPlanV1,
} from '../model/types.js';

/** Ambient-free context for binding one portable plugin to an agent adapter. */
export interface AgentPluginPreflightContext {
  readonly selection: AgentSelectionV1;
  readonly runtime: ResolvedRunPlanV1['runtime'];
}

/** Narrow authority supplied to one already-preflighted native installation. */
export interface AgentPluginInstallContext {
  readonly runId: string;
  readonly paths: RuntimeLogicalPaths;
  /** Contains only state directories declared by this plugin operation. */
  readonly stateDirectories: ReadonlyMap<string, MutableWorkspace>;
  /** Uncredentialed, or projected to exactly this operation's setup credentials. */
  readonly commands: CommandRunner;
  readonly signal: AbortSignal;
}

/** One native plugin operation bound before credentials or runtime allocation. */
export interface PreparedAgentPluginInstallation {
  readonly requirements: RuntimeRequirements;
  install(context: AgentPluginInstallContext): Promise<void>;
}

/** Optional narrow capability implemented by an agent adapter. */
export interface AgentPluginInstaller {
  /** Purely validate compatibility and bind the later native operation. */
  preflight(
    plugin: PluginSelectionV1,
    context: AgentPluginPreflightContext,
  ): PreparedAgentPluginInstallation;
}
