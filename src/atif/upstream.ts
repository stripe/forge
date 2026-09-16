/** Immutable provenance for the ATIF schema implemented by this module. */
export const ATIF_UPSTREAM_SOURCE = Object.freeze({
  project: 'Harbor',
  repository: 'https://github.com/harbor-framework/harbor',
  release: 'v0.23.0',
  commit: '1e5c5c6db929a10a140d05e606882c671ae20729',
  rfcPath: 'rfcs/0001-trajectory-format.md',
  rfcSha256:
    'ab2dd5602187ac8271adba13bb9c89dd70961878faa1ab26324d98116bf37b34',
  referenceModelPath: 'src/harbor/models/trajectories',
  license: 'Apache-2.0',
} as const);
