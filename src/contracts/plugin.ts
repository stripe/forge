import type { MarketplaceRef } from '../model/paths.ts';
import type {
  AgentSelectionV1,
  JsonObject,
  PluginSelectionV1,
  ResolvedRunPlanV1,
  Sha256Digest,
} from '../model/types.ts';
import type { CommandRunner } from './command.ts';
import type {
  MutableWorkspace,
  RuntimeLogicalPaths,
  RuntimeRequirements,
} from './runtime.ts';

export type AgentPluginSourceKind =
  | 'marketplace-path'
  | 'archive'
  | 'github'
  | 'url'
  | 'git-subdir';

/** Installation-time audit record; plugins may change during interaction. */
export interface AgentPluginInstallationReceipt extends JsonObject {
  readonly adapter: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly ref?: MarketplaceRef;
  readonly marketplace_commit: string;
  readonly native_plugin_id: string;
  readonly version: string;
  readonly source: JsonObject & {
    readonly kind: AgentPluginSourceKind;
    /** Git revision reported by the native installer, when available. */
    readonly commit?: string;
  };
  readonly installed_tree: JsonObject & {
    readonly format: 'forge-plugin-tree-v1';
    readonly sha256: Sha256Digest;
    readonly entry_count: number;
    readonly file_count: number;
    readonly size_bytes: number;
  };
}

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
  install(
    context: AgentPluginInstallContext,
  ): Promise<AgentPluginInstallationReceipt>;
}

/** Optional narrow capability implemented by an agent adapter. */
export interface AgentPluginInstaller {
  /** Purely validate compatibility and bind the later native operation. */
  preflight(
    plugin: PluginSelectionV1,
    context: AgentPluginPreflightContext,
  ): PreparedAgentPluginInstallation;
}
