# OpenCode archived fixture selection

These six exports come from the November 2026 canonical full matrix. Selection
was restricted to manifest entries with harness `opencode` and role `canonical`.
All 1,547 retained `result.json` files report
`runtime.metadata.opencodeVersion: "1.19.0"`, the version Forge pins. Of those
runs, 1,546 retain `native/opencode/session.json`; one has no native export.
Each selected export also reports `info.version: "1.19.0"`.

## Selected captures

Message indexes below are zero-based indexes in the original export. Run IDs
identify archive records, not accounts, users, or native sessions.

| Fixture | Eval run ID | Original messages | Why selected |
| --- | --- | --- | --- |
| `plain-answer.json` | `385ffe29-95ec-438d-928c-39374fa2cb65` | 0–1 | A tool-free answer with one start, text, and stop. |
| `tool-call.json` | `1b64af58-6b52-4e9e-87dd-c2418eaa5210` | 0–2 | A completed `read` call followed by a separate final answer. |
| `tool-error.json` | `c21e52f0-386a-45ad-9c2b-6d44e1f59c2f` | 0–3 | A completed `glob` call, failed `webfetch`, and final answer; preserves the error state without turning it into a session failure. |
| `resumed-retry.json` | `78963541-77c2-4d0c-a85b-7fa4fc5121da` | 0–7 | Four user/assistant turns in one session. Message 5 has two distinct start parts and one finish, consistent with a recovered retry, followed by another completed turn. |
| `reused-call-id.json` | `e13ec254-986f-48d6-a274-acba59f32637` | 6, 8–12 | Two user turns with different tool parts sharing a gateway call ID. Preserves three tool executions, including the reused ID, and both final answers. |
| `compaction.json` | `941093cf-5fa6-4d2e-8b2a-10e85f574d0a` | 7, 9–13 | A reply, automatic compaction request, marked summary, synthetic continuation, and final reply. Preserves `auto`, `overflow`, `tail_start_id`, `summary`, and `compaction_continue`. |

The first four captures belong to experiment run
`2ca8bdab-822f-4255-a7fc-c098eefc340c`; the reused-ID capture belongs to
`5fa2854c-f958-4ad9-99f9-4b0a8701f50d`; the compaction capture belongs to
`f04e05a2-5dcd-4af1-b319-8ddb6af36a1e`. The source exports range from 7.7 KB
to 539 KB; these fixtures range from 1.1 KB to 4.7 KB.

## Minimization and sanitization

The JSON files are projections of stored exports, not outputs of the
hand-authored fixture builder. The first four keep every message and part.
The last two omit unrelated earlier turns and tool steps to keep the captures
small. Within retained messages, part order, parent relationships, duplicate
call-ID equality, status, finish reasons, timestamps, cost, and token counters
are preserved. Native session, message, part, and call IDs are renamed
consistently. The model name becomes `fixture-model`; the public provider
marker `forge` and tool names are retained.

Prompts, replies, reasoning, summaries, tool output, tool errors, titles, and
every string in tool inputs are replaced with short neutral text. Input object
keys and value types are retained. Session titles, project metadata, paths,
permissions, user workspace diffs, assistant paths, and tool metadata are
removed. No keys, account or user identifiers, hosts, endpoint URLs, workspace
paths, or original prompt text are retained.

## Stream replay and coverage gaps

The retained run directories contain native session exports, not raw
`opencode run --format json` stdout. The tests load these files directly for
native evidence. For stream parsing, they wrap stored assistant parts and
synthetic continuation text in JSON event envelopes: `step-start` maps to
`step_start`, `step-finish` to `step_finish`, and `tool` to `tool_use`.
Ordinary user prompts and compaction request parts are not emitted as events.
Each ordinary user message starts a separate resumed invocation. No missing
start, finish, or tool parts are synthesized.

This replay checks real stored part shapes and export order. It does not prove
CLI emission order, event timestamps, retries that leave no stored parts, or
cleanup timing. The two start snapshots establish the stored retry shape;
they do not retain the provider failure that caused it.

The full export scan found 630 runs with tool errors, four with compaction,
and four with gateway IDs reused across turns. No call ID contained `:`, no
stored tool part followed a finish part in its message, and no stored tool
error contained an interruption marker. These observations do not establish
that the live CLI never emits those shapes.

- [stripe/forge#32](https://github.com/stripe/forge/pull/32) H3.3 is reproduced
  by `reused-call-id.json`: the evidence loader rejects session-wide ID reuse.
  Its intended-success test uses `it.fails`; the separate resumed stream
  replays succeed because each invocation has unique call IDs. The other
  worker owns the parser fix and the ATIF-facing ID policy.
- H3.1 (cleanup after finish) and H3.2 (`:` in call IDs) have no corresponding
  capture here. They need original stdout or another real capture. They are
  not simulated and labeled as archived data.
- Compacted native evidence remains intentionally incomplete. The test checks
  explicit driver fallback, exclusion of summary text from the reply, and
  retention of the sanitized native bytes; it is not an expected failure.

No new model calls or Docker captures were made. Public runtime behavior and
schemas are unchanged, so README and architecture documentation need no edit.
