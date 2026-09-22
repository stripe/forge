/** Multi-architecture Node 24.13.0 bookworm-slim OCI index. */
export const FORGE_BASE_IMAGE =
  'docker.io/library/node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f';

/** Exact direct dependency installed in the Forge v1 runtime image. */
export const FORGE_CLAUDE_CODE_VERSION = '2.1.273';

/** Exact direct dependency installed in the Forge v1 runtime image. */
export const FORGE_CODEX_VERSION = '0.149.0';

/** Hash of Dockerfile, a NUL separator, and entrypoint.sh. */
export const FORGE_RUNTIME_ASSET_DIGEST =
  '6a087813223515e7e491e78aef72f74f434411b50b0e536cec4c387d36268233';
