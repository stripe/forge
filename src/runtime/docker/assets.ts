/** Exact direct dependency installed in the Forge v1 runtime image. */
export const FORGE_CLAUDE_CODE_VERSION = '2.1.273';

/** Exact direct dependency installed in the Forge v1 runtime image. */
export const FORGE_CODEX_VERSION = '0.149.0';

export const FORGE_PLAYWRIGHT_MCP_VERSION = '0.0.84';
export const FORGE_PLAYWRIGHT_VERSION = '1.65.0-alpha-2026-10-30';

/** Ordered packaged files, separated by NUL when hashing their contents. */
export const FORGE_RUNTIME_ASSET_FILES = [
  'Dockerfile',
  'entrypoint.sh',
  'browser/package.json',
  'browser/package-lock.json',
  'browser/service.cjs',
] as const;

/** Hash of all files in FORGE_RUNTIME_ASSET_FILES in that order. */
export const FORGE_RUNTIME_ASSET_DIGEST =
  'f09ed2782dc24f992df0894e7efeb103371b01cd69c1bc67017b9e0fbbece9df';
