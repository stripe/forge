import path from 'node:path';

import type { RuntimeLogicalPaths } from '../../contracts/runtime.ts';

export const CODEX_HOME_STATE_ID = 'codex-home' as const;

/** Run-owned Linux paths visible to Codex, independent of the host filesystem. */
export interface CodexLayout {
  readonly workspace: string;
  readonly home: string;
  /** CODEX_HOME: configuration, sessions, and other Codex-owned state. */
  readonly configDirectory: string;
}

const DEFAULT_LAYOUT: CodexLayout = Object.freeze({
  workspace: '/workspace',
  home: '/home/forge',
  configDirectory: '/home/forge/.codex',
});

export function resolveCodexLayout(
  input: CodexLayout | undefined,
): CodexLayout {
  const value = input === undefined ? DEFAULT_LAYOUT : input;
  if (
    typeof value !== 'object' ||
    value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 3 ||
    !['workspace', 'home', 'configDirectory'].every((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    throw new TypeError(
      'Codex layout requires workspace, home, and configDirectory.',
    );
  }
  const layout = Object.freeze({
    workspace: directory(value.workspace),
    home: directory(value.home),
    configDirectory: directory(value.configDirectory),
  });
  if (
    overlap(layout.workspace, layout.home) ||
    overlap(layout.workspace, layout.configDirectory) ||
    layout.home === layout.configDirectory ||
    layout.home.startsWith(`${layout.configDirectory}/`)
  ) {
    throw new TypeError(
      'Codex workspace must be separate from home and configuration state.',
    );
  }
  return layout;
}

export function usesDefaultCodexLayout(layout: CodexLayout): boolean {
  return (
    layout.workspace === DEFAULT_LAYOUT.workspace &&
    layout.home === DEFAULT_LAYOUT.home &&
    layout.configDirectory === DEFAULT_LAYOUT.configDirectory
  );
}

export function assertCodexRuntimeLayout(
  layout: CodexLayout,
  paths: RuntimeLogicalPaths,
): void {
  if (layout.workspace !== paths.workspace || layout.home !== paths.home) {
    throw new TypeError(
      'Codex runtime paths do not match the declared layout.',
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
      'Codex paths must be bounded, canonical absolute Linux directories.',
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
