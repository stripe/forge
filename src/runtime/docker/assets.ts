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
  'bf02e9130d359d30f54714b39d1ad2e0e90a2101897542384109e0b18ef1ad07';
