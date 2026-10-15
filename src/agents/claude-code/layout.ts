import path from 'node:path';

import type { RuntimeLogicalPaths } from '../../contracts/runtime.js';

/** Runtime-visible, run-owned Linux paths, fixed before capability preflight. */
export interface ClaudeCodeLayout {
  readonly workspace: string;
  readonly home: string;
  /** Claude's effective configuration root; may be separate from HOME. */
  readonly configDirectory: string;
}

export const DEFAULT_CLAUDE_CODE_LAYOUT: ClaudeCodeLayout = Object.freeze({
  workspace: '/workspace',
  home: '/home/forge',
  configDirectory: '/home/forge/.claude',
});

/** Snapshot without consulting the host filesystem or environment. */
export function resolveClaudeCodeLayout(
  input: ClaudeCodeLayout | undefined,
): ClaudeCodeLayout {
  const value = input === undefined ? DEFAULT_CLAUDE_CODE_LAYOUT : input;
  if (
    value === null ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, 'workspace') ||
    !Object.hasOwn(value, 'home') ||
    !Object.hasOwn(value, 'configDirectory')
  ) {
    throw new TypeError(
      'Claude layout must contain workspace, home, and configDirectory.',
    );
  }
  const layout = Object.freeze({
    workspace: canonicalLinuxDirectory(value.workspace),
    home: canonicalLinuxDirectory(value.home),
    configDirectory: canonicalLinuxDirectory(value.configDirectory),
  });
  if (
    pathsOverlap(layout.workspace, layout.home) ||
    pathsOverlap(layout.workspace, layout.configDirectory) ||
    layout.home === layout.configDirectory ||
    layout.home.startsWith(`${layout.configDirectory}/`)
  ) {
    throw new TypeError(
      'Claude layout must keep workspace, home, and configuration state separate.',
    );
  }
  canonicalLinuxDirectory(claudeProjectDirectory(layout));
  canonicalLinuxDirectory(`${layout.configDirectory}/plugins`);
  return layout;
}

export function usesDefaultClaudeCodeLayout(layout: ClaudeCodeLayout): boolean {
  return (
    layout.workspace === DEFAULT_CLAUDE_CODE_LAYOUT.workspace &&
    layout.home === DEFAULT_CLAUDE_CODE_LAYOUT.home &&
    layout.configDirectory === DEFAULT_CLAUDE_CODE_LAYOUT.configDirectory
  );
}

export function assertClaudeRuntimeLayout(
  layout: ClaudeCodeLayout,
  paths: RuntimeLogicalPaths,
): void {
  if (paths.home !== layout.home || paths.workspace !== layout.workspace) {
    throw new TypeError(
      'Claude runtime paths do not match the declared layout.',
    );
  }
}

export function claudeProjectDirectory(layout: ClaudeCodeLayout): string {
  return `${layout.configDirectory}/projects/${encodeClaudeProjectPath(layout.workspace)}`;
}

/** Claude Code 2.1.273's Linux project-directory encoding. */
function encodeClaudeProjectPath(workspace: string): string {
  const encoded = workspace.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let index = 0; index < workspace.length; index += 1) {
    hash = ((hash << 5) - hash + workspace.charCodeAt(index)) | 0;
  }
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function canonicalLinuxDirectory(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value === '/' ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    path.posix.normalize(value) !== value ||
    value.endsWith('/')
  ) {
    throw new TypeError(
      'Claude layout paths must be bounded, canonical absolute Linux directories.',
    );
  }
  return value;
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
