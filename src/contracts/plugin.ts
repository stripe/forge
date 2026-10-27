import type {
  AgentSelectionV1,
  JsonObject,
  PluginMcpServerId,
  PluginSelectionV1,
  ResolvedRunPlanV1,
  Sha256Digest,
} from '../model/types.ts';
import type { CommandRunner } from './command.ts';
import type {
  MutableWorkspace,
  PluginMcpConnections,
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
interface PluginInstallationReceiptBase extends JsonObject {
  readonly adapter: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly marketplace_commit: string;
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

export interface NativeAgentPluginInstallationReceipt
  extends PluginInstallationReceiptBase {
  readonly native_plugin_id: string;
}

/** An adapter materializes the standard bundle without a native marketplace CLI. */
export interface OpenCodeBundleInstallationReceipt
  extends PluginInstallationReceiptBase {
  readonly installation: 'opencode-bundle';
  readonly source: JsonObject & {
    readonly kind: 'git-subdir';
    readonly commit: string;
    readonly path: 'providers/agent-plugins/plugin';
  };
}

export type AgentPluginInstallationReceipt =
  | NativeAgentPluginInstallationReceipt
  | OpenCodeBundleInstallationReceipt;

/** Ambient-free context for binding one portable plugin to an agent adapter. */
export interface AgentPluginPreflightContext {
  readonly selection: AgentSelectionV1;
  readonly runtime: ResolvedRunPlanV1['runtime'];
  readonly mcpServers?: readonly PluginMcpServerId[];
}

/** Narrow authority supplied to one already-preflighted native installation. */
export interface AgentPluginInstallContext {
  readonly runId: string;
  readonly pluginMcpConnections?: PluginMcpConnections;
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
  /** Accepts bearer auth for bundled HTTP MCP servers. */
  readonly supportsMcpBearerAuth?: true;
  /**
   * Native MCP initialization and discovery only; never model or tool calls.
   * `servers` are the code-owned MCP servers expected for this plugin.
   */
  checkMcp?(context: {
    readonly receipt: NativeAgentPluginInstallationReceipt;
    readonly servers: readonly PluginMcpServerId[];
    readonly stateDirectories: ReadonlyMap<string, MutableWorkspace>;
    readonly commands: CommandRunner;
    readonly signal: AbortSignal;
  }): Promise<void>;
  /** Purely validate compatibility and bind the later native operation. */
  preflight(
    plugin: PluginSelectionV1,
    context: AgentPluginPreflightContext,
  ): PreparedAgentPluginInstallation;
}
