import type {ResolvedRunPlanV1} from '../model/types.js';
import type {CommandRunner} from './command.js';
import type {ResolvedEnvironment, ScopedEnvironmentSpecification} from './credentials.js';

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
  /** Absolute paths visible to evaluated commands, within their runtime. */
  readonly workspace: string;
  readonly home: string;
}

export interface RuntimeStateDirectoryRequirement {
  /** Stable adapter-owned logical name, such as `claude-projects`. */
  readonly id: string;
  /** Absolute runtime-visible path to persist and seal; name retained for compatibility. */
  readonly containerPath: string;
  /**
   * When true, setup may populate this directory but interaction receives an
   * immutable view. Runtimes must enforce the transition in finalizeSetup().
   */
  readonly sealAfterSetup?: boolean;
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

export interface RuntimePreflight {
  readonly plan: ResolvedRunPlanV1;
  readonly requirements: RuntimeRequirements;
  /** Plain variables plus opaque credential names/references/scopes; never secret values. */
  readonly environment: ScopedEnvironmentSpecification;
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
  /**
   * End setup command authority and seal every state directory which requested
   * sealAfterSetup before the coding agent can run.
   */
  finalizeSetup(): Promise<void>;
  /** Stop all mutation, await active commands, then expose stable evidence. */
  quiesce(): Promise<SealedRuntime>;
  /** Idempotent cleanup for failures before or after quiescence. */
  dispose(): Promise<void>;
}

/** Forge owns lifecycle ordering; adapters own only runtime mechanics. */
export interface RuntimeAdapter {
  readonly id: string;
  readonly version: string;
  /**
   * Pure, synchronous validation of the exact configuration and combined
   * agent/setup requirements. Never normalize defaults, resolve credentials,
   * inspect ambient state, allocate, or execute commands. Required for external
   * runtime descriptors; optional for legacy Docker implementations.
   */
  preflight?(input: RuntimePreflight): void;
  prepare(input: RuntimePreparation): Promise<PreparedRuntime>;
}
