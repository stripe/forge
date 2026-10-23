import path from 'node:path';

import type { RuntimeLogicalPaths } from '../../contracts/runtime.ts';

export const OPENCODE_STATE_ID = 'opencode-state' as const;

/** Run-owned Linux paths visible to OpenCode, independent of the host filesystem. */
export interface OpenCodeLayout {
  readonly workspace: string;
  readonly home: string;
  /** Configuration, data, cache, prompt and exact-session export state. */
  readonly stateDirectory: string;
}

const DEFAULT_LAYOUT: OpenCodeLayout = Object.freeze({
  workspace: '/workspace',
  home: '/home/forge',
  stateDirectory: '/home/forge/.opencode-forge',
});

export function resolveOpenCodeLayout(
  input: OpenCodeLayout | undefined,
): OpenCodeLayout {
  const value = input === undefined ? DEFAULT_LAYOUT : input;
  if (
    typeof value !== 'object' ||
    value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 3 ||
    !['workspace', 'home', 'stateDirectory'].every((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    throw new TypeError(
      'OpenCode layout requires workspace, home, and stateDirectory.',
    );
  }
  const layout = Object.freeze({
    workspace: directory(value.workspace),
    home: directory(value.home),
    stateDirectory: directory(value.stateDirectory),
  });
  if (
    overlap(layout.workspace, layout.home) ||
    overlap(layout.workspace, layout.stateDirectory) ||
    layout.home === layout.stateDirectory ||
    layout.home.startsWith(`${layout.stateDirectory}/`)
  ) {
    throw new TypeError(
      'OpenCode workspace must be separate from home and configuration state.',
    );
  }
  return layout;
}

export function usesDefaultOpenCodeLayout(layout: OpenCodeLayout): boolean {
  return (
    layout.workspace === DEFAULT_LAYOUT.workspace &&
    layout.home === DEFAULT_LAYOUT.home &&
    layout.stateDirectory === DEFAULT_LAYOUT.stateDirectory
  );
}

export function assertOpenCodeRuntimeLayout(
  layout: OpenCodeLayout,
  paths: RuntimeLogicalPaths,
): void {
  if (layout.workspace !== paths.workspace || layout.home !== paths.home) {
    throw new TypeError(
      'OpenCode runtime paths do not match the declared layout.',
    );
  }
}

function directory(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value === '/' ||
    Buffer.byteLength(value, 'utf8') > 3_500 ||
    value.normalize('NFC') !== value ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    path.posix.normalize(value) !== value ||
    value.endsWith('/') ||
    value.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > 255)
  ) {
    throw new TypeError(
      'OpenCode paths must be bounded, canonical absolute Linux directories.',
    );
  }
  return value;
}

function overlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
