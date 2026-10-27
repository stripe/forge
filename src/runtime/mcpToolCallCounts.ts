export const MCP_TOOL_CALL_COUNT_LIMITS = Object.freeze({
  nameCharacters: 128,
  distinctNames: 64,
});

export interface McpToolCallCounts {
  readonly tools: Readonly<Record<string, number>>;
  readonly other: number;
  readonly unparsed: number;
  readonly overflow: number;
}

type McpToolCallObservation =
  | { readonly kind: 'tool'; readonly name: string; readonly count: number }
  | {
      readonly kind: 'other' | 'unparsed' | 'overflow';
      readonly count: number;
    };

export const EMPTY_MCP_TOOL_CALL_COUNTS: McpToolCallCounts = Object.freeze({
  tools: Object.freeze({}),
  other: 0,
  unparsed: 0,
  overflow: 0,
});

/** Consumes only the relay's already-bounded request bytes. */
export function* mcpToolCallNames(
  body: Uint8Array,
  redactionSecrets: readonly string[] = [],
): Generator<McpToolCallObservation> {
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
    );
  } catch {
    yield { kind: 'unparsed', count: 1 };
    return;
  }
  const messages: readonly unknown[] = Array.isArray(document)
    ? document
    : [document];
  if (messages.length === 0) yield { kind: 'unparsed', count: 1 };
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message)
    ) {
      yield { kind: 'unparsed', count: 1 };
      continue;
    }
    const { method, params } = message as Record<string, unknown>;
    if (typeof method !== 'string') {
      yield { kind: 'unparsed', count: 1 };
      continue;
    }
    if (method !== 'tools/call') continue;
    const name =
      params !== null && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>).name
        : undefined;
    if (
      typeof name !== 'string' ||
      name.length > MCP_TOOL_CALL_COUNT_LIMITS.nameCharacters ||
      !/^[A-Za-z0-9_.-]+$/.test(name) ||
      redactionSecrets.some(
        (secret) => secret.length > 0 && name.includes(secret),
      )
    )
      yield { kind: 'other', count: 1 };
    else yield { kind: 'tool', name, count: 1 };
  }
}

export function countMcpToolCalls(
  observations: Iterable<McpToolCallObservation>,
  previous: McpToolCallCounts = EMPTY_MCP_TOOL_CALL_COUNTS,
): McpToolCallCounts {
  const tools = new Map(Object.entries(previous.tools));
  let { other, unparsed, overflow } = previous;
  for (const observation of observations) {
    if (observation.kind === 'tool') {
      if (
        tools.has(observation.name) ||
        tools.size < MCP_TOOL_CALL_COUNT_LIMITS.distinctNames
      )
        tools.set(
          observation.name,
          (tools.get(observation.name) ?? 0) + observation.count,
        );
      else overflow += observation.count;
    } else if (observation.kind === 'other') other += observation.count;
    else if (observation.kind === 'unparsed') unparsed += observation.count;
    else overflow += observation.count;
  }
  return Object.freeze({
    tools: Object.freeze(Object.fromEntries(tools)),
    other,
    unparsed,
    overflow,
  });
}

export function mergeMcpToolCallCounts(
  counts: readonly McpToolCallCounts[],
): McpToolCallCounts {
  function* observations(): Generator<McpToolCallObservation> {
    for (const entry of counts) {
      for (const [name, count] of Object.entries(entry.tools))
        yield { kind: 'tool', name, count };
      for (const kind of ['other', 'unparsed', 'overflow'] as const)
        yield { kind, count: entry[kind] };
    }
  }
  return countMcpToolCalls(observations());
}
