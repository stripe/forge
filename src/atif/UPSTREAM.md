# ATIF upstream provenance

This directory implements the Agent Trajectory Interchange Format (ATIF)
v1.8 from Harbor's active RFC and reference Pydantic models.

- Repository: <https://github.com/harbor-framework/harbor>
- Release: `v0.23.0`
- Commit: `1e5c5c6db929a10a140d05e606882c671ae20729`
- RFC: `rfcs/0001-trajectory-format.md`
- RFC SHA-256: `ab2dd5602187ac8271adba13bb9c89dd70961878faa1ab26324d98116bf37b34`
- Reference models: `src/harbor/models/trajectories/`
- Upstream license: Apache License 2.0

The TypeScript types and validator are a Forge implementation of that pinned
specification; Harbor does not publish an official TypeScript package or a
standalone JSON Schema. Do not update these files from Harbor `main`. Review a
specific release commit, its RFC changes, model validators, and conformance
fixtures together, then update the schema version and provenance explicitly.

Forge intentionally differs from Harbor's version-selection behavior in two
places:

1. Serialized input must contain `schema_version`; Harbor's Pydantic
   constructor supplies a default even though the RFC marks it required.
2. Forge validates one exact schema version. Harbor's current reference model
   accepts older discriminators with one superset model and does not gate newer
   fields by the declared version.

Forge accepts and preserves explicit JSON `null` where the pinned contract
treats null and omission equivalently. Conditional multimodal fields still
follow the RFC's stricter omit-when-inapplicable rule. Forge also enforces
normative RFC cross-field rules which the reference Pydantic models do not
always enforce, including embedded-reference resolution and documented
`total_steps` discrepancies. Timestamps use the RFC's extended calendar-date
examples and are checked for real calendar dates, clock values, and UTC-offset
components rather than relying on JavaScript's normalizing `Date.parse()`
behavior.
