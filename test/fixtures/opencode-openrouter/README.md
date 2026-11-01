# Provisional OpenRouter citation fixtures

`response.json` uses the `message.annotations[].url_citation` shape from
[OpenRouter's web search documentation](https://openrouter.ai/docs/guides/features/plugins/web-search),
retrieved on 2026-10-28. Its assistant text also contains a Markdown citation,
as requested by OpenRouter's documented default search prompt.

`stream.jsonl` and `export.json` are **source-derived predictions**, not captures
from a real OpenCode or OpenRouter run. They follow OpenCode 1.19.0's part
schemas and the compatible SDK 2.0.41's text-only projection: that SDK drops
`annotations`, so only the URL in assistant text survives. They contain no
local search tool call. Replace or confirm them with the pending devbox probe
and a real OpenRouter response. Annotation-only citations are unavailable to
Forge through this route.
