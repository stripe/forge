import type {ResolvedRunPlanV1} from '../model/types.js';
import type {CommandRunner} from './command.js';
import type {ResolvedEnvironment} from './credentials.js';

export type RuntimePlatform = 'linux/amd64' | 'linux/arm64';

export interface WorkspaceWriteOptions {
  /** POSIX permissions applied to the completed file. Defaults to 0644. */
  readonly mode?: number;
}

export type WorkspaceEntryKind =
  | 'absent'
  | 'file'
  | 'directory'
  | 'symlink'
  | 'other';

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly size?: number;
}

export interface WorkspaceListOptions {
  /** Workspace-relative directory. Defaults to the workspace root. */
  readonly under?: string;
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeLogicalPaths {
  /** Container-visible paths; never host filesystem paths. */
  readonly workspace: string;
  readonly home: string;
}

export interface RuntimeStateDirectoryRequirement {
  /** Stable adapter-owned logical name, such as `claude-projects`. */
  readonly id: string;
  /** Absolute container path which the runtime must persist and seal. */
  readonly containerPath: string;
}

export interface RuntimeRequirements {
  /** Executables the prepared runtime must make available to the agent adapter. */
  readonly executables: readonly string[];
  readonly stateDirectories: readonly RuntimeStateDirectoryRequirement[];
}

export interface ReadonlyWorkspace {
  inspect(relativePath: string): Promise<WorkspaceEntry>;
  readFile(relativePath: string, options?: {maxBytes?: number}): Promise<Uint8Array>;
  /** Stable lexical order. Symlinks are reported but never traversed. */
  listFiles(options?: WorkspaceListOptions): Promise<readonly WorkspaceEntry[]>;
}

export interface MutableWorkspace extends ReadonlyWorkspace {
  writeFile(
    relativePath: string,
    body: Uint8Array,
    options?: WorkspaceWriteOptions,
  ): Promise<void>;
}

export interface RuntimePreparation {
  readonly runId: string;
  readonly plan: ResolvedRunPlanV1;
  readonly environment: ResolvedEnvironment;
  readonly requirements: RuntimeRequirements;
  readonly signal: AbortSignal;
}

/** Runtime after mutation has stopped and evidence is stable. */
export interface SealedRuntime {
  readonly runtimeId: string;
  readonly workspace: ReadonlyWorkspace;
  readonly paths: RuntimeLogicalPaths;
  readonly stateDirectories: ReadonlyMap<string, ReadonlyWorkspace>;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Runtime capabilities available only before evidence sealing. */
export interface PreparedRuntime {
  readonly runtimeId: string;
  readonly workspace: MutableWorkspace;
  readonly paths: RuntimeLogicalPaths;
  readonly stateDirectories: ReadonlyMap<string, MutableWorkspace>;
  readonly commands: Readonly<{
    /** Explicit plain variables only; resolved credentials are never exposed. */
    uncredentialed: CommandRunner;
    /**
     * Create a runner containing plain variables and exactly the named
     * setup-scoped credentials. Unknown or non-setup names must be rejected.
     */
    setup(credentialEnvironmentNames: readonly string[]): CommandRunner;
    /** Plain variables and agent-scoped credentials. */
    agent: CommandRunner;
  }>;
  /** Stop all mutation, await active commands, then expose stable evidence. */
  quiesce(): Promise<SealedRuntime>;
  /** Idempotent cleanup for failures before or after quiescence. */
  dispose(): Promise<void>;
}

/** Forge owns lifecycle ordering; adapters own only runtime mechanics. */
export interface RuntimeAdapter {
  readonly id: string;
  readonly version: string;
  prepare(input: RuntimePreparation): Promise<PreparedRuntime>;
}
